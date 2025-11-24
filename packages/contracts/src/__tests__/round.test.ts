import { describe, it, expect } from "vitest";
import {
  parseCreateRoundRequest,
  parseJoinRoundRequest,
  parseUpdateScoreRequest,
  parsePatchRoundStateRequest,
  parseUpdatePlayerRequest,
} from "../index";

describe("contracts/http/rounds request parsers", () => {
  describe("parseCreateRoundRequest", () => {
    it("accepts a valid payload", () => {
      const res = parseCreateRoundRequest({
        courseName: "Course",
        par: [3, 4, 5],
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.courseName).toBe("Course");
        expect(res.data.par).toEqual([3, 4, 5]);
      }
    });

    it("rejects when required fields are missing or invalid", () => {
      const res = parseCreateRoundRequest({ par: "nope" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.length).toBeGreaterThan(0);
        expect(res.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe("parseJoinRoundRequest", () => {
    it("accepts a valid payload", () => {
      const res = parseJoinRoundRequest({
        accessCode: "ABC123",
        playerName: "Alice",
        color: "#000000",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.accessCode).toBe("ABC123");
        expect(res.data.playerName).toBe("Alice");
        expect(res.data.color).toBe("#000000");
      }
    });

    it("rejects when required fields are missing", () => {
      const res = parseJoinRoundRequest({ accessCode: "ABC123" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(
          res.issues.some((i) => (i.path.join(".") || "") === "playerName")
        ).toBe(true);
      }
    });
  });

  describe("parseUpdateScoreRequest", () => {
    it("accepts a valid payload", () => {
      const res = parseUpdateScoreRequest({
        playerId: "ply_1",
        holeNumber: 1,
        strokes: 3,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.playerId).toBe("ply_1");
        expect(res.data.holeNumber).toBe(1);
        expect(res.data.strokes).toBe(3);
      }
    });

    it("rejects invalid numbers", () => {
      const res = parseUpdateScoreRequest({
        playerId: "ply_1",
        holeNumber: 0,
        strokes: -1,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe("parsePatchRoundStateRequest", () => {
    it("accepts an empty object (all optional)", () => {
      const res = parsePatchRoundStateRequest({});
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toEqual({});
      }
    });

    it("accepts a valid currentHole and status", () => {
      const res = parsePatchRoundStateRequest({
        currentHole: 2,
        status: "IN_PROGRESS",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.currentHole).toBe(2);
        expect(res.data.status).toBe("IN_PROGRESS");
      }
    });

    it("rejects invalid currentHole", () => {
      const res = parsePatchRoundStateRequest({ currentHole: 0 });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe("parseUpdatePlayerRequest", () => {
    it("accepts an empty object (all optional)", () => {
      const res = parseUpdatePlayerRequest({});
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toEqual({});
      }
    });

    it("accepts valid name or color", () => {
      const res = parseUpdatePlayerRequest({ name: "Alice", color: "#123456" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.name).toBe("Alice");
        expect(res.data.color).toBe("#123456");
      }
    });

    it("rejects invalid types", () => {
      const res = parseUpdatePlayerRequest({ name: 123 });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.length).toBeGreaterThan(0);
      }
    });
  });
});
