import { describe, it, expect } from "vitest";
import {
  DomainError,
  createCourse,
  validateTeeSet,
  teeSetPar,
  findTeeSet,
  toCourseSnapshot,
} from "../index";
import type { TeeSet, TeeHole, IsoDateTime, Course } from "../index";

function makeHoles(count: number): TeeHole[] {
  return Array.from({ length: count }, (_, i) => ({
    holeNumber: i + 1,
    par: [3, 4, 5][i % 3] as 3 | 4 | 5,
    yardage: 150 + i * 20,
    handicapIndex: i + 1,
  }));
}

function makeTeeSet(overrides: Partial<TeeSet> = {}): TeeSet {
  return {
    name: "Blue",
    color: "#0000FF",
    courseRating: 72.1,
    slopeRating: 130,
    holes: makeHoles(9),
    ...overrides,
  };
}

const now = "2025-12-01T00:00:00Z" as IsoDateTime;

function makeCourseOptions(
  overrides: Partial<Parameters<typeof createCourse>[0]> = {}
) {
  return {
    courseId: "crs_1",
    name: "Test Course",
    holeCount: 9 as 9 | 18,
    teeSets: [makeTeeSet()],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("course module", () => {
  describe("createCourse", () => {
    it("creates a valid course", () => {
      const course = createCourse(makeCourseOptions());
      expect(course.courseId).toBe("crs_1");
      expect(course.name).toBe("Test Course");
      expect(course.holeCount).toBe(9);
      expect(course.teeSets).toHaveLength(1);
    });

    it("throws when name is empty", () => {
      expect(() => createCourse(makeCourseOptions({ name: "" }))).toThrow(
        DomainError
      );
      expect(() => createCourse(makeCourseOptions({ name: "  " }))).toThrow(
        "Course name must be non-empty"
      );
    });

    it("throws when holeCount is not 9 or 18", () => {
      expect(() =>
        createCourse(makeCourseOptions({ holeCount: 12 }))
      ).toThrow("Hole count must be 9 or 18");
    });

    it("throws when no tee sets provided", () => {
      expect(() =>
        createCourse(makeCourseOptions({ teeSets: [] }))
      ).toThrow("Course must have at least one tee set");
    });

    it("throws when tee set names are not unique", () => {
      const ts1 = makeTeeSet({ name: "Blue" });
      const ts2 = makeTeeSet({ name: "blue", color: "#0000AA" });
      expect(() =>
        createCourse(makeCourseOptions({ teeSets: [ts1, ts2] }))
      ).toThrow("Tee set names must be unique");
    });

    it("accepts location as optional", () => {
      const course = createCourse(
        makeCourseOptions({ location: "Pebble Beach, CA" })
      );
      expect(course.location).toBe("Pebble Beach, CA");
    });

    it("creates 18-hole course", () => {
      const ts = makeTeeSet({ holes: makeHoles(18) });
      const course = createCourse(
        makeCourseOptions({ holeCount: 18, teeSets: [ts] })
      );
      expect(course.holeCount).toBe(18);
    });
  });

  describe("validateTeeSet", () => {
    it("validates a correct tee set", () => {
      expect(() => validateTeeSet(makeTeeSet(), 9)).not.toThrow();
    });

    it("throws when tee set name is empty", () => {
      expect(() => validateTeeSet(makeTeeSet({ name: "" }), 9)).toThrow(
        "Tee set name must be non-empty"
      );
    });

    it("throws when tee set color is empty", () => {
      expect(() => validateTeeSet(makeTeeSet({ color: "" }), 9)).toThrow(
        "Tee set color must be non-empty"
      );
    });

    it("throws when course rating is out of range", () => {
      expect(() =>
        validateTeeSet(makeTeeSet({ courseRating: 49 }), 9)
      ).toThrow("Course rating must be between 50 and 90");
      expect(() =>
        validateTeeSet(makeTeeSet({ courseRating: 91 }), 9)
      ).toThrow("Course rating must be between 50 and 90");
    });

    it("throws when slope rating is out of range", () => {
      expect(() =>
        validateTeeSet(makeTeeSet({ slopeRating: 54 }), 9)
      ).toThrow("Slope rating must be an integer between 55 and 155");
      expect(() =>
        validateTeeSet(makeTeeSet({ slopeRating: 156 }), 9)
      ).toThrow("Slope rating must be an integer between 55 and 155");
    });

    it("throws when slope rating is not an integer", () => {
      expect(() =>
        validateTeeSet(makeTeeSet({ slopeRating: 130.5 }), 9)
      ).toThrow("Slope rating must be an integer between 55 and 155");
    });

    it("throws when hole count does not match", () => {
      expect(() => validateTeeSet(makeTeeSet(), 18)).toThrow(
        'Tee set "Blue" must have exactly 18 holes, got 9'
      );
    });

    it("throws when hole numbers are incomplete", () => {
      const holes = makeHoles(9);
      holes[0] = { ...holes[0], holeNumber: 10 };
      expect(() => validateTeeSet(makeTeeSet({ holes }), 9)).toThrow(
        "missing hole number"
      );
    });

    it("throws when handicap indices are incomplete", () => {
      const holes = makeHoles(9);
      holes[0] = { ...holes[0], handicapIndex: 10 };
      expect(() => validateTeeSet(makeTeeSet({ holes }), 9)).toThrow(
        "missing handicap index"
      );
    });

    it("throws when par is not 3, 4, or 5", () => {
      const holes = makeHoles(9);
      holes[0] = { ...holes[0], par: 6 };
      expect(() => validateTeeSet(makeTeeSet({ holes }), 9)).toThrow(
        "Par must be 3, 4, or 5"
      );
    });

    it("throws when yardage is not a positive integer", () => {
      const holes = makeHoles(9);
      holes[0] = { ...holes[0], yardage: 0 };
      expect(() => validateTeeSet(makeTeeSet({ holes }), 9)).toThrow(
        "Yardage must be a positive integer"
      );
    });

    it("throws when yardage is not an integer", () => {
      const holes = makeHoles(9);
      holes[0] = { ...holes[0], yardage: 150.5 };
      expect(() => validateTeeSet(makeTeeSet({ holes }), 9)).toThrow(
        "Yardage must be a positive integer"
      );
    });
  });

  describe("teeSetPar", () => {
    it("returns pars sorted by hole number", () => {
      const holes: TeeHole[] = [
        { holeNumber: 3, par: 5, yardage: 500, handicapIndex: 3 },
        { holeNumber: 1, par: 4, yardage: 400, handicapIndex: 1 },
        { holeNumber: 2, par: 3, yardage: 150, handicapIndex: 2 },
      ];
      const ts = makeTeeSet({ holes });
      expect(teeSetPar(ts)).toEqual([4, 3, 5]);
    });
  });

  describe("findTeeSet", () => {
    it("finds tee set case-insensitively", () => {
      const ts = makeTeeSet({ name: "Blue" });
      expect(findTeeSet([ts], "blue")).toBe(ts);
      expect(findTeeSet([ts], "BLUE")).toBe(ts);
    });

    it("returns undefined when not found", () => {
      const ts = makeTeeSet({ name: "Blue" });
      expect(findTeeSet([ts], "Red")).toBeUndefined();
    });
  });

  describe("toCourseSnapshot", () => {
    it("strips timestamps", () => {
      const course: Course = {
        courseId: "crs_1",
        name: "Test Course",
        location: "Somewhere",
        holeCount: 9,
        teeSets: [makeTeeSet()],
        createdAt: now,
        updatedAt: now,
      };
      const snapshot = toCourseSnapshot(course);
      expect(snapshot).toEqual({
        courseId: "crs_1",
        name: "Test Course",
        location: "Somewhere",
        holeCount: 9,
        teeSets: course.teeSets,
      });
      expect(snapshot).not.toHaveProperty("createdAt");
      expect(snapshot).not.toHaveProperty("updatedAt");
    });
  });
});
