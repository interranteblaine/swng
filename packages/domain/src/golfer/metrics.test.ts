import { describe, expect, it } from "vitest";
import { combineNineHoleDifferentials, computeIndexDetail, swngIndex } from "../handicap/whs.js";
import { roundId } from "../ids.js";
import { roundHalfUp } from "../scoring/strokes.js";
import type { GolferRoundLine } from "./record.js";
import { golferMetrics, resolveIndex } from "./metrics.js";
import type { IndexSource } from "./golfer.js";

// A minimal 18-hole line — every metric golferMetrics reads (differential for whsIndex, ags +
// par + holes for swngIndex) is overridable; the rest is filler the fold never touches.
const line = (over: Partial<GolferRoundLine>): GolferRoundLine => ({
  roundId: roundId("r"),
  courseName: "Casa Verde GC",
  tee: "white",
  holes: 18,
  par: 72,
  courseHandicap: 8,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  ...over,
});

describe("golferMetrics — the read projection (handicap-model legibility spec §2, §9; unrated-courses spec §6)", () => {
  it("computes whsIndex from RATED (differential-bearing) lines only, and swngIndex from every ags-bearing line — a rated-only set makes the two equal (the headline invariant)", () => {
    const ratedThree = [
      line({ ags: 90, differential: 9.0 }),
      line({ ags: 95, differential: 14.0 }),
      line({ ags: 92, differential: 11.0 }),
    ];
    const metrics = golferMetrics(ratedThree);

    const expectedWhs = computeIndexDetail(combineNineHoleDifferentials(ratedThree.map((l) => ({ differential: l.differential!, holes: l.holes }))))!;
    expect(metrics.whsIndex).toEqual({ value: expectedWhs.value, differentialsUsed: expectedWhs.differentialsUsed });
    const expectedSwng = swngIndex(ratedThree)!;
    expect(metrics.swngIndex).toEqual({ value: expectedSwng.value, differentialsUsed: expectedSwng.differentialsUsed });
    // Rated-only: swngIndex uses each line's real differential, same as whsIndex — they agree exactly.
    expect(metrics.swngIndex).toEqual(metrics.whsIndex);
  });

  it("an unrated ags-bearing line reaches swngIndex but NOT whsIndex", () => {
    const ratedThree = [
      line({ ags: 90, differential: 9.0 }),
      line({ ags: 95, differential: 14.0 }),
      line({ ags: 92, differential: 11.0 }),
    ];
    // A fourth round on an unrated tee: it carries an ags but no differential.
    const plusUnrated = [...ratedThree, line({ ags: 100 })];

    const before = golferMetrics(ratedThree);
    const after = golferMetrics(plusUnrated);

    // whsIndex is unchanged — the unrated line has no differential, so it never reaches Rule 5.2a.
    expect(after.whsIndex).toEqual(before.whsIndex);
    // swngIndex DID move — the unrated round's ags−par pseudo-differential is now in the pool.
    expect(after.swngIndex).not.toEqual(before.swngIndex);
    expect(after.swngIndex).toEqual(
      (() => {
        const s = swngIndex(plusUnrated)!;
        return { value: s.value, differentialsUsed: s.differentialsUsed };
      })(),
    );
  });

  it("a wholly-unrated history yields { swngIndex } with no whsIndex", () => {
    const unratedFour = [line({ ags: 96 }), line({ ags: 101 }), line({ ags: 94 }), line({ ags: 99 })];
    const metrics = golferMetrics(unratedFour);

    expect(metrics.whsIndex).toBeUndefined();
    expect(metrics.swngIndex).toBeDefined();
    const s = swngIndex(unratedFour)!;
    expect(metrics.swngIndex).toEqual({ value: s.value, differentialsUsed: s.differentialsUsed });
  });

  it("an empty history yields no whsIndex/swngIndex, an all-zero typicalEighteen, and an empty indexHistory — no distribution/trend keys", () => {
    const metrics = golferMetrics([]);
    expect(metrics).toEqual({
      typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      indexHistory: [],
    });
    expect(metrics).not.toHaveProperty("distribution");
    expect(metrics).not.toHaveProperty("trend");
  });

  it("no longer returns distribution or trend even with a populated history", () => {
    const metrics = golferMetrics([line({ ags: 90, differential: 9.0 }), line({ ags: 95, differential: 14.0 }), line({ ags: 92, differential: 11.0 })]);
    expect(metrics).not.toHaveProperty("distribution");
    expect(metrics).not.toHaveProperty("trend");
  });
});

// typicalEighteen (papercut 17's replacement for the old career `distribution` total): the same
// per-round `distribution` buckets, summed across ALL lines (rated or unrated) then NORMALIZED to
// a per-18-hole rate — so a golfer who plays mostly 9s isn't shown a deflated career total.
describe("golferMetrics — typicalEighteen (career buckets normalized to a per-18 rate)", () => {
  it("normalizes a mix of 18s and a 9 to roundHalfUp(bucket / holesDecided × 18)", () => {
    const lines = [
      line({ holes: 18, ags: 90, differential: 9.0, distribution: { eagles: 1, birdies: 2, pars: 10, bogeys: 4, doublePlus: 1 } }),
      line({ holes: 18, ags: 95, differential: 14.0, distribution: { eagles: 0, birdies: 3, pars: 9, bogeys: 5, doublePlus: 1 } }),
      line({ holes: 9, ags: 45, distribution: { eagles: 0, birdies: 1, pars: 5, bogeys: 2, doublePlus: 1 } }), // unrated 9 — still counts
    ];
    // Career totals: eagles 1, birdies 6, pars 24, bogeys 11, doublePlus 3 — sums to 45 decided holes.
    const holesDecided = 45;
    const per18 = (n: number) => roundHalfUp((n / holesDecided) * 18);
    expect(golferMetrics(lines).typicalEighteen).toEqual({
      eagles: per18(1),
      birdies: per18(6),
      pars: per18(24),
      bogeys: per18(11),
      doublePlus: per18(3),
    });
    // Hand-pinned: 1*0.4=0.4→0, 6*0.4=2.4→2, 24*0.4=9.6→10, 11*0.4=4.4→4, 3*0.4=1.2→1.
    expect(golferMetrics(lines).typicalEighteen).toEqual({ eagles: 0, birdies: 2, pars: 10, bogeys: 4, doublePlus: 1 });
  });

  it("an empty history normalizes to all zeros (no division by zero)", () => {
    expect(golferMetrics([]).typicalEighteen).toEqual({ eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 });
  });
});

// indexHistory (the arc's headline feature): one point per round, oldest → newest, each the
// index recomputed from every line UP TO AND INCLUDING it — "your index over time." The
// self-consistency invariant is the whole point: indexHistory[k] must equal what golferMetrics
// itself reports as the headline for that exact prefix, since the headline IS just the last point.
describe("golferMetrics — indexHistory (the rolling swng + WHS index, recomputed at each round)", () => {
  // Oldest → newest: 3 unrated 18s (bootstraps swng before any rated round exists), then 3 rated
  // 18s (bootstraps whs), then an unrated 18 in the middle of rated play (whs must hold flat;
  // swng keeps moving because it folds every ags-bearing line).
  // Distinct roundIds per line so the self-consistency test's `history[k].roundId === lines[k].roundId`
  // actually pins that IndexPoint carries THIS round's id (not a shared default that passes trivially).
  const lines = [
    line({ roundId: roundId("r0"), holes: 18, ags: 90 }), // pseudo diff 18 — unrated
    line({ roundId: roundId("r1"), holes: 18, ags: 85 }), // pseudo diff 13 — unrated
    line({ roundId: roundId("r2"), holes: 18, ags: 80 }), // pseudo diff 8  — unrated (3rd: swng bootstraps here)
    line({ roundId: roundId("r3"), holes: 18, ags: 90, differential: 9.0 }), // rated
    line({ roundId: roundId("r4"), holes: 18, ags: 95, differential: 14.0 }), // rated
    line({ roundId: roundId("r5"), holes: 18, ags: 92, differential: 11.0 }), // rated (3rd rated: whs bootstraps here)
    line({ roundId: roundId("r6"), holes: 18, ags: 100 }), // unrated, mid-sequence — whs must hold flat, swng moves
    line({ roundId: roundId("r7"), holes: 18, ags: 88, differential: 8.0 }), // rated again — whs resumes moving
  ];

  it("self-consistency: indexHistory[k] equals golferMetrics(lines.slice(0, k+1))'s own headline swngIndex/whsIndex", () => {
    const history = golferMetrics(lines).indexHistory;
    expect(history).toHaveLength(lines.length);
    lines.forEach((l, k) => {
      const prefixMetrics = golferMetrics(lines.slice(0, k + 1));
      expect(history[k].roundId).toBe(l.roundId);
      expect(history[k].swngIndex).toEqual(prefixMetrics.swngIndex?.value);
      expect(history[k].whsIndex).toEqual(prefixMetrics.whsIndex?.value);
    });
  });

  it("before any rated round exists, whsIndex is absent but swngIndex is present once bootstrapped (3rd unrated round)", () => {
    const history = golferMetrics(lines).indexHistory;
    expect(history[0].swngIndex).toBeUndefined(); // only 1 ags-bearing line — below the 3-line bootstrap
    expect(history[1].swngIndex).toBeUndefined(); // only 2
    expect(history[2].swngIndex).toBeDefined(); // 3rd unrated round: swng bootstraps
    expect(history[2].whsIndex).toBeUndefined(); // no rated round has happened yet
  });

  it("an unrated round in the middle of rated play holds whsIndex flat (equal to the prior point) while swngIndex keeps moving", () => {
    const history = golferMetrics(lines).indexHistory;
    // k=5 is the 3rd rated round (whs bootstraps); k=6 is the mid-sequence unrated round.
    expect(history[5].whsIndex).toBeDefined();
    expect(history[6].whsIndex).toEqual(history[5].whsIndex); // flat — the unrated round can't move it
    expect(history[6].swngIndex).not.toEqual(history[5].swngIndex); // swng DID move — it folds every ags line
  });

  it("every present value is rounded to one decimal (no long floats)", () => {
    const history = golferMetrics(lines).indexHistory;
    for (const point of history) {
      if (point.swngIndex !== undefined) expect(point.swngIndex).toBeCloseTo(roundHalfUp(point.swngIndex * 10) / 10, 10);
      if (point.whsIndex !== undefined) expect(point.whsIndex).toBeCloseTo(roundHalfUp(point.whsIndex * 10) / 10, 10);
    }
  });

  it("an empty history yields an empty indexHistory", () => {
    expect(golferMetrics([]).indexHistory).toEqual([]);
  });
});

// resolveIndex (index-source model spec §4): "Your index" is never stored — it is resolved on
// every read from the golfer's chosen SOURCE and the live metrics. Each kind resolves to the
// right member; a computed source with no metric yet resolves to `undefined` (first-class, NOT
// 0); a missing source defaults to swng. The no-drift test is the whole point of the model.
describe("resolveIndex — the source resolved live over metrics (index-source model spec §4)", () => {
  it("swng resolves to metrics.swngIndex?.value", () => {
    expect(resolveIndex({ kind: "swng" }, { swngIndex: { value: 12.4 }, whsIndex: { value: 11.2 } })).toEqual({ value: 12.4, kind: "swng" });
  });

  it("whs resolves to metrics.whsIndex?.value", () => {
    expect(resolveIndex({ kind: "whs" }, { swngIndex: { value: 12.4 }, whsIndex: { value: 11.2 } })).toEqual({ value: 11.2, kind: "whs" });
  });

  it("declared resolves to its own asserted value, ignoring the metrics entirely", () => {
    expect(resolveIndex({ kind: "declared", value: 8 }, { swngIndex: { value: 12.4 }, whsIndex: { value: 11.2 } })).toEqual({ value: 8, kind: "declared" });
  });

  it("a computed source with no metric resolves to { value: undefined } — NOT 0", () => {
    expect(resolveIndex({ kind: "swng" }, {})).toEqual({ value: undefined, kind: "swng" });
    expect(resolveIndex({ kind: "whs" }, {})).toEqual({ value: undefined, kind: "whs" });
  });

  it("a missing (undefined) source defaults to swng — the model's default", () => {
    expect(resolveIndex(undefined, { swngIndex: { value: 9.4 } })).toEqual({ value: 9.4, kind: "swng" });
    expect(resolveIndex(undefined, {})).toEqual({ value: undefined, kind: "swng" });
  });

  // The headline invariant (spec §2, "never store a computed number"): the SAME whs source, held
  // fixed, follows two different metrics snapshots. A stored copy could not do this by construction
  // — there is nowhere to store one. This is what makes drift unrepresentable.
  it("no-drift: one fixed whs source follows two different metrics snapshots", () => {
    const source: IndexSource = { kind: "whs" };
    expect(resolveIndex(source, { whsIndex: { value: 11.2 } }).value).toBe(11.2);
    expect(resolveIndex(source, { whsIndex: { value: 10.6 } }).value).toBe(10.6);
  });
});
