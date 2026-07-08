import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann"); // courseHandicap 8
const B = golferId("bo");  // courseHandicap 2 → Ann gets 6 dots on SI 1..6 (holes 1,2,4,7,8,9)
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
];
const match = { kind: "singles-match", id: gameId("m1"), a: A, b: B } as const;

describe("singles match — golden cards", () => {
  it("full-difference strokes close it out 3&2", () => {
    // h1 halve(net4/4) h2 A(4/5) h3 A(3/4) h4 halve(5/5) h5 A(4/5) h6 B(4/3) h7 A(4/5) → A 3 up thru 7, 2 to play
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 5],
    });
    expect(state).toMatchObject({
      kind: "singles-match", up: 3, leader: A, thru: 7, remaining: 2, dormie: false,
      outcome: { winner: A, closing: "3&2" },
    });
  });

  it("dormie is called when up equals remaining", () => {
    // Same card thru 6: A 2 up, 3 remaining → not dormie. Add h7 halve → 2 up, 2 remaining → dormie.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 4], // h7: A net 4, B 4 → halve
    });
    expect(state).toMatchObject({ up: 2, leader: A, thru: 7, remaining: 2, dormie: true });
    expect((state as { outcome?: unknown }).outcome).toBeUndefined();
  });

  it("a conceded hole is lost; a match can end all square", () => {
    // Hole-by-hole (Ann's dots on 1,2,4,7,8,9): h1 halve (net 4/4), h2 Ann (4/6),
    // h3 Bo (4/3), h4 Ann (5/6), h5 halve (4/4), h6 halve (4/4), h7 halve (4/4),
    // h8 halve (5/5), h9 Ann concedes → Bo wins → level overall: +1 −1 = 0.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 4, 6, 4, 4, 5, 6, "conceded"],
      [B]: [4, 6, 3, 6, 4, 4, 4, 5, 5],
    });
    expect(state).toMatchObject({ kind: "singles-match", up: 0, thru: 9, remaining: 0, outcome: { halved: true } });
  });

  it("a win sealed on the final hole reads '1 up', not '1&0'", () => {
    // Level thru 8, A wins h9 (dot): net 4 vs 5.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 4, 6, 4, 4, 5, 6, 5],
      [B]: [4, 6, 3, 6, 4, 3, 4, 5, 5],
    });
    expect(state).toMatchObject({ outcome: { winner: A, closing: "1 up" } });
  });
});
