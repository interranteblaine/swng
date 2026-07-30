import { describe, expect, it } from "vitest";
import { roundId } from "../ids.js";
import { roundHalfUp } from "../scoring/strokes.js";
import type { GolferRoundLine } from "./record.js";
import { golferMetrics } from "./metrics.js";

// A minimal 18-hole line with NO holeResults — it has no score, so it never feeds the average.
// Used by the typicalEighteen block below, which reads `distribution` alone.
const line = (over: Partial<GolferRoundLine>): GolferRoundLine => ({
  roundId: roundId("r"),
  courseName: "Casa Verde GC",
  tee: "white",
  holes: 18,
  par: 72,
  strokes: 8,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  ...over,
});

// A line that DOES feed the average: 18 holes of par 4 (par 72), every hole a stroke count, so
// `hasCompleteScore` holds. gross = 18 × perHole; over par = gross − 72.
const scored = (id: string, perHole: number): GolferRoundLine =>
  line({
    roundId: roundId(id),
    holeResults: Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, result: { kind: "strokes" as const, strokes: perHole } })),
  });

// Three rounds at 90 (+18) then two at 108 (+36) — the whole block's fixture, hand-derived once:
//   average = mean(18,18,18,36,36) = 126/5 = 25.2 → roundHalfUp → 25
const FIVE_ROUNDS = [scored("a", 5), scored("b", 5), scored("c", 5), scored("d", 6), scored("e", 6)];

describe("golferMetrics — the read projection (spec 2026-07-29 §5)", () => {
  it("serves the average over the golfer's scored lines", () => {
    expect(golferMetrics(FIVE_ROUNDS).average).toBe(25);
  });

  it("averages however many scored rounds there are — no floor of its own", () => {
    expect(golferMetrics(FIVE_ROUNDS.slice(0, 4)).average).toBe(23); // mean(18,18,18,36) = 22.5 → roundHalfUp → 23
    expect(golferMetrics(FIVE_ROUNDS.slice(0, 1)).average).toBe(18); // one scored round is already an average
  });

  // Spread is the CREW BOARD's column alone, over the season window (spec §6, controller ruling) —
  // this projection must never grow a rolling-10 twin of it under the same name.
  it("serves no spread", () => {
    expect(golferMetrics(FIVE_ROUNDS)).not.toHaveProperty("spread");
  });

  it("a round containing a pickup has no score, so it does not move the average", () => {
    const withPickup = line({
      roundId: roundId("f"),
      holeResults: [
        { hole: 1, par: 4, result: { kind: "picked-up" as const } },
        ...Array.from({ length: 17 }, (_, i) => ({ hole: i + 2, par: 4, result: { kind: "strokes" as const, strokes: 5 } })),
      ],
    });
    expect(golferMetrics([...FIVE_ROUNDS, withPickup]).average).toBe(25);
  });

  it("an empty history yields no average, an all-zero typicalEighteen, an empty averageHistory, and empty bests/milestones", () => {
    const metrics = golferMetrics([]);
    expect(metrics).toEqual({
      typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      averageHistory: [],
      bests: {},
      milestones: [],
    });
  });

  // The whole index model is gone (spec §7) — these keys must not come back by accident on either
  // an empty or a populated history.
  it("never returns an index of any kind", () => {
    for (const metrics of [golferMetrics([]), golferMetrics(FIVE_ROUNDS)]) {
      expect(metrics).not.toHaveProperty("whsIndex");
      expect(metrics).not.toHaveProperty("swngIndex");
      expect(metrics).not.toHaveProperty("indexHistory");
    }
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
// per-round `distribution` buckets, summed across ALL lines then NORMALIZED to a per-18-hole rate
// — so a golfer who plays mostly 9s isn't shown a deflated career total.
describe("golferMetrics — typicalEighteen (career buckets normalized to a per-18 rate)", () => {
  it("normalizes a mix of 18s and a 9 to roundHalfUp(bucket / holesDecided × 18)", () => {
    const lines = [
      line({ holes: 18, distribution: { eagles: 1, birdies: 2, pars: 10, bogeys: 4, doublePlus: 1 } }),
      line({ holes: 18, distribution: { eagles: 0, birdies: 3, pars: 9, bogeys: 5, doublePlus: 1 } }),
      line({ holes: 9, distribution: { eagles: 0, birdies: 1, pars: 5, bogeys: 2, doublePlus: 1 } }),
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

// averageHistory ("your average over time", spec §5): ONE point per CONTRIBUTING round,
// oldest → newest, each the rolling average as of that round. The self-consistency invariant is
// the whole point — the headline IS the last point, so the two can never drift apart.
describe("golferMetrics — averageHistory (the rolling average, recomputed at each round)", () => {
  it("carries one point per round, hand-derived as the running mean", () => {
    // Windows: [18] → 18 · [18,18] → 18 · [18,18,18] → 18 · +36 → 90/4 = 22.5 → 23 ·
    // +36 → 126/5 = 25.2 → 25.
    expect(golferMetrics(FIVE_ROUNDS).averageHistory).toEqual([
      { roundId: roundId("a"), average: 18 },
      { roundId: roundId("b"), average: 18 },
      { roundId: roundId("c"), average: 18 },
      { roundId: roundId("d"), average: 23 },
      { roundId: roundId("e"), average: 25 },
    ]);
  });

  it("self-consistency: each point equals the headline average of the lines up to and including it", () => {
    const history = golferMetrics(FIVE_ROUNDS).averageHistory;
    history.forEach((point, k) => {
      expect(point.average).toBe(golferMetrics(FIVE_ROUNDS.slice(0, k + 1)).average);
    });
  });

  it("the headline average equals averageHistory's own last point", () => {
    const metrics = golferMetrics(FIVE_ROUNDS);
    expect(metrics.average).toBe(metrics.averageHistory.at(-1)?.average);
  });

  it("a round with no score is not a data point at all", () => {
    const noScore = line({ roundId: roundId("gap") }); // no holeResults
    const history = golferMetrics([...FIVE_ROUNDS, noScore]).averageHistory;
    expect(history).toHaveLength(FIVE_ROUNDS.length);
    expect(history.map((point) => point.roundId)).not.toContain(roundId("gap"));
  });

  it("an empty history yields an empty averageHistory", () => {
    expect(golferMetrics([]).averageHistory).toEqual([]);
  });
});
