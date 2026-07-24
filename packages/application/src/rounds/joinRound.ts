import type { GolferId, Participant } from "@swng/domain";
import { findTeeSet } from "@swng/domain";
import type { JoinRoundRequest, JoinRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { Metrics } from "../ports/metrics.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { ensureGolfer } from "../golfers/ensureGolfer.js";
import { loadRoundState } from "./loadRoundState.js";
import { writePresence } from "./presence.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Accounts-only identity (spec §3): JoinRound is ALWAYS as-self. The joiner's golfer is resolved
// from the caller's Bearer through the ONE shared get-or-create (ensureGolfer) — a signed-in
// account with no golfer yet gets one minted right here. Nobody joins on anyone else's behalf,
// and there is no supplied golferId. The participant NAME frozen into the event is the golfer
// record's name at join time (sealed leaf — a later profile rename never rewrites this card).
export const joinRound =
  (deps: {
    journal: EventJournal;
    store: RoundStore;
    broadcast: Broadcast;
    tokens: TokenIssuer;
    clock: Clock;
    ids: IdGenerator;
    golferStore: GolferStore;
    projectionStore: ProjectionStore;
    logger: Logger;
    metrics?: Metrics;
  }) =>
  // claims is REQUIRED: POST /rounds/join is the "golfer" auth tier now (accounts-only identity
  // spec §3) — there is no anonymous join. The dispatcher guarantees a verified AccountClaims.
  async (command: JoinRoundRequest, claims: AccountClaims): Promise<JoinRoundResponse> => {
    const id = await deps.store.findByJoinCode(command.code);
    if (!id) throw new ApplicationError("bad-join-code");

    const { state } = await loadRoundState(deps.journal, id);
    if (state.status === "final") throw new ApplicationError("round-final");
    findTeeSet(state.card, command.tee); // unknown-tee-set (DomainError) propagates

    // As-self, the ONLY identity path: get-or-create the caller's account golfer. The seat's
    // golferId and its frozen participant name both come straight from that record.
    const golferRecord = await ensureGolfer({ golferStore: deps.golferStore, idGenerator: deps.ids, metrics: deps.metrics })(claims);
    const golfer: GolferId = golferRecord.id;

    // UX guard: re-tapping join while STILL SEATED is a surprising no-op (the fold's
    // last-write-wins on golferId would silently rewrite the caller's own seat), so it's rejected
    // here. A DEPARTED golfer is NOT blocked — rejoining after leaving is just joining again
    // (spec §4), and the fold clears `departed` on the new participant-joined.
    if (state.participants.some((participant) => participant.golferId === golfer && participant.departed !== true)) {
      throw new ApplicationError("golfer-already-in-round", `golfer ${golfer} is already a participant in this round`);
    }

    const participant: Participant = { golferId: golfer, name: golferRecord.name, tee: command.tee, courseHandicap: command.courseHandicap };

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(id, [{ kind: "participant-joined", participant, ...serverEnvelope({ hlc, ids: deps.ids }, golfer) }]);
    await deps.broadcast.publish(id, result.appended);

    // Presence (spec §5, Task 13): the joiner's own LIVE pointer, written only after the join
    // has actually committed above — best-effort, never undoes the join (presence.ts).
    await writePresence({ projectionStore: deps.projectionStore, logger: deps.logger, clock: deps.clock }, golfer, id, state.card.courseName);

    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: golfer });

    // Echo, not a second read: findByJoinCode(command.code) just matched, so command.code IS
    // the canonical stored code (spec 2026-07-20 §2).
    return { roundId: id, token, golferId: golfer, joinCode: command.code };
  };
