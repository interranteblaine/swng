import type { GolferId, Participant } from "@swng/domain";
import { findTeeSet, golferId } from "@swng/domain";
import type { JoinRoundRequest, JoinRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { resolveSuppliedGolfer } from "./golferIdentity.js";
import { loadRoundState } from "./loadRoundState.js";
import { writePresence } from "./presence.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

export const joinRound =
  (deps: {
    journal: EventJournal;
    store: RoundStore;
    broadcast: Broadcast;
    tokens: TokenIssuer;
    clock: Clock;
    ids: IdGenerator;
    golferStore: GolferStore;
    crewStore: CrewStore;
    projectionStore: ProjectionStore;
    logger: Logger;
  }) =>
  // claims is optional: JoinRound's route has never required an account (a join code is
  // enough — M3's whole point). It's threaded through so a SIGNED-IN caller supplying an
  // already-claimed golferId can still pass the shared resolver's as-self arm
  // (golferIdentity.ts); an anonymous join behaves exactly as before this parameter existed.
  async (command: JoinRoundRequest, claims?: AccountClaims): Promise<JoinRoundResponse> => {
    const id = await deps.store.findByJoinCode(command.code);
    if (!id) throw new ApplicationError("bad-join-code");

    const { state } = await loadRoundState(deps.journal, id);
    if (state.status === "final") throw new ApplicationError("round-final");
    findTeeSet(state.card, command.tee); // unknown-tee-set (DomainError) propagates

    // Task 5b (ghost continuity) / M8 (the shared resolver): a supplied golferId reuses the
    // SAME claimed-golferId rule as startRound/addParticipant (golferIdentity.ts). When
    // absent, behavior is byte-identical to before either task: mint a fresh id.
    let golfer: GolferId;
    if (command.golferId !== undefined) {
      // CHECK-THEN-ACT RACE (the golferStore read inside the resolver vs. the journal append
      // below): a claim can land between that read and the append, making the supplied
      // golferId claimed moments after we green-lit it. Accepted for beta: the window is
      // narrow, exploiting it requires knowing the golferId mid-claim, and it grants nothing
      // beyond what an unclaimed ghost's participant token already carries (M4: ghost tokens
      // have no auth). M8/M9 identity hardening revisits this. Deliberate, not an oversight.
      golfer = await resolveSuppliedGolfer({ golferStore: deps.golferStore, crewStore: deps.crewStore })(command.golferId, {
        sub: claims?.sub,
      });
      // UX guard: a duplicate participant-joined is harmless at the domain layer (last-write-wins
      // on golferId), but we reject it here to prevent surprising joiners with silent changes.
      if (state.participants.some((participant) => participant.golferId === command.golferId)) {
        throw new ApplicationError("golfer-already-in-round", `golfer ${command.golferId} is already a participant in this round`);
      }
    } else {
      golfer = golferId(deps.ids.newId());
    }

    const participant: Participant = { golferId: golfer, name: command.name, tee: command.tee, courseHandicap: command.courseHandicap };

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(id, [{ kind: "participant-joined", participant, ...serverEnvelope({ hlc, ids: deps.ids }, golfer) }]);
    await deps.broadcast.publish(id, result.appended);

    // Presence (spec §5, Task 13): the joiner's own LIVE pointer, written only after the join
    // has actually committed above — best-effort, never undoes the join (presence.ts).
    await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, golfer, id, state.card.courseName);

    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: golfer });

    return { roundId: id, token, golferId: golfer };
  };
