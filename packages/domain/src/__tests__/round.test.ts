import { describe, it, expect, beforeEach } from "vitest";
import {
  DomainError,
  createRoundConfig,
  createInitialRoundState,
  isValidHoleNumber,
  coursePar,
} from "../index";
import type { RoundConfig, CourseSnapshot, IsoDateTime } from "../index";

function makeCourseSnapshot(par: number[]): CourseSnapshot {
  return {
    courseId: "crs-1",
    name: "Test Course",
    holeCount: par.length,
    teeSets: [
      {
        name: "White",
        color: "#FFFFFF",
        courseRating: 72,
        slopeRating: 113,
        holes: par.map((p, i) => ({
          holeNumber: i + 1,
          par: p,
          yardage: 300 + i * 10,
          handicapIndex: i + 1,
        })),
      },
    ],
  };
}

describe("round module", () => {
  describe("createRoundConfig", () => {
    it("throws when par array is empty", () => {
      const options = {
        roundId: "r2",
        accessCode: "empty",
        course: makeCourseSnapshot([]),
        createdAt: "2025-11-15T17:00:00Z" as IsoDateTime,
      };
      expect(() => createRoundConfig(options)).toThrow(DomainError);
      expect(() => createRoundConfig(options)).toThrow(
        "par array must be non-empty"
      );
    });

    it("builds a valid config", () => {
      const par = [3, 4, 5];
      const course = makeCourseSnapshot(par);
      const options = {
        roundId: "r1",
        accessCode: "code123",
        course,
        createdAt: "2025-11-15T17:00:00Z" as IsoDateTime,
      };
      const config = createRoundConfig(options);
      expect(config.roundId).toBe(options.roundId);
      expect(config.accessCode).toBe(options.accessCode);
      expect(config.course.name).toBe("Test Course");
      expect(coursePar(config.course)).toEqual(par);
      expect(config.course.holeCount).toBe(par.length);
      expect(config.createdAt).toBe(options.createdAt);
    });
  });

  describe("createInitialRoundState", () => {
    it("initializes state correctly", () => {
      const roundId = "r1";
      const createdAt = "2025-11-15T17:05:00Z" as IsoDateTime;
      const state = createInitialRoundState(roundId, createdAt);
      expect(state.roundId).toBe(roundId);
      expect(state.status).toBe("IN_PROGRESS");
      expect(state.stateVersion).toBe(1);
      expect(state.updatedAt).toBe(createdAt);
    });
  });

  describe("isValidHoleNumber", () => {
    let config: RoundConfig;

    beforeEach(() => {
      config = {
        roundId: "r1",
        accessCode: "code",
        createdAt: "2025-11-15T17:00:00Z" as IsoDateTime,
        course: makeCourseSnapshot([4, 4, 4, 4]),
      };
    });

    it("returns true for valid hole numbers", () => {
      expect(isValidHoleNumber(config, 1)).toBe(true);
      expect(isValidHoleNumber(config, config.course.holeCount)).toBe(true);
    });

    it("returns false for invalid hole numbers", () => {
      expect(isValidHoleNumber(config, 0)).toBe(false);
      expect(isValidHoleNumber(config, config.course.holeCount + 1)).toBe(false);
      expect(isValidHoleNumber(config, 2.5)).toBe(false);
    });
  });
});
