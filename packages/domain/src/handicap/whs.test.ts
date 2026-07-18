import { describe, expect, it } from "vitest";
import type { TeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { HoleResult } from "../round/holeResult.js";
import { fixtureWhite } from "../scoring/golden/fixtureCourse.js";
import { roundHalfUp } from "../scoring/strokes.js";
import {
  adjustedGrossScore,
  combineNineHoleDifferentials,
  computeIndex,
  computeIndexDetail,
  courseHandicapFor,
  courseHandicapFromRatingSlopePar,
  postedDifferential,
  scoreDifferential,
  swngIndex,
  unratedCourseHandicap,
} from "./whs.js";

// Every conformance case below is pinned to a published USGA/R&A source, per the
// task's source-verification step — the cited documents are the spec, not memory.
// Primary text: Rules of Handicapping, Effective January 2024 (official USGA/R&A
// edition; verified against the GolfRSA-hosted mirror of the identical PDF at
// https://www.golfrsa.com/wp-content/uploads/2024/01/WHS_Rules_of_Handicapping_2024.pdf
// and cross-checked byte-identical on the relevant rules against the 2020 edition at
// https://cdn.golfcanada.ca/app/uploads/golfcanada/production/2015/03/15131136/Golf-Canada-WHS-Rules-of-Handicap-%E2%80%93-ENG-Final.pdf).

// The published differential examples supply only rating/slope, never a
// hole-by-hole card — scoreDifferential reads nothing else from the tee set.
const ratedTee = (rating: number, slope: number): TeeSet => ({ name: "rated", rating, slope, holes: [] });

const card = (scores: ReadonlyArray<number | "picked-up" | "conceded">): ReadonlyMap<number, HoleResult> =>
  new Map(scores.map((score, index) => [index + 1, typeof score === "number" ? { kind: "strokes", strokes: score } : { kind: score }]));

// Ann's stableford golden card (stableford.test.ts): course handicap 8 on
// fixtureWhite dots every hole except h3 (SI9).
const annCard: ReadonlyArray<number | "picked-up"> = [5, 6, 3, "picked-up", 5, 4, 5, 6, 5];

describe("scoreDifferential — published worked examples", () => {
  // England Golf, "Guidance on the WHS Rules of Handicapping as applied within
  // GB&I" (2024 update), p.37: Collette (113/136) × (53 − 36.3 − 0.5×(−1)) = 14.3;
  // Colin (113/144) × (52 − 36.2 − 0.5×(−1)) = 12.8.
  // https://static.whsplatform.englandgolf.org/clubs/1000-1/uploads/downloads/whs/2024-update/handicapping-guidance-2024-update.pdf
  // swng carries no PCC input (PCC ≡ 0), so the examples' PCC half-term (+0.5
  // stroke equivalent) is folded into the AGS argument — the arithmetic pinned
  // here is identical to the published calculation.
  it("reproduces England Golf's Collette example: 14.3", () => {
    expect(roundHalfUp(scoreDifferential(ratedTee(36.3, 136), 53 + 0.5) * 10) / 10).toBe(14.3);
  });

  it("reproduces England Golf's Colin example: 12.8", () => {
    expect(roundHalfUp(scoreDifferential(ratedTee(36.2, 144), 52 + 0.5) * 10) / 10).toBe(12.8);
  });

  it("returns the fixture-course differential unrounded: (113/128) × (47 − 35.8)", () => {
    expect(scoreDifferential(fixtureWhite, 47)).toBeCloseTo(9.8875, 6);
  });

  // Rules of Handicapping (Jan 2024), Rule 5.1c: minus differentials round toward
  // zero at .5 (−1.55 → −1.5). roundHalfUp = floor(x + 0.5) gives exactly that,
  // so the same tenth-rounding used everywhere in this codebase conforms.
  it("minus differentials round toward zero per Rule 5.1c", () => {
    expect(roundHalfUp(-1.54 * 10) / 10).toBe(-1.5);
    expect(roundHalfUp(-1.55 * 10) / 10).toBe(-1.5);
    expect(roundHalfUp(-1.56 * 10) / 10).toBe(-1.6);
  });

  // Unrated tees exist (unrated-courses spec, Task 1): scoreDifferential is only legitimately
  // called on a rated tee — an unrated tee has no rating/slope to compute a differential from.
  it("throws tee-unrated on an unrated tee", () => {
    const unrated: TeeSet = { name: "unrated", holes: [] };
    expect(() => scoreDifferential(unrated, 47)).toThrowError(DomainError);
    expect(() => scoreDifferential(unrated, 47)).toThrowError(expect.objectContaining({ code: "tee-unrated" }));
  });
});

describe("postedDifferential — the 0.1-rounded DISPLAY value (scoreDifferential itself stays unrounded)", () => {
  it("rounds a long-float differential to one decimal, half-up", () => {
    expect(postedDifferential(23.563565891472873)).toBe(23.6);
    expect(postedDifferential(0.7883720930232608)).toBe(0.8);
    expect(postedDifferential(8.672093023255819)).toBe(8.7);
  });

  it("rounds a minus differential toward zero at .05, matching roundHalfUp elsewhere in this file", () => {
    expect(postedDifferential(-1.25)).toBe(-1.2);
  });
});

describe("adjustedGrossScore — fixture golden card", () => {
  // Rules of Handicapping (Jan 2024), Rule 3.1b: max hole score = par + 2 + strokes
  // received, using the player's FULL course handicap ("the player's full,
  // unrestricted Course Handicap should be used for all applications of net double
  // bogey adjustments") — never a game allowance.
  it("caps Ann's h4 pickup at net double bogey 8: AGS 47", () => {
    // Per-hole caps (par+2+dot): 7,7,5,8,7,6,7,8,7; gross 5,6,3,PU,5,4,5,6,5 →
    // counted 5,6,3,8,5,4,5,6,5 = 47. Only the pickup hits its cap.
    expect(adjustedGrossScore(fixtureWhite, 8, card(annCard))).toBe(47);
  });

  it("counts a conceded hole at net double bogey too", () => {
    const conceded = annCard.map((score, index) => (index === 3 ? ("conceded" as const) : score));
    expect(adjustedGrossScore(fixtureWhite, 8, card(conceded))).toBe(47);
  });

  it("caps a blow-up hole at net double bogey", () => {
    // h1 (par 4, 1 dot) blows up to 12 → counted at 4+2+1 = 7, not 12.
    const blowUp = annCard.map((score, index) => (index === 0 ? 12 : score));
    expect(adjustedGrossScore(fixtureWhite, 8, card(blowUp))).toBe(47 - 5 + 7);
  });

  it("gives a scratch player par + 2 caps", () => {
    // Every hole at par+3 → each capped at par+2; pars sum 36 → AGS 36 + 18.
    const wild = fixtureWhite.holes.map((hole) => hole.par + 3);
    expect(adjustedGrossScore(fixtureWhite, 0, card(wild))).toBe(36 + 18);
  });

  it("throws holes-undecided when any tee-set hole lacks a result", () => {
    const partial = () => adjustedGrossScore(fixtureWhite, 8, card(annCard.slice(0, 8)));
    expect(partial).toThrowError(DomainError);
    expect(partial).toThrowError(expect.objectContaining({ code: "holes-undecided" }));
  });
});

describe("computeIndex — published worked examples", () => {
  // Rules of Handicapping (Jan 2024), Rule 5.2a clarification 5.2a/1 (p.55):
  // differentials 15.3, 15.2, 16.6 → lowest (15.2) − 2.0 adjustment = 13.2.
  it("reproduces clarification 5.2a/1: three scores → 13.2", () => {
    expect(computeIndex([15.3, 15.2, 16.6])).toBe(13.2);
  });

  // Rules of Handicapping (Jan 2024), Rule 5.2a clarification 5.2a/2 (p.56):
  // 40.7, 42.4, 36.1 → 36.1 − 2.0 = 34.1; then + 45.9, 43.6, 45.0 (six scores) →
  // average of lowest two (36.1, 40.7) = 38.4, − 1.0 = 37.4.
  it("reproduces clarification 5.2a/2: three scores → 34.1, six scores → 37.4", () => {
    const firstThree = [40.7, 42.4, 36.1];
    expect(computeIndex(firstThree)).toBe(34.1);
    expect(computeIndex([...firstThree, 45.9, 43.6, 45.0])).toBe(37.4);
  });

  it("is undefined under three scores", () => {
    expect(computeIndex([])).toBeUndefined();
    expect(computeIndex([12.3])).toBeUndefined();
    expect(computeIndex([12.3, 14.1])).toBeUndefined();
  });

  // Rule 5.2a table, 20-score row: average of lowest 8, no adjustment.
  it("averages the best 8 of a full 20-score record", () => {
    const differentials = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20 oldest → newest
    expect(computeIndex(differentials)).toBe(4.5); // (1+..+8)/8
  });

  it("only ever reads the most recent 20 differentials", () => {
    const recent = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(computeIndex([100, ...recent])).toBe(4.5); // the ancient 100 is outside the window
  });

  // Documents the window slide the properties file leans on: a worst-yet 21st
  // score CAN raise the index, because it pushes the oldest differential out of
  // the 20-score window — here the record's only low score.
  it("a worst-yet 21st score can raise the index by sliding out an old low score", () => {
    const record = [0, ...Array.from({ length: 19 }, () => 10)];
    expect(computeIndex(record)).toBe(8.8); // best 8 = {0, 10×7} → 70/8
    expect(computeIndex([...record, 20])).toBe(10.0); // 0 slid out; best 8 = 10×8
  });
});

describe("computeIndexDetail — differentialsUsed is Rule 5.2a's `use` count, not the window size", () => {
  // Same clarification 5.2a/1 as above (3 scores → use the lowest 1): differentialsUsed
  // must read 1, not 3 — this is the exact case a naive "differentials considered" count
  // gets wrong.
  it("3 differentials available → uses the lowest 1", () => {
    expect(computeIndexDetail([15.3, 15.2, 16.6])).toEqual({ value: 13.2, differentialsUsed: 1 });
  });

  // Rule 5.2a table, 20-score row: use the best 8.
  it("a full 20-score window → uses the best 8", () => {
    const differentials = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(computeIndexDetail(differentials)).toEqual({ value: 4.5, differentialsUsed: 8 });
  });

  it("is undefined under three scores, matching computeIndex", () => {
    expect(computeIndexDetail([12.3, 14.1])).toBeUndefined();
  });

  it("computeIndex is exactly computeIndexDetail's value projection", () => {
    const differentials = [40.7, 42.4, 36.1, 45.9, 43.6, 45.0];
    expect(computeIndex(differentials)).toBe(computeIndexDetail(differentials)?.value);
  });
});

describe("courseHandicapFor", () => {
  // Rules of Handicapping (Jan 2024), Rule 6.1a: Course Handicap = Handicap Index ×
  // (Slope Rating ÷ 113) + (Course Rating − par), rounding to the nearest whole
  // number as the final step.
  it("computes Rule 6.1a over the fixture tee", () => {
    // 7.0 × 128/113 − 0.2 = 7.729… → 8, Ann's golden course handicap.
    expect(courseHandicapFor(7.0, fixtureWhite)).toBe(8);
  });

  it("gives a plus player a negative course handicap", () => {
    // −2.0 × 128/113 − 0.2 = −2.465… → floor(−1.965…) = −2.
    expect(courseHandicapFor(-2.0, fixtureWhite)).toBe(-2);
  });

  it("round-trips the fixture golden card through the whole engine", () => {
    // Ann's card three times over: AGS 47 → differential 9.8875 each round →
    // three-score index = 9.8875 − 2.0 → 7.9 → course handicap
    // roundHalfUp(7.9 × 128/113 − 0.2) = 9.
    const ags = adjustedGrossScore(fixtureWhite, 8, card(annCard));
    const differential = scoreDifferential(fixtureWhite, ags);
    const index = computeIndex([differential, differential, differential]);
    expect(index).toBe(7.9);
    expect(courseHandicapFor(index!, fixtureWhite)).toBe(9);
  });

  // Unrated tees exist (unrated-courses spec, Task 1): courseHandicapFor is only legitimately
  // called on a rated tee — an unrated tee has no rating/slope to estimate a course handicap from.
  it("throws tee-unrated on an unrated tee", () => {
    const unrated: TeeSet = { name: "unrated", holes: fixtureWhite.holes };
    expect(() => courseHandicapFor(7.0, unrated)).toThrowError(DomainError);
    expect(() => courseHandicapFor(7.0, unrated)).toThrowError(expect.objectContaining({ code: "tee-unrated" }));
  });

  // The delegation the numbers-only helper introduces (unrated-courses T5b): the peek-side
  // caller (JoinRoundPage) has rating/slope/par but no `holes`, so courseHandicapFor is defined
  // in terms of courseHandicapFromRatingSlopePar over the tee's summed par — the two MUST agree
  // for a rated tee (the worked-example pins above stay green precisely because it's behavior-
  // preserving). Several indexes cover the plus/scratch/handicap range in one sweep.
  it("courseHandicapFor agrees with courseHandicapFromRatingSlopePar over the tee's summed par", () => {
    const par = fixtureWhite.holes.reduce((sum, hole) => sum + hole.par, 0);
    for (const index of [-2.0, 0, 7.0, 12.4, 24.8]) {
      expect(courseHandicapFor(index, fixtureWhite)).toBe(courseHandicapFromRatingSlopePar(index, fixtureWhite.rating!, fixtureWhite.slope!, par));
    }
  });
});

describe("unratedCourseHandicap — the unrated estimate (handicap-model legibility spec §4)", () => {
  it("18 holes: round(index), plain Math.round", () => {
    expect(unratedCourseHandicap(12.4, 18)).toBe(Math.round(12.4));
    expect(unratedCourseHandicap(12.4, 18)).toBe(12);
  });

  it("9 holes: round(index / 2)", () => {
    expect(unratedCourseHandicap(12.4, 9)).toBe(Math.round(12.4 / 2));
    expect(unratedCourseHandicap(12.4, 9)).toBe(6);
  });

  // A plus index (below 0, "golf-truth" already owned by the domain per present.ts) walks
  // both branches too — the estimate has no special-case for a negative index.
  it("a plus index (negative), both branches", () => {
    expect(unratedCourseHandicap(-1.2, 18)).toBe(Math.round(-1.2));
    expect(unratedCourseHandicap(-1.2, 18)).toBe(-1);
    expect(unratedCourseHandicap(-1.2, 9)).toBe(Math.round(-1.2 / 2));
    expect(unratedCourseHandicap(-1.2, 9)).toBe(-1);
  });

  // Preserve Math.round's exact half-rounding (JS rounds .5 toward +Infinity, unlike
  // roundHalfUp elsewhere in this file which rounds minus-.5 toward zero) — a regression
  // here would silently change a live-shipped estimate.
  it("preserves plain Math.round's half-rounding exactly, including at .5 boundaries", () => {
    expect(unratedCourseHandicap(2.5, 18)).toBe(3); // Math.round(2.5) === 3
    expect(unratedCourseHandicap(-2.5, 18)).toBe(-2); // Math.round(-2.5) === -2
    expect(unratedCourseHandicap(5.0, 9)).toBe(3); // round(5.0 / 2) = round(2.5) = 3
    expect(unratedCourseHandicap(-5.0, 9)).toBe(-2); // round(-5.0 / 2) = round(-2.5) = -2
  });
});

describe("combineNineHoleDifferentials — 2020 published combining rule", () => {
  // Rules of Handicapping (2020 edition, published 9-hole combining rule swng uses
  // because the 2024 expected-differential ingestion is unpublished — see whs.ts's
  // file-level comment): 18s pass through in place; 9s pair oldest-first into ONE
  // 18-hole-equivalent differential, emitted at the position of the pair's second
  // member; an unpaired trailing 9 contributes nothing until a partner posts.
  it("hand-pins the mixed sequence: [18:10.0, 9:4.1, 18:12.3, 9:5.2, 9:6.0] -> [10.0, 12.3, 9.3]", () => {
    const entries = [
      { differential: 10.0, holes: 18 as const },
      { differential: 4.1, holes: 9 as const },
      { differential: 12.3, holes: 18 as const },
      { differential: 5.2, holes: 9 as const },
      { differential: 6.0, holes: 9 as const },
    ];
    // 4.1 (oldest unpaired 9) pairs with 5.2 (its first-available partner, across
    // the intervening 18) -> 9.3, emitted at 5.2's position; 6.0 is left waiting.
    expect(combineNineHoleDifferentials(entries)).toEqual([10.0, 12.3, 9.3]);
  });

  it("passes 18-hole differentials through untouched and in place", () => {
    const entries = [
      { differential: 7.5, holes: 18 as const },
      { differential: 3.3, holes: 18 as const },
    ];
    expect(combineNineHoleDifferentials(entries)).toEqual([7.5, 3.3]);
  });

  it("pairs two consecutive 9s into one summed differential", () => {
    const entries = [
      { differential: 5.0, holes: 9 as const },
      { differential: 6.0, holes: 9 as const },
    ];
    expect(combineNineHoleDifferentials(entries)).toEqual([11.0]);
  });

  it("drops a trailing unpaired 9 — it waits for a partner that never posts", () => {
    expect(combineNineHoleDifferentials([{ differential: 5.0, holes: 9 as const }])).toEqual([]);
  });

  it("returns an empty sequence for no entries", () => {
    expect(combineNineHoleDifferentials([])).toEqual([]);
  });
});

describe("swngIndex — the WHS fold extended to unrated rounds (handicap-model legibility spec §2, §9)", () => {
  // A rated line carries a real `differential` and contributes it AS IS; an unrated line
  // carries no `differential` (no rating, so no differential is possible) and falls back to
  // the difficulty-neutral ags−par pseudo-differential. Both flow through the SAME nine-hole
  // pairing and small-sample table computeIndex uses.

  it("over a RATED-ONLY set, equals computeIndexDetail over the real differentials — the headline invariant: a rated-only golfer's swng index equals their WHS index exactly", () => {
    const ratedLines = [
      { ags: 90, differential: 15.3, par: 72, holes: 18 as const },
      { ags: 88, differential: 15.2, par: 72, holes: 18 as const },
      { ags: 92, differential: 16.6, par: 72, holes: 18 as const },
    ];
    // Same three differentials, same pinned result as the computeIndexDetail 5.2a/1 case above.
    const whs = computeIndexDetail(combineNineHoleDifferentials(ratedLines.map((line) => ({ differential: line.differential, holes: line.holes }))));
    expect(whs).toEqual({ value: 13.2, differentialsUsed: 1 });
    expect(swngIndex(ratedLines)).toEqual(whs);
  });

  it("over a MIXED set, uses each rated line's real differential (not ags − par) and each unrated line's ags − par", () => {
    const lines = [
      { ags: 90, differential: 5.0, par: 72, holes: 18 as const }, // RATED: real differential 5.0 (ags−par would be 18)
      { ags: 85, par: 72, holes: 18 as const }, // unrated: pseudo 13
      { ags: 45, par: 36, holes: 9 as const }, //  unrated: pseudo 9  (pending)
      { ags: 44, par: 36, holes: 9 as const }, //  unrated: pseudo 8  (pairs -> 17)
    ];
    // combined = [5, 13, 17]; length 3 -> use 1, adjustment -2.0 -> lowest 5 -> 5 - 2.0 = 3.0.
    // (Using the real differential 5 — not the ags−par pseudo 18 — is exactly what's under test:
    // an 18-pseudo would combine to [18, 13, 17] and yield 16.0 instead.)
    expect(swngIndex(lines)).toEqual({ value: 3, differentialsUsed: 1 });
  });

  it("over an ALL-UNRATED set, matches the neutral ags − par pseudo-differential fold unchanged (pairing the two 9s)", () => {
    const lines = [
      { ags: 90, par: 72, holes: 18 as const }, // pseudo 18
      { ags: 85, par: 72, holes: 18 as const }, // pseudo 13
      { ags: 45, par: 36, holes: 9 as const }, //  pseudo 9  (pending)
      { ags: 44, par: 36, holes: 9 as const }, //  pseudo 8  (pairs -> 17)
      { ags: 80, par: 72, holes: 18 as const }, // pseudo 8
    ];
    const pseudo = [
      { differential: 18, holes: 18 as const },
      { differential: 13, holes: 18 as const },
      { differential: 9, holes: 9 as const },
      { differential: 8, holes: 9 as const },
      { differential: 8, holes: 18 as const },
    ];
    // combined = [18, 13, 17, 8]; length 4 -> use 1, adjustment -1.0 -> lowest 8 -> 8 - 1 = 7.0.
    expect(swngIndex(lines)).toEqual({ value: 7, differentialsUsed: 1 });
    expect(swngIndex(lines)).toEqual(computeIndexDetail(combineNineHoleDifferentials(pseudo)));
  });

  it("skips a line with no ags — adding one leaves the swng index unchanged", () => {
    const lines = [
      { ags: 90, par: 72, holes: 18 as const },
      { ags: 85, par: 72, holes: 18 as const },
      { ags: 80, par: 72, holes: 18 as const },
    ];
    const withNoAgs = [...lines, { par: 72, holes: 18 as const }];
    expect(swngIndex(withNoAgs)).toEqual(swngIndex(lines));
  });

  it("is undefined below the 3-differential bootstrap (a single ags-bearing line)", () => {
    expect(swngIndex([{ ags: 90, par: 72, holes: 18 as const }])).toBeUndefined();
  });
});
