import { describe, it, expect, beforeEach } from "vitest";
import { DomainError } from "../round/error";
import {
  createRoundConfig,
  createInitialRoundState,
  isValidHoleNumber,
  makeRoundSnapshot,
} from "../round/round";
import type {
  RoundConfig,
  RoundState,
  Player,
  Score,
  IsoDateTime,
} from "../round/types";

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

  describe("makeRoundSnapshot", () => {
    it("returns a snapshot identical to input", () => {
      const config: RoundConfig = {
        roundId: "r1",
        accessCode: "code",
        courseName: "Course",
        holes: 2,
        par: [4, 5],
        createdAt: "2025-11-15T17:00:00Z",
      };
      const state: RoundState = {
        roundId: config.roundId,
        currentHole: 2,
        status: "IN_PROGRESS",
        stateVersion: 1,
        updatedAt: "2025-11-15T17:10:00Z",
      };
      const players: Player[] = [
        {
          roundId: config.roundId,
          playerId: "p1",
          name: "Alice",
          color: "red",
          joinedAt: "2025-11-15T17:00:00Z",
          updatedAt: "2025-11-15T17:00:00Z",
        },
      ];
      const scores: Score[] = [
        {
          roundId: config.roundId,
          playerId: "p1",
          holeNumber: 1,
          strokes: 4,
          updatedBy: "p1",
          updatedAt: "2025-11-15T17:10:00Z",
        },
      ];

      const snapshot = makeRoundSnapshot({ config, state, players, scores });
      expect(snapshot).toEqual({ config, state, players, scores });
    });
  });
});
