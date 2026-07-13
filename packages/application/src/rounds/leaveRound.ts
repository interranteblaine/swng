import type { LeaveRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// A participant walks off (accounts-only identity spec §4). Leaving is SELF-ONLY by construction:
// there is no request body, so the leaver is the token's own golferId — a client can never leave
// on someone else's behalf. Shaped exactly like terminateGame (a connected, online round act, not
// an offline outbox op), server-envelope-stamped the same way, authorized by the same
// requireParticipant + round-not-live pair every other participant append opens with.
//
// No fold-level validation beyond that (spec §4): no "referenced by a game" gate, no
// participant-count check — a live round + a valid participant token is all it takes. The
// commutative fold absorbs everything else (a game-add racing a leave converges to "game exists,
// player departed"). NOT idempotent-deduped the way terminateGame's no-op is: leaving twice appends
// twice — both events fold to the same "departed" presence, so a repeat leave is harmless, and a
// rejoin is just joining again (a later participant-joined clears `departed`). After finalize
// nothing appends for anyone (sealed leaf), which is what round-not-live enforces here.
export const leaveRound =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims): Promise<LeaveRoundResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "participant-left", golferId: claims.golferId, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
