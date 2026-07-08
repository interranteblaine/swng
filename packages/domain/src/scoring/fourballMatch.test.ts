import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann"); const B = golferId("bo");
const C = golferId("cal"); const D = golferId("dee");
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
  { golferId: D, name: "Dee", tee: "white", courseHandicap: 5 },
];
const game = { kind: "fourball-match", id: gameId("f1"), a: [A, B], b: [C, D] } as const;

describe("fourball match — golden cards", () => {
  it("90% relative strokes, best ball per side, pickup drops one ball: side A wins 3&1", () => {
    // Relative playing hcps: Ann 5, Bo 0, Cal 9, Dee 3.
    // h1–h4 halved (best nets 4/4, 4/4, 3/3, 5/5); h5 A (4 vs 5); h6 halved (3/3);
    // h7 A (4 vs 5); h8: Dee picks up, Cal's net 6 vs A's best 5 → A, 3 up with 1 to play → 3&1.
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: [5, 5, 3, 6, 4, 4, 6, 6],
      [B]: [4, 5, 4, 5, 5, 3, 4, 6],
      [C]: [5, 6, 4, 7, 6, 4, 6, 7],
      [D]: [5, 5, 4, 6, 5, 4, 6, "picked-up"],
    });
    expect(state).toMatchObject({
      kind: "fourball-match", up: 3, leader: "a", thru: 8, remaining: 1, dormie: false,
      outcome: { winner: "a", closing: "3&1" },
    });
  });
});
