import type { SetBasisRequest, SetBasisResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Mid-round correction of what a player stated about themselves (spec 2026-07-20, re-shaped by
// 2026-07-29 §2a). Any participant corrects any participant — the score-for-anyone trust model, so
// the SUBJECT rides the body while the author is the token's own golferId (the same split
// score-recorded uses). requireParticipant on BOTH: isParticipant is seat-based, so a DEPARTED
// subject still passes — deliberately: a player who left after 12 holes still counts in every game,
// and their mis-struck holes deserve the fix. The correction is retroactive by construction
// (nothing snapshots strokes — the fold re-derives the whole roster's, so dots and every standing
// move on the next read); shaped exactly like leaveRound — a connected, online round act,
// server-envelope-stamped, gated by round-not-live like every other participant append.
export const setBasis =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, request: SetBasisRequest): Promise<SetBasisResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    requireParticipant(state, request.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "participant-basis-set", golferId: request.golferId, basis: request.basis, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
