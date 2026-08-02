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
// No card check here, deliberately — and NOT because the card is hard to reach: `loadRoundState`
// above already returns the folded state, so `state.card.teeSets[0].holes.length` is IN HAND, no
// course-record resolution involved. The real reason is the spec's own rule: exactly ONE guard
// exists, at the one door where a round is created (startRound); every other path, this one
// included, leaves `intendedHoles` to resolve whatever selection it's handed, which it does
// harmlessly on a one-nine card (there's nothing to split, so it falls back to the whole card).
// The one honest residual: an API caller (not reachable through the UI — SetupPanel renders no
// Holes section at all on a one-nine card) can set "back" on a one-nine course, after which the
// join screen renders "This round plays the Back 9." on a course that only has one nine. Left
// unguarded on purpose — a guard here would contradict the spec's one-guard rule for a cosmetic
// label, not a data-integrity issue.
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
