import { describe, expect, it } from "vitest";
import { effectiveIndex } from "./golfer.js";

// Precedence table (architecture.md §2 / task-1-brief): official (manually maintained)
// always wins > computed (takes over automatically once computeIndex has enough
// differentials) > declared (a golfer's self-reported starting index). undefined only
// when the golfer has posted no index at all — never a default of 0.
describe("effectiveIndex — precedence: official > computed > declared", () => {
  it("prefers official over computed and declared when all three are set", () => {
    expect(effectiveIndex({ official: 5.2, computed: 8.1, declared: 10 })).toEqual({ value: 5.2, source: "official" });
  });

  it("falls back to computed when no official index is set", () => {
    expect(effectiveIndex({ computed: 8.1, declared: 10 })).toEqual({ value: 8.1, source: "computed" });
  });

  it("falls back to declared when neither official nor computed is set", () => {
    expect(effectiveIndex({ declared: 10 })).toEqual({ value: 10, source: "declared" });
  });

  it("is undefined when the profile carries no handicap at all", () => {
    expect(effectiveIndex({})).toBeUndefined();
  });
});
