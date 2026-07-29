import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann"); const B = golferId("bo");
const C = golferId("cal"); const D = golferId("dee");
// Four-ball strokes were ALWAYS relative to the lowest of the four, so the ONE rule (spec §3)
// produces the same allocation this file's hand-verified cards were built on — restated in the new
// model's own terms, and without the 90% discount, which is deleted with the rest of the allowance
// table. Differences from Bo's 2 are 10/0/18/6, halved on a nine-hole card: Ann 5, Bo 0, Cal 9,
// Dee 3 dots. Drop the halving or the relative rule and every net below moves.
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 12 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: C, name: "Cal", tee: "white", courseHandicap: 20 },
  { golferId: D, name: "Dee", tee: "white", courseHandicap: 8 },
];
const game = { kind: "fourball-match", id: gameId("f1"), a: [A, B], b: [C, D] } as const;

describe("fourball match — golden cards", () => {
  it("everyone off the lowest of the four, best ball per side, pickup drops one ball: side A wins 3&1", () => {
    // Relative strokes: Ann 5, Bo 0, Cal 9, Dee 3.
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

  it("a hole where all four are out (picked-up/conceded) halves outright: up unchanged, thru advances through it", () => {
    // Plan rule: a side with no ball halves the hole if the other side has none
    // either. All four cells recorded on h1 (so the hole IS decided), none of them
    // "strokes" — sideBest returns undefined for both a and b, which the winners
    // reducer resolves to "halved" rather than crediting either side. One cell uses
    // "conceded" instead of "picked-up" so that kind also gets its first exercise
    // here (fourballMatch's netFor guards on `kind !== "strokes"`, treating both
    // the same way).
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: ["picked-up"],
      [B]: ["conceded"],
      [C]: ["picked-up"],
      [D]: ["picked-up"],
    });
    expect(state).toMatchObject({ kind: "fourball-match", up: 0, thru: 1, remaining: 8, dormie: false });
  });

  it("exposes the decided hole trail the ladder consumed — from the 3&1 card's own narrative", () => {
    // Reuses the first test's own card and comment: h1–h4 halved (best nets 4/4, 4/4, 3/3,
    // 5/5); h5 A (4 vs 5); h6 halved (3/3); h7 A (4 vs 5); h8 A (Dee picks up, Cal's net 6
    // vs A's best 5) → thru 8, matching that test's `thru: 8` assertion.
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: [5, 5, 3, 6, 4, 4, 6, 6],
      [B]: [4, 5, 4, 5, 5, 3, 4, 6],
      [C]: [5, 6, 4, 7, 6, 4, 6, 7],
      [D]: [5, 5, 4, 6, 5, 4, 6, "picked-up"],
    });
    expect(state).toMatchObject({
      thru: 8,
      holes: [
        { hole: 1, winner: "halved" },
        { hole: 2, winner: "halved" },
        { hole: 3, winner: "halved" },
        { hole: 4, winner: "halved" },
        { hole: 5, winner: "a" },
        { hole: 6, winner: "halved" },
        { hole: 7, winner: "a" },
        { hole: 8, winner: "a" },
      ],
    });
    expect((state as { holes: readonly unknown[] }).holes.length).toBe((state as { thru: number }).thru);
  });
});
