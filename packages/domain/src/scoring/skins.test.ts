import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
// Full handicap (skins allowance 1.0): Ann ch8 → dots all holes but h3 (SI 9);
// Bo ch2 → h2, h7; Cal ch12 → 12 dots, all nine + extras on SI≤3 (h2, h4, h7).
const players3 = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
];
const game = { kind: "skins", id: gameId("k1"), players: [A, B, C] } as const;

describe("skins — golden cards", () => {
  it("carryovers chain, outright net wins the pot, pickup is out: Ann 6, Bo 3", () => {
    // nets — Ann: 4,4,4,5,4,3,4,5,PU  Bo: 4,4,3,6,4,4,3,5,4  Cal: 5,5,3,6,5,4,4,6,5
    // h1 tie(A,B) carry→2; h2 tie(A,B) carry→3; h3 tie(B,C) carry→4; h4 Ann takes 4;
    // h5 tie(A,B) carry→2; h6 Ann takes 2; h7 Bo takes 1; h8 tie(A,B) carry→2; h9 Bo takes 2.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(state).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 0,
      lines: [
        { golferId: A, skins: 6 },
        { golferId: B, skins: 3 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("mid-round: a tie carries, and settlement stops at the first undecided hole", () => {
    // h1 Ann takes 1 (net 3 vs 4/4); h2 tie(A,B at net 4) → pot 1 rides into h3.
    // Ann has no h3 cell, so h3 is undecided and nothing after it settles — Bo's
    // would-be outright h3 win (net 3 vs Cal's 4) must NOT be paid out.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [4, 5],
      [B]: [4, 5, 3],
      [C]: [6, 7, 5],
    });
    expect(state).toMatchObject({
      kind: "skins", complete: false, carrying: 1, carriedOut: 0,
      lines: [
        { golferId: A, skins: 1 },
        { golferId: B, skins: 0 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("every player out of the hole carries the pot", () => {
    // h1 all picked up → the skin carries; h2 Ann takes the doubled pot (net 3 vs 4/4).
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: ["picked-up", 4],
      [B]: ["picked-up", 5],
      [C]: ["picked-up", 6],
    });
    expect(state).toMatchObject({
      kind: "skins", complete: false, carrying: 0, carriedOut: 0,
      lines: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 0 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("a tie on the last hole strands the pot as carriedOut", () => {
    // Same card as the golden test except Bo's h9 gross is 5: h9 is tie(B,C at
    // net 5) with Ann picked up, so the h8 carry plus h9's own skin strands.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 5],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(state).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 2,
      lines: [
        { golferId: A, skins: 6 },
        { golferId: B, skins: 1 },
        { golferId: C, skins: 0 },
      ],
    });
  });
});
