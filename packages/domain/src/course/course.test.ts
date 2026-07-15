import { describe, expect, it } from "vitest";
import type { CourseCard, TeeSet } from "./card.js";
import { cardId, courseId, golferId, teeId } from "../ids.js";
import { fixtureWhite, fixtureWhite18 } from "../scoring/golden/fixtureCourse.js";
import { addTeeSet, buildCardRecord, courseCardOf, courseNameKey, createCourse, validateTeeContinuity, verifyTeeSet } from "./course.js";

const ID = courseId("c-1");
const NOW = 1_700_000_000_000;

// fixtureWhite/fixtureWhite18 are already-valid TeeSets shared with the scoring
// golden decks — reusing them here means every invalid-input test below mutates
// exactly one known-good field, rather than each test inventing its own card.
const validTee = (overrides: Partial<TeeSet> = {}): TeeSet => ({ ...fixtureWhite, ...overrides });

describe("createCourse", () => {
  it("creates a course with a single current v1 tee set", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    expect(course.courseId).toBe(ID);
    expect(course.name).toBe("Fixture Links");
    expect(course.teeSets).toHaveLength(1);
    expect(course.teeSets[0]).toMatchObject({
      version: 1,
      status: "current",
      provenance: "community",
      enteredBy: "Ann",
      enteredAtMs: NOW,
      verifications: [],
      tee: fixtureWhite,
    });
  });

  it("defaults provenance to community, but honors an explicit imported", () => {
    const imported = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW, provenance: "imported" });
    expect(imported.teeSets[0]?.provenance).toBe("imported");
  });
});

describe("tee-set validation — invariant table (each violation is a stable DomainError code)", () => {
  const attempt = (tee: TeeSet) => () => createCourse({ courseId: ID, name: "Fixture Links", tee, enteredBy: "Ann", nowMs: NOW });

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
    expect(() => createCourse({ courseId: ID, name: "", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW })).toThrowError(
      expect.objectContaining({ code: "invalid-course-name" }),
    );
    expect(() => createCourse({ courseId: ID, name: "x".repeat(81), tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW })).toThrowError(
      expect.objectContaining({ code: "invalid-course-name" }),
    );
  });
});

describe("addTeeSet — versioning", () => {
  it("a new tee name lands at version 1, alongside the existing current tee", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const blue: TeeSet = { ...fixtureWhite, name: "blue", rating: 72.1, slope: 132 };
    const next = addTeeSet(course, { tee: blue, enteredBy: "Bo", nowMs: NOW + 1 });

    expect(next.teeSets).toHaveLength(2);
    const blueVersion = next.teeSets.find((v) => v.tee.name === "blue");
    expect(blueVersion).toMatchObject({ version: 1, status: "current", enteredBy: "Bo" });
    // The original tee stays current and untouched.
    const whiteVersion = next.teeSets.find((v) => v.tee.name === "white");
    expect(whiteVersion).toMatchObject({ version: 1, status: "current" });
  });

  it("the same tee name revises: prior current becomes superseded, verifications are dropped, version increments", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const verified = verifyTeeSet(course, { teeName: "white", verifierName: "Bo", expectedVersion: 1, nowMs: NOW + 1 });
    expect(verified.teeSets[0]?.verifications).toHaveLength(1);

    const revisedTee: TeeSet = { ...fixtureWhite, rating: 36.2 };
    const revised = addTeeSet(verified, { tee: revisedTee, enteredBy: "Cal", nowMs: NOW + 2 });

    expect(revised.teeSets).toHaveLength(2);
    const superseded = revised.teeSets.find((v) => v.version === 1);
    const current = revised.teeSets.find((v) => v.version === 2);
    expect(superseded).toMatchObject({ status: "superseded", verifications: [{ name: "Bo", atMs: NOW + 1 }] });
    expect(current).toMatchObject({ status: "current", enteredBy: "Cal", tee: revisedTee, verifications: [] });
  });

  it("keeps exactly one current version per tee name after repeated revisions", () => {
    let course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    for (let i = 0; i < 3; i++) {
      course = addTeeSet(course, { tee: { ...fixtureWhite, rating: 35.8 + i }, enteredBy: "Ann", nowMs: NOW + i + 1 });
    }
    const whiteVersions = course.teeSets.filter((v) => v.tee.name === "white");
    expect(whiteVersions).toHaveLength(4); // v1..v4
    expect(whiteVersions.filter((v) => v.status === "current")).toHaveLength(1);
    expect(whiteVersions.find((v) => v.status === "current")?.version).toBe(4);
  });

  it("rejects a case-insensitive collision with an existing current tee name as a NEW name", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const shoutedWhite: TeeSet = { ...fixtureWhite, name: "WHITE" };
    expect(() => addTeeSet(course, { tee: shoutedWhite, enteredBy: "Bo", nowMs: NOW + 1 })).toThrowError(
      expect.objectContaining({ code: "duplicate-tee-name" }),
    );
  });

  it("re-validates the incoming tee set the same as createCourse", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const badTee: TeeSet = { ...fixtureWhite, name: "blue", slope: 200 };
    expect(() => addTeeSet(course, { tee: badTee, enteredBy: "Bo", nowMs: NOW + 1 })).toThrowError(expect.objectContaining({ code: "invalid-slope" }));
  });
});

describe("verifyTeeSet", () => {
  it("attaches a verification to the current version", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const verified = verifyTeeSet(course, { teeName: "white", verifierName: "Bo", expectedVersion: 1, nowMs: NOW + 1 });
    expect(verified.teeSets[0]?.verifications).toEqual([{ name: "Bo", atMs: NOW + 1 }]);
  });

  it("is idempotent: the same verifier name on the same version is a no-op", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const once = verifyTeeSet(course, { teeName: "white", verifierName: "Bo", expectedVersion: 1, nowMs: NOW + 1 });
    const twice = verifyTeeSet(once, { teeName: "white", verifierName: "Bo", expectedVersion: 1, nowMs: NOW + 2 });
    expect(twice.teeSets[0]?.verifications).toHaveLength(1);
    expect(twice.teeSets[0]?.verifications[0]).toEqual({ name: "Bo", atMs: NOW + 1 });
  });

  it("throws unknown-tee-set for a name that was never entered", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    expect(() => verifyTeeSet(course, { teeName: "blue", verifierName: "Bo", expectedVersion: 1, nowMs: NOW + 1 })).toThrowError(
      expect.objectContaining({ code: "unknown-tee-set" }),
    );
  });

  // I1 (M6 closing wave): the core of the fix — a stale expectedVersion is a hard rejection,
  // never a silent transplant onto whatever's current now.
  it("throws tee-set-revised when expectedVersion doesn't match the current version", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const revisedTee: TeeSet = { ...fixtureWhite, rating: 36.2 };
    const revised = addTeeSet(course, { tee: revisedTee, enteredBy: "Bo", nowMs: NOW + 1 });

    expect(() => verifyTeeSet(revised, { teeName: "white", verifierName: "Cal", expectedVersion: 1, nowMs: NOW + 2 })).toThrowError(
      expect.objectContaining({ code: "tee-set-revised" }),
    );
    // The rejected verify must never have mutated anything — v2 stays exactly as addTeeSet
    // left it, still unverified.
    const current = revised.teeSets.find((v) => v.status === "current");
    expect(current).toMatchObject({ version: 2, verifications: [] });
  });
});

describe("courseCardOf", () => {
  it("returns only current versions, in first-entered tee-name order, assignable to CourseCard", () => {
    let course = createCourse({ courseId: ID, name: "Fixture Links", tee: fixtureWhite, enteredBy: "Ann", nowMs: NOW });
    const blue: TeeSet = { ...fixtureWhite, name: "blue", rating: 72.1, slope: 132 };
    course = addTeeSet(course, { tee: blue, enteredBy: "Bo", nowMs: NOW + 1 });
    // Revise "white" AFTER "blue" was entered — first-entered order must still put
    // white first (it was version 1 before blue existed), even though its current
    // version now sits later in the teeSets array.
    const revisedWhite: TeeSet = { ...fixtureWhite, rating: 36.0 };
    course = addTeeSet(course, { tee: revisedWhite, enteredBy: "Ann", nowMs: NOW + 2 });

    // Compile-level invariant: courseCardOf's return type IS CourseCard (no cast).
    const card: CourseCard = courseCardOf(course);
    expect(card.courseName).toBe("Fixture Links");
    expect(card.teeSets.map((t) => t.name)).toEqual(["white", "blue"]);
    expect(card.teeSets[0]).toEqual(revisedWhite);
  });

  it("18-hole tee sets round-trip through courseCardOf unchanged", () => {
    const course = createCourse({ courseId: ID, name: "Fixture Links 18", tee: fixtureWhite18, enteredBy: "Ann", nowMs: NOW });
    const card: CourseCard = courseCardOf(course);
    expect(card).toEqual({ courseName: "Fixture Links 18", teeSets: [fixtureWhite18] });
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
