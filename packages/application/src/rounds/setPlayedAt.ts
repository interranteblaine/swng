import type { SetPlayedAtRequest, SetPlayedAtResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// A round's played date, corrected (spec 2026-08-01 §3b/§4): a golfer entering Friday's paper
// card on Sunday types Friday's date at start, and any participant may fix it afterward — a
// round-level fact, so unlike setStrokes there is no SUBJECT: the body carries only the new
// value, and requireParticipant runs once, against the caller, not twice. Shaped exactly like
// setStrokes/leaveRound otherwise: a connected, online round act, server-envelope-stamped,
// gated by the same round-not-live check every other participant append opens with. The fold
// rule (domain's playedAtMsOf) is latest-round-played-at-set-by-hlc, else the genesis event's
// own playedAtMs — this use case never re-derives that, it just appends the correction.
export const setPlayedAt =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, request: SetPlayedAtRequest): Promise<SetPlayedAtResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "round-played-at-set", playedAtMs: request.playedAtMs, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
