import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { resultOf } from "./result.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann");
const B = golferId("bo");
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
];

describe("resultOf", () => {
  it("settles a complete stroke-play game into its lines", () => {
    const grossGame = { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4],
      [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5],
    });
    const result = resultOf(state!);
    expect(result).toEqual({
      kind: "stroke-play",
      id: gameId("g1"),
      scoring: "gross",
      lines: (state as { lines: unknown }).lines,
    });
  });

  it("returns undefined for a stroke-play game that isn't complete yet", () => {
    const grossGame = { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3],
      [B]: [5, 4],
    });
    expect(resultOf(state!)).toBeUndefined();
  });

  it("settles a closed singles match into its outcome and thru", () => {
    const match = { kind: "singles-match", id: gameId("m1"), a: A, b: B } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 5],
    });
    expect(resultOf(state!)).toEqual({
      kind: "singles-match",
      id: gameId("m1"),
      outcome: { winner: A, closing: "3&2" },
      thru: 7,
    });
  });

  it("returns undefined for a singles match still in progress", () => {
    const match = { kind: "singles-match", id: gameId("m1"), a: A, b: B } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5],
      [B]: [4, 5],
    });
    expect(resultOf(state!)).toBeUndefined();
  });
});
