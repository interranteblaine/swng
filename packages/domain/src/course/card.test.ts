import { describe, expect, it } from "vitest";
import type { TeeSet } from "./card.js";
import { isRated } from "./card.js";
import { fixtureWhite } from "../scoring/golden/fixtureCourse.js";

// isRated is the one predicate every rating/slope-dependent path narrows through
// (unrated-courses spec §3) — a tee is rated iff both rating and slope are set.
describe("isRated", () => {
  it("is true when both rating and slope are set", () => {
    expect(isRated(fixtureWhite)).toBe(true);
  });

  it("is false when neither rating nor slope is set (unrated)", () => {
    const unrated: TeeSet = { name: "unrated", holes: fixtureWhite.holes };
    expect(isRated(unrated)).toBe(false);
  });

  it("is false when only rating is set", () => {
    const oneSet: TeeSet = { name: "partial", rating: 71.1, holes: fixtureWhite.holes };
    expect(isRated(oneSet)).toBe(false);
  });

  it("is false when only slope is set", () => {
    const oneSet: TeeSet = { name: "partial", slope: 129, holes: fixtureWhite.holes };
    expect(isRated(oneSet)).toBe(false);
  });
});
