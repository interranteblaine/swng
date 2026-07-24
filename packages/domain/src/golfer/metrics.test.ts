import { describe, expect, it } from "vitest";
import type { IndexComputation } from "../handicap/whs.js";
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

  it("an empty history yields no whsIndex/swngIndex, an all-zero typicalEighteen, an empty indexHistory, and empty bests/milestones — no distribution/trend keys", () => {
    const metrics = golferMetrics([]);
    expect(metrics).toEqual({
      typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      indexHistory: [],
      bests: {},
      milestones: [],
    });
    expect(metrics).not.toHaveProperty("distribution");
    expect(metrics).not.toHaveProperty("trend");
  });

  it("no longer returns distribution or trend even with a populated history", () => {
    const metrics = golferMetrics([line({ ags: 90, differential: 9.0 }), line({ ags: 95, differential: 14.0 }), line({ ags: 92, differential: 11.0 })]);
    expect(metrics).not.toHaveProperty("distribution");
    expect(metrics).not.toHaveProperty("trend");
  });

  // bests/milestones (analytics spec 2026-07-21 §3): golferMetrics wires straight through to
  // analytics.ts's own bestsOf/milestonesOf over the same lines — this pins that the wiring
  // exists and lands one hand-computed value (a fully holed-out 18 with a birdie hole sets both
  // best18 and fires first-birdie/broke-100/broke-90, not broke-80).
  it("wires bests/milestones from a line's holeResults", () => {
    const holeResults = [
      { hole: 1, par: 4, result: { kind: "strokes" as const, strokes: 3 } }, // -1, birdie
      ...Array.from({ length: 17 }, (_, i) => ({ hole: i + 2, par: 4, result: { kind: "strokes" as const, strokes: 5 } })),
    ];
    // gross = 3 + 17*5 = 88; toPar = 88 - 72 = 16.
    const metrics = golferMetrics([line({ roundId: roundId("m1"), holes: 18, par: 72, holeResults })]);

    expect(metrics.bests).toEqual({ best18: { roundId: roundId("m1"), gross: 88, toPar: 16 } });
    expect(metrics.milestones).toEqual([
      { kind: "first-birdie", roundId: roundId("m1") },
      { kind: "broke-100", roundId: roundId("m1") },
      { kind: "broke-90", roundId: roundId("m1") },
    ]);
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
      const point = history[k]!; // length asserted above; k is in range
      expect(point.roundId).toBe(l.roundId);
      expect(point.swngIndex).toEqual(prefixMetrics.swngIndex?.value);
      expect(point.whsIndex).toEqual(prefixMetrics.whsIndex?.value);
    });
  });

  it("before any rated round exists, whsIndex is absent but swngIndex is present once bootstrapped (3rd unrated round)", () => {
    const history = golferMetrics(lines).indexHistory;
    expect(history[0]!.swngIndex).toBeUndefined(); // only 1 ags-bearing line — below the 3-line bootstrap
    expect(history[1]!.swngIndex).toBeUndefined(); // only 2
    expect(history[2]!.swngIndex).toBeDefined(); // 3rd unrated round: swng bootstraps
    expect(history[2]!.whsIndex).toBeUndefined(); // no rated round has happened yet
  });

  it("an unrated round in the middle of rated play holds whsIndex flat (equal to the prior point) while swngIndex keeps moving", () => {
    const history = golferMetrics(lines).indexHistory;
    // k=5 is the 3rd rated round (whs bootstraps); k=6 is the mid-sequence unrated round.
    expect(history[5]!.whsIndex).toBeDefined();
    expect(history[6]!.whsIndex).toEqual(history[5]!.whsIndex); // flat — the unrated round can't move it
    expect(history[6]!.swngIndex).not.toEqual(history[5]!.swngIndex); // swng DID move — it folds every ags line
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

// Perf spec §3: indexHistory used to re-fold the WHOLE career prefix for every round
// (O(N²) on GET /me/record / GET /golfers/{id}) — now a single O(N) forward pass over two
// running combined-differential streams (golfer/metrics.ts's indexHistoryOf). This is a
// BEHAVIOR-PRESERVING refactor, so it's checked against an INDEPENDENT reimplementation of the
// pre-refactor whole-prefix computation (detailsOfForTest below — not a call into
// golferMetrics/detailsOf, which is private to metrics.ts anyway, so a broken refactor can't
// accidentally agree with itself) over a fixture built to actually EXERCISE the reason a naive
// "last N lines" window would be wrong.
describe("golferMetrics — indexHistory is O(N): equals an independent per-prefix oracle over a cross-window 9-hole fixture", () => {
  // The pre-refactor whole-prefix computation, reproduced independently here as ground truth —
  // byte-identical to metrics.ts's own (private) detailsOf, but written fresh in the test file.
  const detailsOfForTest = (prefix: readonly GolferRoundLine[]): { whs?: IndexComputation; swng?: IndexComputation } => {
    const rated = prefix.filter((l) => l.differential !== undefined);
    const whs = computeIndexDetail(combineNineHoleDifferentials(rated.map((l) => ({ differential: l.differential!, holes: l.holes }))));
    const swng = swngIndex(prefix);
    return { ...(whs !== undefined ? { whs } : {}), ...(swng !== undefined ? { swng } : {}) };
  };

  // 27 lines, oldest → newest (well over the ≥25 bar):
  //  pos 0  — an unpaired RATED 9. Its WHS partner doesn't arrive until pos 24, twenty-four
  //           positions later — well past any naive line-count window a broken "optimization"
  //           might use, so the pending state MUST be carried unbounded, not windowed by line count.
  //  pos 1  — an UNRATED 9. No differential, so it never touches the WHS stream — but it DOES
  //           complete pos 0's pairing on the SWNG stream immediately (differential ?? ags−par
  //           both read pos 0's pending value). The WHS and swng streams pair pos 0's 9 on
  //           DIFFERENT rounds (pos 24 vs. pos 1) — proof the two streams are genuinely
  //           independent, not one fold shared by accident.
  //  pos 2..23 — 22 RATED 18s: bulk career play, pushing both streams' combined lists well past
  //           the 20-differential WHS window before pos 0's pairing ever resolves.
  //  pos 24 — a RATED 9: completes pos 0's WHS pairing (24 rounds later); starts a NEW pending 9
  //           on the swng stream (which has none — pos 1 already cleared it).
  //  pos 25 — an UNRATED 9: completes pos 24's pairing on the swng stream; WHS untouched.
  //  pos 26 — one more RATED 18, for good measure.
  const crossWindowLines: GolferRoundLine[] = [
    line({ roundId: roundId("cw0"), holes: 9, par: 36, ags: 40, differential: 10.0 }),
    line({ roundId: roundId("cw1"), holes: 9, par: 36, ags: 42 }),
    ...Array.from({ length: 22 }, (_, i) => line({ roundId: roundId(`cw${i + 2}`), holes: 18, par: 72, ags: 90, differential: 9.0 + i * 0.3 })),
    line({ roundId: roundId("cw24"), holes: 9, par: 36, ags: 44, differential: 7.5 }),
    line({ roundId: roundId("cw25"), holes: 9, par: 36, ags: 41 }),
    line({ roundId: roundId("cw26"), holes: 18, par: 72, ags: 90, differential: 16.0 }),
  ];

  it("fixture sanity: at least 25 lines, mixing 9s/18s and rated/unrated", () => {
    expect(crossWindowLines.length).toBeGreaterThanOrEqual(25);
    expect(crossWindowLines.some((l) => l.holes === 9 && l.differential === undefined)).toBe(true);
    expect(crossWindowLines.some((l) => l.holes === 9 && l.differential !== undefined)).toBe(true);
  });

  it("the WHS and swng streams pair pos-0's unpaired 9 on DIFFERENT rounds — proof the two streams run independently", () => {
    const history = golferMetrics(crossWindowLines).indexHistory;
    // swng's combined list is [pair(cw0,cw1)=16.0, cw2's 9.0, cw3's 9.3] — 3 entries first exist
    // at position 3, bootstrapping swngIndex there (positions 0-2 are all below the 3-entry floor).
    expect(history[0]!.swngIndex).toBeUndefined();
    expect(history[1]!.swngIndex).toBeUndefined();
    expect(history[2]!.swngIndex).toBeUndefined();
    expect(history[3]!.swngIndex).toBeDefined();
    // WHS never sees cw0's 9 paired until cw24 — before that, WHS's combined list is only the 22
    // rated 18s at positions 2..23 (cw0 stays pending the entire time).
    expect(history[23]!.whsIndex).toBeDefined(); // bootstrapped from the rated-18 run alone
    const beforePairing = history[23]!.whsIndex;
    expect(history[24]!.whsIndex).not.toEqual(beforePairing); // cw0's pairing landed HERE, 24 rounds later
  });

  it("indexHistory matches the independent per-prefix oracle exactly, round by round", () => {
    const viaPass = golferMetrics(crossWindowLines).indexHistory;
    const viaPrefix = crossWindowLines.map((l, k) => {
      const d = detailsOfForTest(crossWindowLines.slice(0, k + 1));
      return {
        roundId: l.roundId,
        ...(d.swng !== undefined ? { swngIndex: d.swng.value } : {}),
        ...(d.whs !== undefined ? { whsIndex: d.whs.value } : {}),
      };
    });
    expect(viaPass).toEqual(viaPrefix);
  });

  it("the headline whsIndex/swngIndex equals indexHistory's own last point", () => {
    const m = golferMetrics(crossWindowLines);
    const last = m.indexHistory.at(-1);
    expect(m.swngIndex?.value).toBe(last?.swngIndex);
    expect(m.whsIndex?.value).toBe(last?.whsIndex);
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
