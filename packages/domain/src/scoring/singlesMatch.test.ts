import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { Participant } from "../round/participant.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

// Match strokes were ALWAYS the difference between the two, so the ONE rule (spec §3) produces
// the same allocation this file's hand-verified cards were built on — restated in the new model's
// own terms: Ann 14 vs Bo 2 is a difference of 12, halved on a nine-hole card, so Ann gets 6 dots
// on SI 1..6 (holes 1,2,4,7,8,9) and Bo, the lowest in the field, plays off scratch. Drop the
// halving or the relative rule and every net below moves, so these cards pin both.
const A = golferId("ann");
const B = golferId("bo");
const players: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 14 } },
  { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
];
const match = { kind: "singles-match", id: gameId("m1"), a: A, b: B } as const;

describe("singles match — golden cards", () => {
  it("the difference between the two closes it out 3&2", () => {
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

  it("a win sealed on the final hole reads '1 up', not '1&0'", () => {
    // Level thru 8, A wins h9 (dot): net 4 vs 5.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 4, 6, 4, 4, 5, 6, 5],
      [B]: [4, 6, 3, 6, 4, 3, 4, 5, 5],
    });
    expect(state).toMatchObject({ outcome: { winner: A, closing: "1 up" } });
  });

  it("exposes the decided hole trail the ladder consumed — and nothing past the closeout", () => {
    // Same card as the 3&2 test: h1 halve, h2 A, h3 A, h4 halve, h5 A, h6 B, h7 A → closed 3&2.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 5],
    });
    expect(state).toMatchObject({
      holes: [
        { hole: 1, winner: "halved" },
        { hole: 2, winner: "a" },
        { hole: 3, winner: "a" },
        { hole: 4, winner: "halved" },
        { hole: 5, winner: "a" },
        { hole: 6, winner: "b" },
        { hole: 7, winner: "a" },
      ],
    });
  });
});
