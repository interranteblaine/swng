import { describe, it, expect } from "vitest";
import type { RoundSnapshot } from "@swng/domain";
import {
  buildScoreIndex,
  computeInFromIndex,
  computeOutFromIndex,
  computeParTotal,
  computeTotalFromIndex,
  formatRelative,
  sortPlayersByTotalFromIndex,
} from "./roundCalcs";

function makeSnapshot(): RoundSnapshot {
  const now = new Date().toISOString();
  const par = [
    4,
    3,
    4,
    4,
    5,
    3,
    4,
    5,
    4, // Out
    4,
    4,
    3,
    5,
    4,
    4,
    3,
    5,
    4, // In
  ];
  return {
    config: {
      roundId: "r1",
      accessCode: "ABCD",
      courseName: "Course",
      holes: 18,
      par,
      createdAt: now,
    },
    state: {
      roundId: "r1",
      status: null,
      stateVersion: 1,
      updatedAt: now,
    },
    players: [
      {
        roundId: "r1",
        playerId: "p1",
        name: "Alice",
        color: "Blue",
        joinedAt: now,
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p2",
        name: "Bob",
        color: "White",
        joinedAt: now,
        updatedAt: now,
      },
    ],
    scores: [
      // Alice: holes 1..9
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 1,
        strokes: 4,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 2,
        strokes: 3,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 3,
        strokes: 5,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 4,
        strokes: 4,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 5,
        strokes: 6,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 6,
        strokes: 3,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 7,
        strokes: 4,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 8,
        strokes: 6,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 9,
        strokes: 4,
        updatedBy: "p1",
        updatedAt: now,
      },
      // Alice: holes 10..12 only (partial back nine)
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 10,
        strokes: 5,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 11,
        strokes: 4,
        updatedBy: "p1",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p1",
        holeNumber: 12,
        strokes: 3,
        updatedBy: "p1",
        updatedAt: now,
      },

      // Bob: fewer scores to test sorting with partials
      {
        roundId: "r1",
        playerId: "p2",
        holeNumber: 1,
        strokes: 5,
        updatedBy: "p2",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p2",
        holeNumber: 2,
        strokes: 4,
        updatedBy: "p2",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p2",
        holeNumber: 3,
        strokes: 4,
        updatedBy: "p2",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p2",
        holeNumber: 4,
        strokes: 5,
        updatedBy: "p2",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p2",
        holeNumber: 5,
        strokes: 6,
        updatedBy: "p2",
        updatedAt: now,
      },
      {
        roundId: "r1",
        playerId: "p2",
        holeNumber: 6,
        strokes: 3,
        updatedBy: "p2",
        updatedAt: now,
      },
    ],
  };
}

describe("roundCalcs helpers", () => {
  it("computes Out, In, and Total with partial data", () => {
    const snapshot = makeSnapshot();
    const index = buildScoreIndex(snapshot);

    // Alice Out: 4+3+5+4+6+3+4+6+4 = 39
    expect(computeOutFromIndex(index, "p1")).toBe(39);
    // Alice In (10..18): 5+4+3 + rest missing = 12
    expect(computeInFromIndex(index, "p1")).toBe(12);
    expect(computeTotalFromIndex(index, "p1")).toBe(51);

    // Bob Out: 5+4+4+5+6+3 = 27 (holes 7..9 missing)
    expect(computeOutFromIndex(index, "p2")).toBe(27);
    // Bob In: none entered
    expect(computeInFromIndex(index, "p2")).toBe(0);
    expect(computeTotalFromIndex(index, "p2")).toBe(27);
  });

  it("computes Par total for 18 holes", () => {
    const snapshot = makeSnapshot();
    expect(computeParTotal(snapshot)).toBe(
      snapshot.config.par.slice(0, 18).reduce((a, b) => a + b, 0)
    );
  });

  it("formats relative to par correctly", () => {
    expect(formatRelative(0)).toBe("E");
    expect(formatRelative(3)).toBe("+3");
    expect(formatRelative(-2)).toBe("-2");
  });

  it("sorts players ascending by Total; partial totals included", () => {
    const snapshot = makeSnapshot();
    const index = buildScoreIndex(snapshot);

    const sorted = sortPlayersByTotalFromIndex(index, snapshot.players);
    // Totals: p2=27, p1=51, so Bob first.
    expect(sorted.map((p) => p.playerId)).toEqual(["p2", "p1"]);
  });
});
