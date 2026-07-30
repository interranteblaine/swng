import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { Participant } from "../round/participant.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann"); const B = golferId("bo");
const C = golferId("cal"); const D = golferId("dee");
// Four-ball is a MATCH kind: everyone plays off the lowest of the four (spec 2026-07-30 §3). The
// roster numbers here are 5/0/9/3, and Bo is already the lowest, so the difference leaves them
// unchanged — the same dots this file's hand-verified cards were built on. Drop the relative rule
// and nothing here moves; raise Bo above 0 and everything does, which is why the relative arm is
// pinned in allocation.test.ts instead.
const players: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", strokes: 5 },
  { golferId: B, name: "Bo", tee: "white", strokes: 0 },
  { golferId: C, name: "Cal", tee: "white", strokes: 9 },
  { golferId: D, name: "Dee", tee: "white", strokes: 3 },
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

  it("a hole where all four are picked up halves outright: up unchanged, thru advances through it", () => {
    // All four cells recorded on h1 (so the hole IS decided), all of them picked-up — sideBest
    // returns undefined for both a and b, which the winners reducer resolves to "halved" rather
    // than crediting either side.
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: ["picked-up"],
      [B]: ["picked-up"],
      [C]: ["picked-up"],
      [D]: ["picked-up"],
    });
    expect(state).toMatchObject({ kind: "fourball-match", up: 0, thru: 1, remaining: 8, dormie: false });
  });

  it("a real score keeps its side's ball alive — it beats a side with nobody left in the hole", () => {
    // Side A's Ann is picked up, but Bo's real score gives the side a net to compete with. Side
    // B is entirely picked up (Cal and Dee both), so it has no ball at all: side A wins the hole
    // outright, not a halve.
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: ["picked-up"],
      [B]: [4],
      [C]: ["picked-up"],
      [D]: ["picked-up"],
    });
    expect(state).toMatchObject({ kind: "fourball-match", up: 1, leader: "a", thru: 1, remaining: 8, dormie: false });
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
