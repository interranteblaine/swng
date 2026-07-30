import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { TeeSet } from "../course/card.js";
import { allocateStrokes } from "./strokes.js";

const teeSet = (count: 9 | 18): TeeSet => ({
  name: "t", rating: 70, slope: 113,
  holes: Array.from({ length: count }, (_, i) => ({
    number: i + 1, par: 4, yardage: 400,
    strokeIndex: ((i * 7) % count) + 1, // deterministic permutation for 9 and 18
  })),
});

describe("allocateStrokes properties", () => {
  it("dots always sum to the allocation and differ by at most 1 across holes", () => {
    fc.assert(
      // Floored at 0: strokes are non-negative by construction now (spec 2026-07-29 §2a) and
      // allocateStrokes' give-back branch is deleted, so a negative is no longer a case this
      // property can meaningfully assert.
      fc.property(fc.integer({ min: 0, max: 54 }), fc.constantFrom(9 as const, 18 as const), (n, count) => {
        const dots = allocateStrokes(n, teeSet(count));
        expect(dots.reduce((a, b) => a + b, 0)).toBe(n);
        expect(Math.max(...dots) - Math.min(...dots)).toBeLessThanOrEqual(1);
      }),
    );
  });
});
