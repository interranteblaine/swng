import type { GolferId, Participant } from "@swng/domain";
import { findTeeSet, golferId } from "@swng/domain";
import type { JoinRoundRequest, JoinRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

export const joinRound =
  (deps: { journal: EventJournal; store: RoundStore; broadcast: Broadcast; tokens: TokenIssuer; clock: Clock; ids: IdGenerator; golferStore: GolferStore }) =>
  async (command: JoinRoundRequest): Promise<JoinRoundResponse> => {
    const id = await deps.store.findByJoinCode(command.code);
    if (!id) throw new ApplicationError("bad-join-code");

    const { state } = await loadRoundState(deps.journal, id);
    if (state.status === "final") throw new ApplicationError("round-final");
    findTeeSet(state.card, command.tee); // unknown-tee-set (DomainError) propagates

    // Task 5b (ghost continuity): a supplied golferId is reused as-is IFF unclaimed — absence
    // of a GOLFER row means unclaimed (rows are lazy — a ghost from another round has no row
    // at all), only a row WITH a sub blocks reuse. When absent, behavior is byte-identical to
    // before this task: mint a fresh id.
    let golfer: GolferId;
    if (command.golferId !== undefined) {
      const existing = await deps.golferStore.get(command.golferId);
      // CHECK-THEN-ACT RACE (the golferStore read vs. the journal append below): a claim
      // can land between this read and the journal append below, making
      // the supplied golferId claimed moments after we green-lit it. Accepted for beta: the
      // window is narrow, exploiting it requires knowing the golferId mid-claim, and it
      // grants nothing beyond what an unclaimed ghost's participant token already carries
      // (M4: ghost tokens have no auth). M8/M9 identity hardening revisits this. Deliberate,
      // not an oversight.
      if (existing?.sub !== undefined) throw new ApplicationError("golfer-claimed", `golfer ${command.golferId} is claimed`);
      // UX guard: a duplicate participant-joined is harmless at the domain layer (last-write-wins
      // on golferId), but we reject it here to prevent surprising joiners with silent changes.
      if (state.participants.some((participant) => participant.golferId === command.golferId)) {
        throw new ApplicationError("golfer-already-in-round", `golfer ${command.golferId} is already a participant in this round`);
      }
      golfer = command.golferId;
    } else {
      golfer = golferId(deps.ids.newId());
    }

    const participant: Participant = { golferId: golfer, name: command.name, tee: command.tee, courseHandicap: command.courseHandicap };

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(id, [{ kind: "participant-joined", participant, ...serverEnvelope({ hlc, ids: deps.ids }, golfer) }]);
    await deps.broadcast.publish(id, result.appended);

    const token = deps.tokens.issue({ roundId: id, golferId: golfer });

    return { roundId: id, token, golferId: golfer };
  };
