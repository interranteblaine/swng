import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId } from "../ids.js";
import type { RoundEvent } from "../round/events.js";
import type { Participant } from "../round/participant.js";
import { reduceRound } from "../round/state.js";
import { scoreGame } from "./game.js";
import { playGoldenRound, playGoldenRoundLog } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann"); const B = golferId("bo");
const C = golferId("cal"); const D = golferId("dee");
// Four-ball strokes were ALWAYS relative to the lowest of the four, so the ONE rule (spec §3)
// produces the same allocation this file's hand-verified cards were built on — restated in the new
// model's own terms, and without the 90% discount, which is deleted with the rest of the allowance
// table. Differences from Bo's 2 are 10/0/18/6, halved on a nine-hole card: Ann 5, Bo 0, Cal 9,
// Dee 3 dots. Drop the halving or the relative rule and every net below moves.
const players: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 12 } },
  { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
  { golferId: C, name: "Cal", tee: "white", basis: { kind: "normally-shoots", overPar: 20 } },
  { golferId: D, name: "Dee", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
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

  // Behaviour-flipped (task-2, spec §2d): this test used to put a bare "conceded" on Bo's cell
  // to exercise that kind alongside three genuine pickups, on the premise that concede (like
  // pickup) drops a player's ball entirely — "all four are out, so it halves." That premise is
  // now false: a conceded score nets exactly like `strokes` (fourballMatch.ts's netFor), so a
  // side with ONE conceded player still has a ball. No number for Bo's cell could preserve the
  // ORIGINAL subject (a side with no ball at all) while keeping him "conceded" instead of
  // "picked-up" — genuinely emptying a ball now takes picked-up specifically. So this test is
  // narrowed to all-four-picked-up (the true "nobody has a ball" case, its real subject), and a
  // NEW test right after covers what conceded actually does here now: it keeps a side's ball alive.
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

  it("a conceded score keeps its side's ball alive — it beats a side with nobody left in the hole", () => {
    // Side A's Ann is genuinely picked up, but Bo's conceded number gives the side a real net
    // (spec §2d — a conceded score is scored, not out of the hole). Side B is entirely picked
    // up (Cal and Dee both), so it has no ball at all: side A wins the hole outright, not a
    // halve — the "conceded" literal that used to sit in the OLD test above, restored to what
    // it actually does now. ("conceded" needs a number, so it's no longer expressible through
    // FixtureScores — Bo's cell is appended as a raw score-recorded event instead, the same way
    // a "cleared" cell already has to be elsewhere in this codebase.)
    const log = playGoldenRoundLog(fixtureLinks, players, [game], { [A]: ["picked-up"], [C]: ["picked-up"], [D]: ["picked-up"] }, [], false);
    const concedeBoH1: RoundEvent = {
      kind: "score-recorded", golferId: B, hole: 1, result: { kind: "conceded", strokes: 4 },
      opId: opId("concede-bo-h1"), hlc: { wallMs: 9_999, counter: 0, deviceId: deviceId("concede-device") }, authorId: B,
    };
    const state = reduceRound([...log, concedeBoH1]);
    const [gameState] = state.games.map((config) => scoreGame(config, state));
    expect(gameState).toMatchObject({ kind: "fourball-match", up: 1, leader: "a", thru: 1, remaining: 8, dormie: false });
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
