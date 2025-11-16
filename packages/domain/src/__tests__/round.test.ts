import { describe, it, expect, beforeEach } from "vitest";
import {
  DomainError,
  createRoundConfig,
  createInitialRoundState,
  isValidHoleNumber,
} from "../index";
import type { RoundConfig, IsoDateTime } from "../index";

describe("round module", () => {
  describe("createRoundConfig", () => {
    it("throws when par array is empty", () => {
      const options = {
        roundId: "r2",
        accessCode: "empty",
        courseName: "Empty Course",
        par: [] as number[],
        createdAt: "2025-11-15T17:00:00Z" as IsoDateTime,
      };
      expect(() => createRoundConfig(options)).toThrow(DomainError);
      expect(() => createRoundConfig(options)).toThrow(
        "par array must be non-empty"
      );
    });

    it("builds a valid config", () => {
      const options = {
        roundId: "r1",
        accessCode: "code123",
        courseName: "Test Course",
        par: [3, 4, 5],
        createdAt: "2025-11-15T17:00:00Z" as IsoDateTime,
      };
      const config = createRoundConfig(options);
      expect(config.roundId).toBe(options.roundId);
      expect(config.accessCode).toBe(options.accessCode);
      expect(config.courseName).toBe(options.courseName);
      expect(config.par).toEqual(options.par);
      expect(config.holes).toBe(options.par.length);
      expect(config.createdAt).toBe(options.createdAt);
    });
  });

  describe("createInitialRoundState", () => {
    it("initializes state correctly", () => {
      const roundId = "r1";
      const createdAt = "2025-11-15T17:05:00Z" as IsoDateTime;
      const state = createInitialRoundState(roundId, createdAt);
      expect(state.roundId).toBe(roundId);
      expect(state.currentHole).toBe(1);
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
        courseName: "Course",
        holes: 4,
        par: [4, 4, 4, 4],
        createdAt: "2025-11-15T17:00:00Z" as IsoDateTime,
      };
    });

    it("returns true for valid hole numbers", () => {
      expect(isValidHoleNumber(config, 1)).toBe(true);
      expect(isValidHoleNumber(config, config.holes)).toBe(true);
    });

    it("returns false for invalid hole numbers", () => {
      expect(isValidHoleNumber(config, 0)).toBe(false);
      expect(isValidHoleNumber(config, config.holes + 1)).toBe(false);
      expect(isValidHoleNumber(config, 2.5)).toBe(false);
    });
  });
});
