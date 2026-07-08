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

  it("settles a complete stableford game into its points", () => {
    const stableford = { kind: "stableford", id: gameId("s1"), players: [A, B] } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [stableford], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(resultOf(state!)).toEqual({
      kind: "stableford",
      id: gameId("s1"),
      points: [
        { golferId: A, points: 15 },
        { golferId: B, points: 19 },
      ],
    });
  });

  it("returns undefined for a stableford game that isn't complete yet", () => {
    const stableford = { kind: "stableford", id: gameId("s1"), players: [A, B] } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [stableford], {
      [A]: [5, 6],
      [B]: [4],
    });
    expect(resultOf(state!)).toBeUndefined();
  });

  it("settles a closed fourball match into its outcome and thru", () => {
    const C = golferId("cal");
    const D = golferId("dee");
    const fourPlayers = [
      ...players,
      { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
      { golferId: D, name: "Dee", tee: "white", courseHandicap: 5 },
    ];
    const fourball = { kind: "fourball-match", id: gameId("f1"), a: [A, B], b: [C, D] } as const;
    const [state] = playGoldenRound(fixtureLinks, fourPlayers, [fourball], {
      [A]: [5, 5, 3, 6, 4, 4, 6, 6],
      [B]: [4, 5, 4, 5, 5, 3, 4, 6],
      [C]: [5, 6, 4, 7, 6, 4, 6, 7],
      [D]: [5, 5, 4, 6, 5, 4, 6, "picked-up"],
    });
    expect(resultOf(state!)).toEqual({
      kind: "fourball-match",
      id: gameId("f1"),
      outcome: { winner: "a", closing: "3&1" },
      thru: 8,
    });
  });

  it("settles a complete skins game into who won what plus the stranded pot", () => {
    const C = golferId("cal");
    const threePlayers = [...players, { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 }];
    const skins = { kind: "skins", id: gameId("k1"), players: [A, B, C] } as const;
    // The end-on-tie golden card from skins.test.ts: h9 ties, stranding a pot of 2.
    const [state] = playGoldenRound(fixtureLinks, threePlayers, [skins], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 5],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(resultOf(state!)).toEqual({
      kind: "skins",
      id: gameId("k1"),
      won: [
        { golferId: A, skins: 6 },
        { golferId: B, skins: 1 },
        { golferId: C, skins: 0 },
      ],
      carriedOut: 2,
    });
  });

  it("returns undefined for a skins game that isn't complete yet", () => {
    const C = golferId("cal");
    const threePlayers = [...players, { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 }];
    const skins = { kind: "skins", id: gameId("k1"), players: [A, B, C] } as const;
    const [state] = playGoldenRound(fixtureLinks, threePlayers, [skins], {
      [A]: [5, 5],
      [B]: [4, 5],
      [C]: [6, 7],
    });
    expect(resultOf(state!)).toBeUndefined();
  });

  it("returns undefined for a fourball match still in progress", () => {
    const C = golferId("cal");
    const D = golferId("dee");
    const fourPlayers = [
      ...players,
      { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
      { golferId: D, name: "Dee", tee: "white", courseHandicap: 5 },
    ];
    const fourball = { kind: "fourball-match", id: gameId("f1"), a: [A, B], b: [C, D] } as const;
    const [state] = playGoldenRound(fixtureLinks, fourPlayers, [fourball], {
      [A]: [5, 5],
      [B]: [4, 5],
      [C]: [5, 6],
      [D]: [5, 5],
    });
    expect(resultOf(state!)).toBeUndefined();
  });
});
