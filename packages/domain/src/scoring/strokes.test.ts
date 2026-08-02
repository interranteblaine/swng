import { describe, expect, it } from "vitest";
import type { Hole, TeeSet } from "../course/card.js";
import { allocateStrokes, dotsByHole, netDoubleBogey, netStrokes, roundHalfUp, strokesReceivedOnHole } from "./strokes.js";

// 9 holes; strokeIndex permutation [5,1,9,3,7,8,2,4,6]
const nine: TeeSet = {
  name: "white", rating: 35.8, slope: 128,
  holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 5 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 9 },
    { number: 4, par: 5, yardage: 520, strokeIndex: 3 },
    { number: 5, par: 4, yardage: 400, strokeIndex: 7 },
    { number: 6, par: 3, yardage: 180, strokeIndex: 8 },
    { number: 7, par: 4, yardage: 430, strokeIndex: 2 },
    { number: 8, par: 5, yardage: 490, strokeIndex: 4 },
    { number: 9, par: 4, yardage: 390, strokeIndex: 6 },
  ],
};

describe("roundHalfUp", () => {
  it("rounds .5 upward, including for negatives", () => {
    expect(roundHalfUp(7.6)).toBe(8);
    expect(roundHalfUp(7.5)).toBe(8);
    expect(roundHalfUp(7.4)).toBe(7);
    expect(roundHalfUp(-3.5)).toBe(-3);
  });
});

describe("allocateStrokes", () => {
  it("puts n dots on the n hardest holes", () => {
    // 6 strokes → SI 1..6 → holes 2,7,4,8,1,9 get one dot
    expect(allocateStrokes(6, nine.holes)).toEqual([1, 1, 0, 1, 0, 0, 1, 1, 1]);
  });
  it("wraps past a full lap: 11 on 9 holes = 1 everywhere + extras on SI 1..2", () => {
    expect(allocateStrokes(11, nine.holes)).toEqual([1, 2, 1, 1, 1, 1, 2, 1, 1]);
  });
  it("zero means a clean card", () => {
    expect(allocateStrokes(0, nine.holes)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("dotsByHole", () => {
  it("computes the full hole-number → dots map from one allocateStrokes run", () => {
    // 6 strokes → SI 1..6 → holes 2,7,4,8,1,9 get one dot (same allocation as
    // the allocateStrokes test above, indexed by hole number instead of array position).
    const dots = dotsByHole(6, nine.holes);
    expect(Object.fromEntries(dots)).toEqual({ 1: 1, 2: 1, 3: 0, 4: 1, 5: 0, 6: 0, 7: 1, 8: 1, 9: 1 });
  });
});

describe("strokesReceivedOnHole / netDoubleBogey", () => {
  it("reads a single hole's dots", () => {
    expect(strokesReceivedOnHole(6, nine.holes, 2)).toBe(1);
    expect(strokesReceivedOnHole(6, nine.holes, 3)).toBe(0);
  });
  it("caps a hole at par + 2 + strokes received", () => {
    expect(netDoubleBogey(5, 1)).toBe(8);
    expect(netDoubleBogey(4, 0)).toBe(6);
  });
});

describe("netStrokes", () => {
  it("positive dots (received strokes): net is less than gross", () => {
    expect(netStrokes(5, 1)).toBe(4);
    expect(netStrokes(6, 2)).toBe(4);
  });
  it("zero dots: net equals gross", () => {
    expect(netStrokes(5, 0)).toBe(5);
  });
});

// The back nine of a conventional 18-hole card: stroke indexes 2, 4, 6 … 18. Nothing here is a
// permutation of 1..9, which is exactly what the raw-strokeIndex rule could not handle.
const backNine: readonly Hole[] = [
  { number: 10, par: 4, yardage: 400, strokeIndex: 2 },
  { number: 11, par: 4, yardage: 400, strokeIndex: 4 },
  { number: 12, par: 4, yardage: 400, strokeIndex: 6 },
  { number: 13, par: 4, yardage: 400, strokeIndex: 8 },
  { number: 14, par: 4, yardage: 400, strokeIndex: 10 },
  { number: 15, par: 4, yardage: 400, strokeIndex: 12 },
  { number: 16, par: 4, yardage: 400, strokeIndex: 14 },
  { number: 17, par: 4, yardage: 400, strokeIndex: 16 },
  { number: 18, par: 4, yardage: 400, strokeIndex: 18 },
];

describe("allocateStrokes over a nine drawn out of an eighteen (spec 2026-08-02 §3d)", () => {
  it("gives every typed stroke a hole, ranking the holes played by stroke index", () => {
    // 5 strokes over these nine → the five hardest of THEM: SI 2,4,6,8,10 = holes 10-14.
    expect(allocateStrokes(5, backNine)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0]);
  });

  it("wraps past a full lap the same way", () => {
    // 11 over nine holes → 1 everywhere, plus a second on the two hardest (SI 2 and 4).
    expect(allocateStrokes(11, backNine)).toEqual([2, 2, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("keys dots by the card's own hole numbers, not positions", () => {
    expect(Object.fromEntries(dotsByHole(2, backNine))).toEqual({
      10: 1, 11: 1, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0, 18: 0,
    });
  });

  // The pin that protects every round that has nothing to do with nines: on a full card, rank IS
  // stroke index, so ranking changes no existing number.
  it("is byte-identical to the raw-strokeIndex rule on a full card", () => {
    const raw = (strokes: number, holes: readonly Hole[]) => {
      const base = Math.floor(strokes / holes.length);
      const extra = strokes % holes.length;
      return holes.map(({ strokeIndex }) => base + (strokeIndex <= extra ? 1 : 0));
    };
    for (const strokes of [0, 1, 5, 8, 9, 10, 17, 18, 25, 36]) {
      expect(allocateStrokes(strokes, nine.holes)).toEqual(raw(strokes, nine.holes));
    }
  });
});
