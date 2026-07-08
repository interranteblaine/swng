import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { HoleResult } from "../round/holeResult.js";
import { fixtureWhite } from "../scoring/golden/fixtureCourse.js";
import { adjustedGrossScore, computeIndex } from "./whs.js";

// Integer differentials make these true invariants rather than approximate ones:
// sums of integers are exact in floating point, and best-k averaging and
// tenth-rounding are both monotone, so fp noise can never push a result across a
// bound that holds in real arithmetic.
const differentials = (minLength: number, maxLength: number) =>
  fc.array(fc.integer({ min: -5, max: 60 }), { minLength, maxLength });

describe("computeIndex properties", () => {
  it("index stays within [min, max] of its 20-score window once no adjustment applies", () => {
    // From 7 scores up, the Rule 5.2a table applies no adjustment, so the index is
    // an average of a subset of the window — containment is exact. Below 7 the
    // table's −2.0/−1.0 adjustments deliberately push the index BELOW the min
    // (pinned by the 5.2a/1 and 5.2a/2 conformance tests), so they're excluded here.
    fc.assert(
      fc.property(differentials(7, 40), (record) => {
        const index = computeIndex(record)!;
        const window = record.slice(-20);
        expect(index).toBeGreaterThanOrEqual(Math.min(...window));
        expect(index).toBeLessThanOrEqual(Math.max(...window));
      }),
    );
  });

  it("a 21st score worse than the whole record never lowers the index", () => {
    // The brief phrased this "never raises"; that direction is provably false —
    // the 21st score slides the oldest differential out of the 20-score window,
    // and if that was one of the best 8 the index RISES (pinned deterministically
    // in whs.test.ts's window-slide case). The invariant handicapping actually
    // guarantees is the converse: posting a bad round can never IMPROVE the index.
    fc.assert(
      fc.property(differentials(20, 20), fc.integer({ min: 0, max: 20 }), (record, margin) => {
        const worst = Math.max(...record) + margin;
        expect(computeIndex([...record, worst])!).toBeGreaterThanOrEqual(computeIndex(record)!);
      }),
    );
  });
});

describe("adjustedGrossScore properties", () => {
  it("AGS never exceeds the raw gross sum when every hole was holed out", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 9, maxLength: 9 }),
        fc.integer({ min: -9, max: 54 }),
        (strokes, courseHandicap) => {
          const holes: ReadonlyMap<number, HoleResult> = new Map(
            strokes.map((s, index) => [index + 1, { kind: "strokes", strokes: s }]),
          );
          const ags = adjustedGrossScore(fixtureWhite, courseHandicap, holes);
          expect(ags).toBeLessThanOrEqual(strokes.reduce((sum, s) => sum + s, 0));
        },
      ),
    );
  });
});
