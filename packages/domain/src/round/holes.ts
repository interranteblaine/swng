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
