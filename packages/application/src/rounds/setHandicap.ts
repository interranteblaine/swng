import type { SetHandicapRequest, SetHandicapResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Mid-round course handicap correction (spec 2026-07-20). Any participant corrects any
// participant — the score-for-anyone trust model, so the SUBJECT rides the body while the
// author is the token's own golferId (the same split score-recorded uses). requireParticipant
// on BOTH: isParticipant is seat-based, so a DEPARTED subject still passes — deliberately: a
// player who left after 12 holes still counts in every game, and their mis-struck holes
// deserve the fix. The correction is retroactive by construction (the fold + every compute
// read live CH); shaped exactly like leaveRound — a connected, online round act,
// server-envelope-stamped, gated by round-not-live like every other participant append.
export const setHandicap =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, request: SetHandicapRequest): Promise<SetHandicapResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    requireParticipant(state, request.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "participant-handicap-set", golferId: request.golferId, courseHandicap: request.courseHandicap, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
