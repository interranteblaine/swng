import { describe, expect, it } from "vitest";
import type { TeeSet } from "./card.js";
import { cardId, courseId, golferId, teeId } from "../ids.js";
import { fixtureWhite } from "../scoring/golden/fixtureCourse.js";
import { buildCardRecord, courseNameKey, validateCard, validateTeeContinuity } from "./course.js";

// fixtureWhite is an already-valid TeeSet shared with the scoring golden decks — reusing it
// here means every invalid-input test below mutates exactly one known-good field, rather than
// each test inventing its own card.
const validTee = (overrides: Partial<TeeSet> = {}): TeeSet => ({ ...fixtureWhite, ...overrides });

// The per-tee invariant table is now exercised through validateCard (the kept validator every
// card write runs), rather than the deleted M6 createCourse aggregate — the rules and codes are
// identical (validateCard calls validateTeeSet per tee, and validateCourseName once).
describe("card validation — per-tee invariant table (each violation is a stable DomainError code)", () => {
  const attempt = (tee: TeeSet) => () => validateCard({ courseName: "Fixture Links", teeSets: [tee] });

  it("holes length must be 9 or 18", () => {
    expect(attempt(validTee({ holes: fixtureWhite.holes.slice(0, 8) }))).toThrowError(expect.objectContaining({ code: "invalid-hole-count" }));
  });

  it("hole numbers must run 1..N in order", () => {
    const holes = fixtureWhite.holes.map((h, i) => (i === 3 ? { ...h, number: 99 } : h));
    expect(attempt(validTee({ holes }))).toThrowError(expect.objectContaining({ code: "invalid-hole-numbering" }));
  });

  it("strokeIndex must be a permutation of 1..N", () => {
    const holes = fixtureWhite.holes.map((h, i) => (i === 0 ? { ...h, strokeIndex: 1 } : i === 1 ? { ...h, strokeIndex: 1 } : h));
    expect(attempt(validTee({ holes }))).toThrowError(expect.objectContaining({ code: "invalid-stroke-index" }));
  });

  it("par must be within 3..6", () => {
    const holes = fixtureWhite.holes.map((h, i) => (i === 0 ? { ...h, par: 2 } : h));
    expect(attempt(validTee({ holes }))).toThrowError(expect.objectContaining({ code: "invalid-par" }));
  });

  it("yardage must be an integer within 1..800", () => {
    const holes = fixtureWhite.holes.map((h, i) => (i === 0 ? { ...h, yardage: 801 } : h));
    expect(attempt(validTee({ holes }))).toThrowError(expect.objectContaining({ code: "invalid-yardage" }));
  });

  it("yardage must be an integer (no fractional yards)", () => {
    const holes = fixtureWhite.holes.map((h, i) => (i === 0 ? { ...h, yardage: 380.5 } : h));
    expect(attempt(validTee({ holes }))).toThrowError(expect.objectContaining({ code: "invalid-yardage" }));
  });

  it("rating must be within 30..90", () => {
    expect(attempt(validTee({ rating: 29.9 }))).toThrowError(expect.objectContaining({ code: "invalid-rating" }));
    expect(attempt(validTee({ rating: 90.1 }))).toThrowError(expect.objectContaining({ code: "invalid-rating" }));
  });

  it("slope must be an integer within 55..155 (USGA bounds)", () => {
    expect(attempt(validTee({ slope: 54 }))).toThrowError(expect.objectContaining({ code: "invalid-slope" }));
    expect(attempt(validTee({ slope: 156 }))).toThrowError(expect.objectContaining({ code: "invalid-slope" }));
    expect(attempt(validTee({ slope: 128.5 }))).toThrowError(expect.objectContaining({ code: "invalid-slope" }));
  });

  it("tee name must be non-empty", () => {
    expect(attempt(validTee({ name: "" }))).toThrowError(expect.objectContaining({ code: "invalid-tee-name" }));
    expect(attempt(validTee({ name: "   " }))).toThrowError(expect.objectContaining({ code: "invalid-tee-name" }));
  });

  it("tee name must be at most 40 characters", () => {
    expect(attempt(validTee({ name: "x".repeat(41) }))).toThrowError(expect.objectContaining({ code: "invalid-tee-name" }));
  });

  it("course name must be non-empty and at most 80 characters", () => {
    expect(() => validateCard({ courseName: "", teeSets: [fixtureWhite] })).toThrowError(expect.objectContaining({ code: "invalid-course-name" }));
    expect(() => validateCard({ courseName: "x".repeat(81), teeSets: [fixtureWhite] })).toThrowError(expect.objectContaining({ code: "invalid-course-name" }));
  });
});

// Unrated tees exist (unrated-courses spec, Task 1): rating/slope are optional AS A PAIR —
// both present (rated), both absent (unrated), or exactly one present (rejected).
describe("card validation — unrated tees (rating/slope optional as a pair)", () => {
  const attempt = (tee: TeeSet) => () => validateCard({ courseName: "Fixture Links", teeSets: [tee] });

  it("an unrated tee (both rating and slope blank) passes validation", () => {
    const unrated: TeeSet = { name: "unrated", holes: fixtureWhite.holes };
    expect(attempt(unrated)).not.toThrow();
  });

  it("exactly one of rating/slope set throws rating-slope-paired", () => {
    const ratingOnly: TeeSet = { name: "half", rating: 71.1, holes: fixtureWhite.holes };
    const slopeOnly: TeeSet = { name: "half", slope: 129, holes: fixtureWhite.holes };
    expect(attempt(ratingOnly)).toThrowError(expect.objectContaining({ code: "rating-slope-paired" }));
    expect(attempt(slopeOnly)).toThrowError(expect.objectContaining({ code: "rating-slope-paired" }));
  });

  it("a rated tee with out-of-bounds rating still throws invalid-rating", () => {
    expect(attempt(validTee({ rating: 29.9 }))).toThrowError(expect.objectContaining({ code: "invalid-rating" }));
  });

  it("a rated tee with out-of-bounds slope still throws invalid-slope", () => {
    expect(attempt(validTee({ slope: 54 }))).toThrowError(expect.objectContaining({ code: "invalid-slope" }));
  });
});

describe("courseNameKey", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(courseNameKey(" Casa  Verde GC ")).toBe("casa verde gc");
  });

  it("is already-normalized-safe (idempotent)", () => {
    expect(courseNameKey("casa verde gc")).toBe("casa verde gc");
  });

  it("collapses tabs/newlines like any other whitespace run", () => {
    expect(courseNameKey("Pebble\tBeach\nGolf Links")).toBe("pebble beach golf links");
  });
});

const nineHoles = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, par: 4, yardage: 400, strokeIndex: i + 1 }));
const tee = (name: string, id?: string): TeeSet => ({ ...(id ? { teeId: teeId(id) } : {}), name, rating: 71.1, slope: 129, holes: nineHoles });
const base = {
  cardId: cardId("c-1"),
  courseId: courseId("k-1"),
  courseName: "Casa Verde GC",
  enteredBy: { golferId: golferId("g-1"), name: "Blaine" },
  enteredAtMs: 1_000,
};

describe("buildCardRecord", () => {
  it("assembles a record whose card carries source and whose every tee carries its id", () => {
    const record = buildCardRecord({ ...base, teeSets: [tee("white", "t-1"), tee("blue", "t-2")] });
    expect(record.card.source).toEqual({ cardId: base.cardId, courseId: base.courseId });
    expect(record.card.teeSets.map((t) => t.teeId)).toEqual([teeId("t-1"), teeId("t-2")]);
    expect(record.provenance).toBe("community");
    expect(record.supersedes).toBeUndefined();
  });

  it("rejects a tee without an id — stored cards always carry identity", () => {
    expect(() => buildCardRecord({ ...base, teeSets: [tee("white")] })).toThrow(/tee-id/);
  });

  it("rejects duplicate tee ids in one card", () => {
    expect(() => buildCardRecord({ ...base, teeSets: [tee("white", "t-1"), tee("blue", "t-1")] })).toThrowError(
      expect.objectContaining({ code: "duplicate-tee-id" }),
    );
  });

  it("rejects mixed hole counts across tees (mismatched-hole-count)", () => {
    const eighteen = { ...tee("blue", "t-2"), holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, yardage: 400, strokeIndex: i + 1 })) };
    expect(() => buildCardRecord({ ...base, teeSets: [tee("white", "t-1"), eighteen] })).toThrowError(
      expect.objectContaining({ code: "mismatched-hole-count" }),
    );
  });

  it("keeps every M6 per-tee rule — e.g. a non-permutation strokeIndex still throws invalid-stroke-index", () => {
    const bad = { ...tee("white", "t-1"), holes: nineHoles.map((h) => ({ ...h, strokeIndex: 1 })) };
    expect(() => buildCardRecord({ ...base, teeSets: [bad] })).toThrowError(expect.objectContaining({ code: "invalid-stroke-index" }));
  });

  it("rejects case-insensitive duplicate tee names (duplicate-tee-name)", () => {
    expect(() => buildCardRecord({ ...base, teeSets: [tee("White", "t-1"), tee("WHITE", "t-2")] })).toThrowError(
      expect.objectContaining({ code: "duplicate-tee-name" }),
    );
  });
});

describe("validateTeeContinuity", () => {
  const current = buildCardRecord({ ...base, teeSets: [tee("white", "t-1")] }).card;

  it("accepts a kept id, an id-less new tee, and a rename under a kept id", () => {
    expect(() => validateTeeContinuity(current, [tee("whites", "t-1"), tee("blue")])).not.toThrow();
  });

  it("rejects an id the superseded card never had (unknown-tee-id)", () => {
    expect(() => validateTeeContinuity(current, [tee("white", "t-9")])).toThrowError(expect.objectContaining({ code: "unknown-tee-id" }));
  });

  it("rejects the same id submitted twice (duplicate-tee-id)", () => {
    expect(() => validateTeeContinuity(current, [tee("white", "t-1"), tee("blue", "t-1")])).toThrowError(
      expect.objectContaining({ code: "duplicate-tee-id" }),
    );
  });
});
