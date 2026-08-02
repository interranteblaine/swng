import type { Hole, TeeSet } from "../course/card.js";

// Which holes a round SET OUT to play (spec 2026-08-02 §3). A plan, not an outcome: stroke
// allocation depends on the hole set, so the set has to be fixed before the first score or the
// dots shift under the players while they enter them. What actually got scored is the golfer's
// own decided cells, already derived — nothing here stores it.
export type HoleSelection = "all" | "front" | "back";

const NINE = 9;

// TOTAL, deliberately (spec §3): a card with one nine has one answer, so every selection resolves
// to that nine rather than throwing or coming back empty. There is no error case to design,
// because "we played nine holes at a nine-hole course" is a true statement. The only guard in the
// system lives at startRound's door (Task 6), where the card is already in hand — never here, on a
// read path, where it would make a stored round permanently unreadable (Arc A placement rule).
export const intendedHoles = (teeSet: TeeSet, selection: HoleSelection): readonly Hole[] => {
  if (selection === "all" || teeSet.holes.length <= NINE) return teeSet.holes;
  return selection === "front" ? teeSet.holes.slice(0, NINE) : teeSet.holes.slice(NINE);
};

// "Does this card have a choice to make?" (whole-branch review Finding 4, spec 2026-08-02 §3c) —
// the ONE spelling of that predicate, replacing three independent ones (`holes.length <= 9` in
// startRound's guard, `=== 18` in the web's two pickers). A 9-hole tee set has one nine and
// nothing to split ("no choice to make, so none is offered" — §3c's own words); an 18-hole tee
// set can be played front, back, or all. `>` rather than `!== NINE` reads as the actual question
// ("is there more than a nine here"), though validateTeeSet's own invariant (hole count is always
// exactly 9 or 18, never anything else) makes every phrasing of this predicate agree in practice.
// A pure structural accessor, not a golf computation — not on the compute-fence banlist, reached
// directly from apps/web/src the same way `findTeeSet` is.
export const hasHoleChoice = (teeSet: TeeSet): boolean => teeSet.holes.length > NINE;
