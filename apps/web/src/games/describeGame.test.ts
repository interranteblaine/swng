import { describe, expect, it } from "vitest";
import {
  deviceId,
  fieldDeck18,
  fixtureLinks,
  fixtureLinks18,
  gameId,
  golferId,
  opId,
  playGoldenRoundLog,
  reduceRound,
  scoreGame,
} from "@swng/domain";
import type { CourseCard, GameConfig, GameState, Participant, RoundEvent, RoundState } from "@swng/domain";
import { describeGame } from "./describeGame";

// Builds the same RoundState + scored GameState[] playGoldenRound itself returns, but keeps
// the RoundState around too — describeGame needs it (card for stroke-play's vs-par, games for
// fourball's a/b → golfer-name mapping; see describeGame.ts's own doc comment on why the
// brief's 2-arg sketch grew a third param). Mirrors golden/deck.ts's playGoldenRound verbatim.
const playRound = (
  card: CourseCard,
  participants: readonly Participant[],
  games: readonly GameConfig[],
  scores: Parameters<typeof playGoldenRoundLog>[3],
  corrections: Parameters<typeof playGoldenRoundLog>[4] = [],
): { readonly round: RoundState; readonly states: readonly GameState[] } => {
  const events = playGoldenRoundLog(card, participants, games, scores, corrections, false);
  const round = reduceRound(events);
  return { round, states: round.games.map((config) => scoreGame(config, round)) };
};

const A = golferId("ann"); // normally shoots +8
const B = golferId("bo"); // normally shoots +2
const twoPlayers: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
  { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
];

describe("describeGame — stroke-play", () => {
  const grossGame: GameConfig = { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] };
  const netGame: GameConfig = { kind: "stroke-play", id: gameId("g2"), scoring: "net", players: [A, B] };

  it("in-progress: leader is the lower running total, shown thru N with vs-par of holes played so far", () => {
    // fixtureLinks holes 1-3 par 4+4+3=11; holes 1-2 par 4+4=8 (strokes.test.ts's own card).
    const { round, states } = playRound(fixtureLinks, twoPlayers, [grossGame], { [A]: [4, 5, 3], [B]: [5, 4] });
    // Ann: total 12 thru 3, par 11 -> +1. Bo: total 9 thru 2, par 8 -> +1. Bo's lower total (9) leads.
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stroke play (gross)", line: "Bo 9 thru 2 (+1)" });
  });

  it("decided: leader line omits thru, matching the brief's target format 'Name total (delta)'", () => {
    // strokePlay.test.ts's golden gross card: Ann 39, Bo 41, both complete (fixtureLinks par 36).
    const { round, states } = playRound(fixtureLinks, twoPlayers, [grossGame], {
      [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4],
      [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stroke play (gross)", line: "Ann 39 (+3)" });
  });

  it("exactly even par renders (E), not (+0) or (-0)", () => {
    const evenGame: GameConfig = { kind: "stroke-play", id: gameId("g3"), scoring: "gross", players: [A] };
    // fixtureLinks pars sum to 36 (4+4+3+5+4+3+4+5+4) — shooting exactly par every hole.
    const { round, states } = playRound(fixtureLinks, [twoPlayers[0]!], [evenGame], { [A]: [4, 4, 3, 5, 4, 3, 4, 5, 4] });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stroke play (gross)", line: "Ann 36 (E)" });
  });

  it("net scoring uses the net running total (and its own vs-par), not gross", () => {
    // strokePlay.test.ts's golden net card: Ann net 44 (pickup resolved at net double bogey),
    // Bo net 37 — Bo is the lowest in the field, so he plays off scratch and his net IS his
    // gross, which is also the lower total, so he leads under net scoring.
    const { round, states } = playRound(fixtureLinks, twoPlayers, [netGame], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stroke play (net)", line: "Bo 37 (+1)" });
  });

  it("a tie for the lead lists every tied leader, joined by ' · '", () => {
    const tieGame: GameConfig = { kind: "stroke-play", id: gameId("g4"), scoring: "gross", players: [A, B] };
    const { round, states } = playRound(fixtureLinks, twoPlayers, [tieGame], {
      [A]: [4, 4, 3, 5, 4, 3, 4, 5, 4],
      [B]: [4, 4, 3, 5, 4, 3, 4, 5, 4],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stroke play (gross)", line: "Ann 36 (E) · Bo 36 (E)" });
  });
});

describe("describeGame — stableford", () => {
  const game: GameConfig = { kind: "stableford", id: gameId("s1"), players: [A, B] };

  it("in-progress: every leader is shown, each thru its own N", () => {
    // stableford.test.ts's golden mid-round card: Ann 2pts thru 2, Bo 2pts thru 1 — level on
    // points at different thru counts, so both are leaders.
    const { round, states } = playRound(fixtureLinks, twoPlayers, [game], { [A]: [5, 6], [B]: [4] });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stableford", line: "Ann 2 pts thru 2 · Bo 2 pts thru 1" });
  });

  it("decided: leader line omits thru", () => {
    // stableford.test.ts's golden complete card: Ann 10, Bo 17 — Bo leads.
    const { round, states } = playRound(fixtureLinks, twoPlayers, [game], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stableford", line: "Bo 17 pts" });
  });
});

describe("describeGame — singles-match", () => {
  const match: GameConfig = { kind: "singles-match", id: gameId("m1"), a: A, b: B };
  // singlesMatch.test.ts's own roster for these cards: Ann 14 against Bo 2 is a difference of 12,
  // halved on a nine-hole card, so Ann carries the 6 dots those hole-by-hole narratives assume.
  const matchPlayers: readonly Participant[] = [
    { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 14 } },
    { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
  ];

  it("all square, in-progress: no leader named", () => {
    // h1 halves under singlesMatch.test.ts's golden dots (Ann net 4, Bo net 4).
    const { round, states } = playRound(fixtureLinks, matchPlayers, [match], { [A]: [5], [B]: [4] });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "All square thru 1" });
  });

  it("in-progress with a leader and dormie: the chip line names the leader plainly, no ' · dormie' suffix", () => {
    // singlesMatch.test.ts's golden dormie card: Ann 2 up thru 7, dormie. The dormie GLOSS
    // ("Pat is 2 UP with 2 to play — dormie: ...") lives in GamePanel now, not the chip line.
    const { round, states } = playRound(fixtureLinks, matchPlayers, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 4],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "Ann 2 UP thru 7" });
  });

  it("decided by a wide margin renders 'wins N&M', matching the brief's exact target string", () => {
    // singlesMatch.test.ts's golden 3&2 card.
    const { round, states } = playRound(fixtureLinks, matchPlayers, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 5],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "Ann wins 3&2" });
  });

  it("a match that ends all square renders 'Match halved'", () => {
    // Same corrected card as singlesMatch.test.ts's "ends all square" test (task-2): Ann's h9
    // concession carries an actual (worse) score, which the match compares on its own net
    // rather than an automatic loss — see that file for the hole-by-hole derivation. "conceded"
    // needs a number now, so it's no longer expressible through playRound's FixtureScores
    // shorthand — Ann's h9 is appended as a raw score-recorded event instead, the same way a
    // "cleared" cell already has to be built elsewhere in this codebase.
    const events = playGoldenRoundLog(
      fixtureLinks, matchPlayers, [match],
      { [A]: [5, 5, 4, 6, 4, 4, 5, 6], [B]: [4, 6, 3, 6, 4, 4, 4, 5, 5] },
      [], false,
    );
    const concedeAnnH9: RoundEvent = {
      kind: "score-recorded", golferId: A, hole: 9, result: { kind: "conceded", strokes: 7 },
      opId: opId("concede-ann-h9"), hlc: { wallMs: 9_999, counter: 0, deviceId: deviceId("concede-device") }, authorId: A,
    };
    const round = reduceRound([...events, concedeAnnH9]);
    const states = round.games.map((config) => scoreGame(config, round));
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "Match halved" });
  });
});

describe("describeGame — fourball-match", () => {
  const { players, fourball } = fieldDeck18;

  it("in-progress with a leader: the chip line names the side plainly", () => {
    // Truncate to thru 16 the same way fieldDeck18.test.ts's own `thru` helper does.
    const thru16 = Object.fromEntries(Object.entries(fieldDeck18.scores).map(([g, holes]) => [g, holes.slice(0, 16)]));
    const events16 = playGoldenRoundLog(fixtureLinks18, players, [fourball], thru16, fieldDeck18.corrections, false);
    const round = reduceRound(events16);
    const state = scoreGame(fourball, round);
    expect(describeGame(state, round)).toEqual({ title: "Four-ball", line: "Ann & Bo 1 UP thru 16" });
  });

  it("decided, matches the brief's exact target string", () => {
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball], fieldDeck18.scores, fieldDeck18.corrections, false);
    const round = reduceRound(events);
    const state = scoreGame(fourball, round);
    expect(describeGame(state, round)).toEqual({ title: "Four-ball", line: "Ann & Bo win 1 up" });
  });
});

describe("describeGame — skins", () => {
  const { players, skins } = fieldDeck18;

  it("in-progress with a carry, matches the brief's exact target string", () => {
    const thru16 = Object.fromEntries(Object.entries(fieldDeck18.scores).map(([g, holes]) => [g, holes.slice(0, 16)]));
    const events = playGoldenRoundLog(fixtureLinks18, players, [skins], thru16, fieldDeck18.corrections, false);
    const round = reduceRound(events);
    const state = scoreGame(skins, round);
    expect(describeGame(state, round)).toEqual({ title: "Skins (net)", line: "Bo 5 · Dee 10 · carrying 1 into 17" });
  });

  it("decided: reports the stranded pot as 'carried out', not 'carrying'", () => {
    const events = playGoldenRoundLog(fixtureLinks18, players, [skins], fieldDeck18.scores, fieldDeck18.corrections, false);
    const round = reduceRound(events);
    const state = scoreGame(skins, round);
    expect(describeGame(state, round)).toEqual({ title: "Skins (net)", line: "Bo 5 · Dee 10 · 3 carried out" });
  });

  it("no skins won yet and nothing carrying renders a plain no-op line", () => {
    const events = playGoldenRoundLog(fixtureLinks18, players, [skins], {}, [], false);
    const round = reduceRound(events);
    const state = scoreGame(skins, round);
    expect(describeGame(state, round)).toEqual({ title: "Skins (net)", line: "No skins won yet" });
  });
});
