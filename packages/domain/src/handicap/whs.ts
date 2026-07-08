import type { TeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { HoleResult } from "../round/holeResult.js";
import { dotsByHole, netDoubleBogey, roundHalfUp } from "../scoring/strokes.js";

// WHS handicap engine. Every constant here is pinned to the published Rules of
// Handicapping (Effective January 2024) — the conformance tests in whs.test.ts
// cite the exact rules, pages, and worked examples. The 2024 9-hole
// expected-differential ingestion is deliberately absent: the USGA/R&A publish
// no formula for it (a "closed calculation"), so swng combines raw 9-hole
// differentials per the published 2020 rule at the index projection instead.

// Rule 3.1b: for handicap purposes each hole is capped at net double bogey,
// computed from the player's FULL course handicap — the rule text is explicit
// that game allowances never apply to this adjustment. A picked-up or conceded
// hole means the player never holed out, so it counts AT the cap (the "score to
// record when the player does not hole out" resolution for handicap posting).
export const adjustedGrossScore = (teeSet: TeeSet, courseHandicap: number, holes: ReadonlyMap<number, HoleResult>): number => {
  const dots = dotsByHole(courseHandicap, teeSet);
  let total = 0;
  for (const hole of teeSet.holes) {
    const result = holes.get(hole.number);
    // An AGS over a partial card would silently understate the round — posting is
    // only meaningful once every hole has resolved to a score, pickup, or concession.
    if (!result) throw new DomainError("holes-undecided", `hole ${hole.number} has no result`);
    const cap = netDoubleBogey(hole.par, dots.get(hole.number) ?? 0);
    total += result.kind === "strokes" ? Math.min(result.strokes, cap) : cap;
  }
  return total;
};

// Rule 5.1a, minus the PCC term — swng records no playing-conditions adjustment,
// which is identically PCC = 0 in the published formula. Unrounded: rounding to
// the tenth is the caller's posting step, and premature rounding would compound
// through the index.
export const scoreDifferential = (teeSet: TeeSet, ags: number): number => (113 / teeSet.slope) * (ags - teeSet.rating);

// Rule 5.2a's small-sample table, verbatim (row = "records of up to maxCount
// scores use the lowest `use`, then add `adjustment`"). The negative adjustments
// exist because a 3–6 score sample overrepresents best play; from 7 up the table
// is pure best-subset averaging, converging on best-8-of-20.
const smallSampleTable: ReadonlyArray<{ readonly maxCount: number; readonly use: number; readonly adjustment: number }> = [
  { maxCount: 3, use: 1, adjustment: -2.0 },
  { maxCount: 4, use: 1, adjustment: -1.0 },
  { maxCount: 5, use: 1, adjustment: 0 },
  { maxCount: 6, use: 2, adjustment: -1.0 },
  { maxCount: 8, use: 2, adjustment: 0 },
  { maxCount: 11, use: 3, adjustment: 0 },
  { maxCount: 14, use: 4, adjustment: 0 },
  { maxCount: 16, use: 5, adjustment: 0 },
  { maxCount: 18, use: 6, adjustment: 0 },
  { maxCount: 19, use: 7, adjustment: 0 },
  { maxCount: 20, use: 8, adjustment: 0 },
];

export const computeIndex = (differentials: readonly number[]): number | undefined => {
  // Input order is oldest → newest, so "the most recent 20" = the LAST 20.
  const window = differentials.slice(-20);
  if (window.length < 3) return undefined;
  const { use, adjustment } = smallSampleTable.find((row) => window.length <= row.maxCount)!;
  const best = [...window].sort((a, b) => a - b).slice(0, use);
  const average = best.reduce((sum, differential) => sum + differential, 0) / use;
  // Tenth-rounding via roundHalfUp matches both published edges: .05 rounds up
  // (Rule 5.1a "with .5 rounded upwards") and minus values round toward zero at
  // .5 (Rule 5.1c: −1.55 → −1.5), because floor(x + 0.5) is direction-uniform.
  return roundHalfUp((average + adjustment) * 10) / 10;
};

// Rule 6.1a: Course Handicap = Handicap Index × (Slope Rating ÷ 113) +
// (Course Rating − par), rounded to the nearest whole number as the final step.
export const courseHandicapFor = (index: number, teeSet: TeeSet): number => {
  const par = teeSet.holes.reduce((sum, hole) => sum + hole.par, 0);
  return roundHalfUp(index * (teeSet.slope / 113) + (teeSet.rating - par));
};
