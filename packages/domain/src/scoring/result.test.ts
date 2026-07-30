import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { Participant } from "../round/participant.js";
import type { GameState } from "./game.js";
import { resultOf } from "./result.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann");
const B = golferId("bo");
const players: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
  { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
];

describe("resultOf", () => {
  it("settles a complete stroke-play game into its lines", () => {
    const grossGame = { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4],
      [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5],
    });
    const result = resultOf(state!);
    // Settlement strips the live-only relativeToPar (game.ts's ScoredStrokePlayLine doc
    // comment) — mirror that stripping here rather than comparing against the raw state lines.
    const liveLines = (state as { lines: readonly { relativeToPar: number }[] }).lines;
    expect(result).toEqual({
      kind: "stroke-play",
      id: gameId("g1"),
      scoring: "gross",
      lines: liveLines.map(({ relativeToPar: _relativeToPar, ...line }) => line),
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
    // singlesMatch.test.ts's own 3&2 roster: Ann 14 against Bo 2 is a difference of 12, halved on a
    // nine-hole card, so Ann carries the same 6 dots that card's hole-by-hole narrative was built on.
    const matchPlayers: readonly Participant[] = [
      { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 14 } },
      { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
    ];
    const [state] = playGoldenRound(fixtureLinks, matchPlayers, [match], {
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
      // stableford.test.ts's own hand-derived figures for this card and roster.
      points: [
        { golferId: A, points: 10 },
        { golferId: B, points: 17 },
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
    // fourballMatch.test.ts's own 3&1 roster: differences from Bo's 2 are 10/0/18/6, halved on a
    // nine-hole card, so the four carry the same 5/0/9/3 dots that card's narrative was built on.
    const fourPlayers: readonly Participant[] = [
      { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 12 } },
      { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
      { golferId: C, name: "Cal", tee: "white", basis: { kind: "normally-shoots", overPar: 20 } },
      { golferId: D, name: "Dee", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
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
    const threePlayers: readonly Participant[] = [...players, { golferId: C, name: "Cal", tee: "white", basis: { kind: "normally-shoots", overPar: 12 } }];
    const skins = { kind: "skins", id: gameId("k1"), scoring: "net", players: [A, B, C] } as const;
    // The end-on-tie golden card from skins.test.ts: h9 ties (Bo and Cal both net 5), stranding 1.
    const [state] = playGoldenRound(fixtureLinks, threePlayers, [skins], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 5],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 5],
    });
    expect(resultOf(state!)).toEqual({
      kind: "skins",
      id: gameId("k1"),
      won: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 6 },
        { golferId: C, skins: 0 },
      ],
      carriedOut: 1,
    });
  });

  it("returns undefined for a skins game that isn't complete yet", () => {
    const C = golferId("cal");
    const threePlayers: readonly Participant[] = [...players, { golferId: C, name: "Cal", tee: "white", basis: { kind: "normally-shoots", overPar: 12 } }];
    const skins = { kind: "skins", id: gameId("k1"), scoring: "net", players: [A, B, C] } as const;
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
    const fourPlayers: readonly Participant[] = [
      ...players,
      { golferId: C, name: "Cal", tee: "white", basis: { kind: "normally-shoots", overPar: 12 } },
      { golferId: D, name: "Dee", tee: "white", basis: { kind: "normally-shoots", overPar: 5 } },
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

  it("settled match results carry no live hole trail — the wire stays lean", () => {
    const singles: GameState = {
      kind: "singles-match", id: gameId("m-lean"), up: 1, leader: golferId("a1"),
      thru: 9, remaining: 0, dormie: false,
      outcome: { winner: golferId("a1"), closing: "1 up" },
      holes: [{ hole: 1, winner: "a" }],
    };
    expect(resultOf(singles)).not.toHaveProperty("holes");

    const fourball: GameState = {
      kind: "fourball-match", id: gameId("f-lean"), up: 2, leader: "a",
      thru: 9, remaining: 0, dormie: false,
      outcome: { winner: "a", closing: "2 up" },
      holes: [{ hole: 1, winner: "a" }],
    };
    expect(resultOf(fourball)).not.toHaveProperty("holes");
  });

  it("a settled skins result carries no live hole trail", () => {
    const skins: GameState = {
      kind: "skins", id: gameId("k-lean"), scoring: "net",
      lines: [{ golferId: golferId("a1"), skins: 1 }],
      carrying: 0, carriedOut: 0, complete: true, holesDecided: 9,
      holes: [{ hole: 1, winner: golferId("a1"), pot: 1 }],
    };
    expect(resultOf(skins)).not.toHaveProperty("holes");
    // The gross/net choice skins gained is live-GameState only, like the trail: resultOf builds
    // the settled result from named fields, so the settled wire is byte-unchanged by it.
    expect(resultOf(skins)).not.toHaveProperty("scoring");
  });
});
