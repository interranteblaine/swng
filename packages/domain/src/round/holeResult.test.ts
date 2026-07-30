import { describe, expect, it } from "vitest";
import { scoredStrokes } from "./holeResult.js";

// The ONE accessor for "does this result carry a number, and what is it" — every engine and the
// card itself route through this instead of hand-rolling `kind === "strokes"` at each call site.
describe("scoredStrokes", () => {
  it("answers a strokes cell with its own number", () => {
    expect(scoredStrokes({ kind: "strokes", strokes: 5 })).toBe(5);
  });

  it("answers undefined for picked-up — the one kind with no number", () => {
    expect(scoredStrokes({ kind: "picked-up" })).toBeUndefined();
  });

  it("answers undefined for cleared", () => {
    expect(scoredStrokes({ kind: "cleared" })).toBeUndefined();
  });
});
