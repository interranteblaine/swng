import { describe, expect, it } from "vitest";
import { combineNineHoleDifferentials, computeIndexDetail, swngIndex } from "../handicap/whs.js";
import { roundId } from "../ids.js";
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

  it("an empty history yields no whsIndex/swngIndex, plus zeroed distribution and an empty trend", () => {
    expect(golferMetrics([])).toEqual({
      distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      trend: [],
    });
  });
});

// distribution + trend (papercut 17 — the metrics projection grows, the web stops computing
// these itself): distribution is a CAREER total summed from every line's own `distribution`
// field (record.ts's archiveGolferLine already computes it per line — this is a sum, not a
// recomputation from cells), rated or unrated alike. trend is the posted (rated) differentials
// only, oldest → newest (the order golferMetrics itself receives lines in, per getMyRecord's own
// sortLines contract), capped at the newest 20.
describe("golferMetrics — distribution (career totals, summed across ALL lines)", () => {
  it("sums each bucket across every line, rated and unrated alike", () => {
    const lines = [
      line({ ags: 90, differential: 9.0, distribution: { eagles: 1, birdies: 2, pars: 10, bogeys: 4, doublePlus: 1 } }),
      line({ ags: 100, distribution: { eagles: 0, birdies: 1, pars: 8, bogeys: 6, doublePlus: 3 } }), // unrated — still counts
      line({ ags: 95, differential: 14.0, distribution: { eagles: 0, birdies: 0, pars: 6, bogeys: 8, doublePlus: 4 } }),
    ];

    expect(golferMetrics(lines).distribution).toEqual({ eagles: 1, birdies: 3, pars: 24, bogeys: 18, doublePlus: 8 });
  });

  it("an empty history sums to all zeros", () => {
    expect(golferMetrics([]).distribution).toEqual({ eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 });
  });
});

describe("golferMetrics — trend (posted differentials, oldest → newest, newest ≤20)", () => {
  it("excludes lines without a posted differential (unrated)", () => {
    const lines = [
      line({ ags: 90, differential: 9.0 }),
      line({ ags: 100 }), // unrated — no differential, excluded
      line({ ags: 95, differential: 14.0 }),
    ];

    expect(golferMetrics(lines).trend).toEqual([9.0, 14.0]);
  });

  it("preserves the oldest → newest order it was given (the order getMyRecord's sortLines already produces)", () => {
    const lines = [line({ differential: 9.0 }), line({ differential: 11.0 }), line({ differential: 14.0 })];

    expect(golferMetrics(lines).trend).toEqual([9.0, 11.0, 14.0]);
  });

  it("an empty history yields an empty trend", () => {
    expect(golferMetrics([]).trend).toEqual([]);
  });

  it("more than 20 posted differentials: keeps only the newest 20, still oldest → newest", () => {
    const lines = Array.from({ length: 23 }, (_, i) => line({ differential: i + 1 }));

    const trend = golferMetrics(lines).trend;
    expect(trend).toHaveLength(20);
    expect(trend).toEqual(Array.from({ length: 20 }, (_, i) => i + 4)); // newest 20 of 1..23 is 4..23
  });

  it("exactly 20 posted differentials: keeps all 20", () => {
    const lines = Array.from({ length: 20 }, (_, i) => line({ differential: i + 1 }));

    expect(golferMetrics(lines).trend).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
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
