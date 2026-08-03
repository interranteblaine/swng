import type { SetHolesRequest, SetHolesResponse } from "@swng/contracts";
import { hasHoleChoice } from "@swng/domain";
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
// Guarded the same way startRound's door is (spec correction, dated 2026-08-03, §3): the real
// invariant was never "exactly one guard" — it is "no guard on a READ or FOLD path", because that
// would make a stored round permanently unreadable (Arc A's placement rule). A second WRITE-door
// guard is consistent with that and always was; `intendedHoles` stays total either way. This is
// still cheap to check: `loadRoundState` above already returns the folded state, so
// `state.card.teeSets[0]` is IN HAND, no course-record resolution involved — the same reasoning
// startRound's own door uses reading the host's tee alone (every tee on a card shares the same
// hole count, validateCard's own invariant). This closes a real gap the previous, unguarded
// version of this file left open on purpose: an API caller (not reachable through the UI —
// SetupPanel renders no Holes section at all on a one-nine card) could set "back" on a one-nine
// course, after which the join screen rendered "This round plays the Back 9." for a course that
// only has one nine.
export const setHoles =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, request: SetHolesRequest): Promise<SetHolesResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const teeSet = state.card.teeSets[0];
    if (request.holes !== "all" && teeSet && !hasHoleChoice(teeSet)) {
      throw new ApplicationError("holes-not-on-this-card", `this course has one nine; "${request.holes}" names a second`);
    }

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "round-holes-set", holes: request.holes, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
