import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { HoleResult } from "../round/holeResult.js";
import type { RoundEvent } from "../round/events.js";
import type { Participant, RosterEntry } from "../round/participant.js";
import { cellKey, reduceRound } from "../round/state.js";
import type { RoundState } from "../round/state.js";
import { scoreGame } from "./game.js";
import type { GameState } from "./game.js";
import { scoreSinglesMatch } from "./singlesMatch.js";
import { playGoldenRound, playGoldenRoundLog } from "./golden/deck.js";
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

// A minimal one-hole RoundState, isolated from this file's own 14-vs-2 handicap fixture: every
// named golfer states even par, so the game's own stroke allocation
// contributes nothing and the assertion is about the SCORE alone — the shape scoreSinglesMatch
// consumes directly, without threading a card through the whole golden-deck event machinery.
const stateWith = (results: Readonly<Record<string, HoleResult>>): RoundState => ({
  id: roundId("r-conceded"),
  status: "live",
  card: fixtureLinks,
  participants: Object.keys(results).map((name): RosterEntry => ({ golferId: golferId(name), name, tee: "white", basis: { kind: "normally-shoots", overPar: 0 }, strokes: 0 })),
  games: [match],
  cells: Object.fromEntries(
    Object.entries(results).map(([name, result], index) => [
      cellKey(golferId(name), 1),
      { result, recordedBy: golferId(name), hlc: { wallMs: index, counter: 0, deviceId: deviceId("stateWith") }, opId: opId(`op-${name}`) },
    ]),
  ),
  terminatedGameIds: new Set(),
});

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

  // Behaviour-flipped (task-2, spec §2d): this test used to assert the OLD, reversed semantics —
  // "a conceded hole is lost [outright, regardless of score]". That's no longer true: a conceded
  // hole scores at the number it carries, same as `strokes` (see the new test just below). No
  // number for Ann's old bare "conceded" literal could preserve THAT subject (auto-loss is gone),
  // so this is rewritten, not just re-numbered — it keeps its OTHER subject, that a match can end
  // all square, via a concession whose claimed number decides the hole on its own merits.
  //
  // "conceded" is no longer expressible through FixtureScores (its arm now requires a strokes
  // number — golden/deck.ts), so Ann's h9 is appended as a raw score-recorded event after the
  // rest of the card, the same way a "cleared" cell already has to be (see e.g. skins.test.ts's
  // "a cleared cell re-opens the hole").
  it("a conceded hole scores at the number it carries — and a match can still end all square", () => {
    // Hole-by-hole (Ann's dots on 1,2,4,7,8,9): h1 halve (net 4/4), h2 Ann (4/6), h3 Bo (4/3),
    // h4 Ann (5/6), h5 halve (4/4), h6 halve (4/4), h7 halve (4/4), h8 halve (5/5) — Ann 2 wins,
    // Bo 1, five halves thru 8. h9: Ann concedes a 7 (dotted net 6) against Bo's actual 5 (net
    // 5, Bo plays off scratch) — Bo's lower NUMBER wins the hole, not an automatic concession
    // loss — bringing Bo to 2 wins too: 2-2 levels the match.
    const log = playGoldenRoundLog(
      fixtureLinks, players, [match],
      { [A]: [5, 5, 4, 6, 4, 4, 5, 6], [B]: [4, 6, 3, 6, 4, 4, 4, 5, 5] },
      [], false,
    );
    const concedeAnnH9: RoundEvent = {
      kind: "score-recorded", golferId: A, hole: 9, result: { kind: "conceded", strokes: 7 },
      opId: opId("concede-ann-h9"), hlc: { wallMs: 9_999, counter: 0, deviceId: deviceId("concede-device") }, authorId: A,
    };
    const state = reduceRound([...log, concedeAnnH9]);
    const [gameState] = state.games.map((config) => scoreGame(config, state));
    expect(gameState).toMatchObject({ kind: "singles-match", up: 0, thru: 9, remaining: 0, outcome: { halved: true } });
  });

  it("scores a conceded hole at the number it carries — you made the 4, so you win the hole", () => {
    const state = stateWith({ ann: { kind: "strokes", strokes: 5 }, bo: { kind: "conceded", strokes: 4 } });
    const gameState = scoreSinglesMatch(match, state) as GameState & { kind: "singles-match" };
    expect(gameState.leader).toBe(B);
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
