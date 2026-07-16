import { describe, expect, it } from "vitest";
import { effectiveIndex } from "./golfer.js";

// Precedence (unrated-courses spec §6): the three-number model collapsed to two — `declared`
// (a golfer's own self-maintained index; the old `official` folded into it) overrides
// `computed` (swng's read-time whsIndex from their posted rounds). undefined only when the
// golfer has neither — never a default of 0. effectiveIndex takes the two numbers directly
// (computed never lives on the profile — the web composes the stored declared with the
// separately-fetched whsIndex).
describe("effectiveIndex — precedence: declared over computed", () => {
  it("prefers declared over computed when both are set", () => {
    expect(effectiveIndex({ declared: 10, computed: 8.1 })).toEqual({ value: 10, source: "declared" });
  });

  it("falls back to computed when no declared index is set", () => {
    expect(effectiveIndex({ computed: 8.1 })).toEqual({ value: 8.1, source: "computed" });
  });

  it("uses declared when it is the only number set", () => {
    expect(effectiveIndex({ declared: 10 })).toEqual({ value: 10, source: "declared" });
  });

  it("is undefined when neither declared nor computed is set", () => {
    expect(effectiveIndex({})).toBeUndefined();
  });
});
