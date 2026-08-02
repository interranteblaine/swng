import type { SetHolesRequest, SetHolesResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// The holes a round set out to play, corrected (spec 2026-08-02 §3b): going out for nine and
// playing on is the normal case, not the error case, and the alternative is scrapping a live round
// and re-entering it. A round-level fact, so unlike setStrokes there is no SUBJECT — the body
// carries only the new value and requireParticipant runs once, against the caller. Nothing scored
// is lost by a change: cells are keyed by hole number and the hole set is a filter over them.
//
// No card check here, deliberately: the only selection this could get wrong is a nine against a
// one-nine card, which intendedHoles resolves sensibly anyway, and re-resolving the course record
// mid-round to re-check it would buy nothing. startRound owns that guard.
export const setHoles =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, request: SetHolesRequest): Promise<SetHolesResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "round-holes-set", holes: request.holes, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
