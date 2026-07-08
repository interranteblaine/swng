import { describe, expect, it } from "vitest";
import type { TeeSet } from "../course/card.js";
import { allocateStrokes, netDoubleBogey, roundHalfUp, strokesReceivedOnHole } from "./strokes.js";

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
    expect(allocateStrokes(6, nine)).toEqual([1, 1, 0, 1, 0, 0, 1, 1, 1]);
  });
  it("wraps past a full lap: 11 on 9 holes = 1 everywhere + extras on SI 1..2", () => {
    expect(allocateStrokes(11, nine)).toEqual([1, 2, 1, 1, 1, 1, 2, 1, 1]);
  });
  it("gives strokes back from the easiest holes for plus handicaps", () => {
    // -2 → SI 9 and 8 → holes 3 and 6 get -1
    expect(allocateStrokes(-2, nine)).toEqual([0, 0, -1, 0, 0, -1, 0, 0, 0]);
  });
  it("zero means a clean card", () => {
    expect(allocateStrokes(0, nine)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("strokesReceivedOnHole / netDoubleBogey", () => {
  it("reads a single hole's dots", () => {
    expect(strokesReceivedOnHole(6, nine, 2)).toBe(1);
    expect(strokesReceivedOnHole(6, nine, 3)).toBe(0);
  });
  it("caps a hole at par + 2 + strokes received", () => {
    expect(netDoubleBogey(5, 1)).toBe(8);
    expect(netDoubleBogey(4, 0)).toBe(6);
  });
});
