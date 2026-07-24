import type { TeeSet } from "../course/card.js";
import { isRated } from "../course/card.js";
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
export const scoreDifferential = (teeSet: TeeSet, ags: number): number => {
  if (!isRated(teeSet)) throw new DomainError("tee-unrated", `tee "${teeSet.name}" has no rating/slope — no differential to post`);
  return (113 / teeSet.slope) * (ags - teeSet.rating);
};

// A posted Score Differential is a one-decimal value — a golfer's record reads 23.6, not the raw
// full-precision figure the index averages internally (scoreDifferential stays unrounded on purpose;
// see its comment). Round only where the differential is SHOWN, never before it feeds the index.
export const postedDifferential = (differential: number): number => roundHalfUp(differential * 10) / 10;

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

// differentialsUsed is Rule 5.2a's `use` column — how many of the window's differentials
// were actually AVERAGED, not how many were in the window (e.g. a 3-differential window
// uses only the lowest 1). computeIndex (below) is by far the more common caller need — a
// bare number — so this stays a private detail type with computeIndex as a thin projection
// of it, rather than changing computeIndex's own return shape and rippling every existing
// call site (including this file's own published-example pins). Callers that need the count
// too (application's index projector, projectArchive.ts) use computeIndexDetail directly —
// the ONE table (smallSampleTable, above) is never re-derived outside domain.
export interface IndexComputation {
  readonly value: number;
  readonly differentialsUsed: number;
}

export const computeIndexDetail = (differentials: readonly number[]): IndexComputation | undefined => {
  // Input order is oldest → newest, so "the most recent 20" = the LAST 20.
  const window = differentials.slice(-20);
  if (window.length < 3) return undefined;
  const { use, adjustment } = smallSampleTable.find((row) => window.length <= row.maxCount)!;
  const best = [...window].sort((a, b) => a - b).slice(0, use);
  const average = best.reduce((sum, differential) => sum + differential, 0) / use;
  // Tenth-rounding via roundHalfUp matches both published edges: .05 rounds up
  // (Rule 5.1a "with .5 rounded upwards") and minus values round toward zero at
  // .5 (Rule 5.1c: −1.55 → −1.5), because floor(x + 0.5) is direction-uniform.
  const value = roundHalfUp((average + adjustment) * 10) / 10;
  return { value, differentialsUsed: use };
};

export const computeIndex = (differentials: readonly number[]): number | undefined => computeIndexDetail(differentials)?.value;

// The SWNG index (handicap-model legibility spec §2, §9): computeIndexDetail over the WHS
// fold EXTENDED to unrated rounds — a rated line contributes its real `differential` (the same
// number the WHS index itself uses), and only an unrated line (no rating, so no differential is
// possible) falls back to the difficulty-neutral pseudo-differential (ags − par, i.e.
// scoreDifferential at slope 113 / rating = par). EVERY round with an AGS contributes, rated or
// unrated — so a golfer who plays only rated golf gets a swng index that equals their WHS index
// exactly; the two diverge only by unrated play. Reuses the pinned small-sample table and the
// 2020 nine-hole pairing verbatim; read-time only, never stored. This IS the `swng` source's
// number in resolveIndex (golfer/metrics.ts) — the index a golfer plays off when their chosen
// source is swng (the default), unless they've adopted the WHS source or asserted their own.
export const swngIndex = (
  lines: readonly { readonly ags?: number; readonly differential?: number; readonly par: number; readonly holes: 9 | 18 }[],
): IndexComputation | undefined => {
  const entries = lines
    .filter((line): line is typeof line & { ags: number } => line.ags !== undefined)
    .map((line) => ({ differential: line.differential ?? line.ags - line.par, holes: line.holes }));
  return computeIndexDetail(combineNineHoleDifferentials(entries));
};

// Rule 6.1a over already-known numbers — the peek carries `par` but not `holes`, so a caller
// with rating/slope/par (the web's JoinRoundPage) computes a course handicap without a full
// TeeSet. courseHandicapFor delegates to this so the Rule 6.1a formula lives in exactly ONE place.
export const courseHandicapFromRatingSlopePar = (index: number, rating: number, slope: number, par: number): number =>
  roundHalfUp(index * (slope / 113) + (rating - par));

// Rule 6.1a: Course Handicap = Handicap Index × (Slope Rating ÷ 113) +
// (Course Rating − par), rounded to the nearest whole number as the final step.
export const courseHandicapFor = (index: number, teeSet: TeeSet): number => {
  if (!isRated(teeSet)) throw new DomainError("tee-unrated", `tee "${teeSet.name}" is unrated — use round(index) for a course-handicap estimate`);
  const par = teeSet.holes.reduce((sum, hole) => sum + hole.par, 0);
  return courseHandicapFromRatingSlopePar(index, teeSet.rating, teeSet.slope, par);
};

// The unrated estimate (handicap-model legibility spec §4): no rating/slope means no Rule 6.1a
// formula to convert index → course handicap, so the index itself stands in for the estimate —
// halved for a 9-hole card (round(index/2)), used as-is for 18 (round(index)). This is a
// UI-facing estimate, not a WHS Rule, so it uses plain Math.round (its exact half-rounding —
// Math.round(2.5)===3, Math.round(-2.5)===-2 — is preserved deliberately, not "improved" to
// roundHalfUp) rather than the Rules' own roundHalfUp used elsewhere in this file.
export const unratedCourseHandicap = (index: number, holeCount: number): number => (holeCount === 9 ? Math.round(index / 2) : Math.round(index));

// The 9-hole pairing state (rule text below): `combined` is the running list of 18-hole-
// equivalent differentials in chronological order; `pendingNine` is at most one unpaired 9,
// carried forward across however many rounds until its partner posts. Mutable and exported so a
// STREAMING caller (golfer/metrics.ts's per-round "index over time" forward pass — an O(N²)→O(N)
// perf fix) can feed one entry at a time in O(1) amortized time and read `.combined` after each
// feed, instead of re-folding the whole prefix from scratch per round.
export interface NineHoleCombineState {
  readonly combined: number[];
  pendingNine?: number;
}

export const createNineHoleCombineState = (): NineHoleCombineState => ({ combined: [] });

// One step of the pairing rule, mutating `state` in place — the ONE place the rule is written.
// combineNineHoleDifferentials (below) is a from-scratch fold over this; a streaming caller gets
// the SAME rule, provably, by calling this directly instead of re-deriving it. Rule text: an 18
// always stands alone; two 9s pair in the order they were posted (oldest waits for its partner)
// and sum into ONE 18-hole-equivalent differential; an unpaired 9 contributes nothing until a
// later round supplies its partner — see combineNineHoleDifferentials's own comment for the source.
export const feedNineHoleCombine = (state: NineHoleCombineState, entry: { readonly differential: number; readonly holes: 9 | 18 }): void => {
  if (entry.holes === 18) {
    state.combined.push(entry.differential);
    return;
  }
  if (state.pendingNine === undefined) {
    state.pendingNine = entry.differential;
    return;
  }
  state.combined.push(state.pendingNine + entry.differential);
  state.pendingNine = undefined;
};

// 2020 published 9-hole combining rule (see the file-level comment: the 2024
// expected-differential ingestion has no published formula, so swng combines raw
// 9-hole differentials at the index projection instead of ingesting them directly).
// Oldest-first input, chronological output: an 18 always stands alone; two 9s pair
// in the order they were posted (oldest waits for its partner) and sum into ONE
// 18-hole-equivalent differential, landing at the position where the pair completed
// — so a shuffle of unrelated 18s between a 9 and its eventual partner doesn't move
// where the combined value lands. A 9 left without a partner (record ends mid-pair)
// contributes nothing; it stays pending until a later round supplies its partner.
export const combineNineHoleDifferentials = (entries: readonly { readonly differential: number; readonly holes: 9 | 18 }[]): readonly number[] => {
  const state = createNineHoleCombineState();
  for (const entry of entries) feedNineHoleCombine(state, entry);
  return state.combined;
};
