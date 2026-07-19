import { describe, expect, it } from "vitest";
import {
  fieldDeck18,
  fixtureLinks,
  fixtureLinks18,
  gameId,
  golferId,
  playGoldenRoundLog,
  reduceRound,
  scoreGame,
} from "@swng/domain";
import type { CourseCard, GameConfig, GameState, Participant, RoundState } from "@swng/domain";
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

const A = golferId("ann"); // courseHandicap 8
const B = golferId("bo"); // courseHandicap 2
const twoPlayers: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
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
    // strokePlay.test.ts's golden net card: Ann net 39 (pickup resolved at net double bogey),
    // Bo net 35 — Bo's net total is lower, so Bo leads under net scoring even though Ann's
    // gross (39) beats Bo's gross (37).
    const { round, states } = playRound(fixtureLinks, twoPlayers, [netGame], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stroke play (net)", line: "Bo 35 (-1)" });
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

  it("in-progress: leader is the higher points total, shown thru N", () => {
    // stableford.test.ts's golden mid-round card: Ann 3pts thru 2, Bo 2pts thru 1.
    const { round, states } = playRound(fixtureLinks, twoPlayers, [game], { [A]: [5, 6], [B]: [4] });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stableford", line: "Ann 3 pts thru 2" });
  });

  it("decided: leader line omits thru", () => {
    // stableford.test.ts's golden complete card: Ann 15, Bo 19 — Bo leads.
    const { round, states } = playRound(fixtureLinks, twoPlayers, [game], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Stableford", line: "Bo 19 pts" });
  });
});

describe("describeGame — singles-match", () => {
  const match: GameConfig = { kind: "singles-match", id: gameId("m1"), a: A, b: B };

  it("all square, in-progress: no leader named", () => {
    // h1 halves under singlesMatch.test.ts's golden dots (Ann net 4, Bo net 4).
    const { round, states } = playRound(fixtureLinks, twoPlayers, [match], { [A]: [5], [B]: [4] });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "All square thru 1" });
  });

  it("in-progress with a leader and dormie: the chip line names the leader plainly, no ' · dormie' suffix", () => {
    // singlesMatch.test.ts's golden dormie card: Ann 2 up thru 7, dormie. The dormie GLOSS
    // ("Pat is 2 UP with 2 to play — dormie: ...") lives in GamePanel now, not the chip line.
    const { round, states } = playRound(fixtureLinks, twoPlayers, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 4],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "Ann 2 UP thru 7" });
  });

  it("decided by a wide margin renders 'wins N&M', matching the brief's exact target string", () => {
    // singlesMatch.test.ts's golden 3&2 card.
    const { round, states } = playRound(fixtureLinks, twoPlayers, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 5],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "Ann wins 3&2" });
  });

  it("a match that ends all square renders 'Match halved'", () => {
    const { round, states } = playRound(fixtureLinks, twoPlayers, [match], {
      [A]: [5, 5, 4, 6, 4, 4, 5, 6, "conceded"],
      [B]: [4, 6, 3, 6, 4, 4, 4, 5, 5],
    });
    expect(describeGame(states[0]!, round)).toEqual({ title: "Match play", line: "Match halved" });
  });
});

describe("describeGame — fourball-match", () => {
  const { players, fourball } = fieldDeck18;

  it("in-progress with dormie: the chip line names the leader plainly, no ' · dormie' suffix", () => {
    // Truncate to thru 16 the same way fieldDeck18.test.ts's own `thru` helper does.
    const thru16 = Object.fromEntries(Object.entries(fieldDeck18.scores).map(([g, holes]) => [g, holes.slice(0, 16)]));
    const events16 = playGoldenRoundLog(fixtureLinks18, players, [fourball], thru16, fieldDeck18.corrections, false);
    const round = reduceRound(events16);
    const state = scoreGame(fourball, round);
    expect(describeGame(state, round)).toEqual({ title: "Four-ball", line: "Ann & Bo 2 UP thru 16" });
  });

  it("decided, matches the brief's exact target string", () => {
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball], fieldDeck18.scores, fieldDeck18.corrections, false);
    const round = reduceRound(events);
    const state = scoreGame(fourball, round);
    expect(describeGame(state, round)).toEqual({ title: "Four-ball", line: "Ann & Bo win 2&1" });
  });
});

describe("describeGame — skins", () => {
  const { players, skins } = fieldDeck18;

  it("in-progress with a carry, matches the brief's exact target string", () => {
    const thru16 = Object.fromEntries(Object.entries(fieldDeck18.scores).map(([g, holes]) => [g, holes.slice(0, 16)]));
    const events = playGoldenRoundLog(fixtureLinks18, players, [skins], thru16, fieldDeck18.corrections, false);
    const round = reduceRound(events);
    const state = scoreGame(skins, round);
    expect(describeGame(state, round)).toEqual({ title: "Skins", line: "Bo 7 · Dee 8 · carrying 1 into 17" });
  });

  it("decided: reports the stranded pot as 'carried out', not 'carrying'", () => {
    const events = playGoldenRoundLog(fixtureLinks18, players, [skins], fieldDeck18.scores, fieldDeck18.corrections, false);
    const round = reduceRound(events);
    const state = scoreGame(skins, round);
    expect(describeGame(state, round)).toEqual({ title: "Skins", line: "Bo 7 · Dee 8 · 3 carried out" });
  });

  it("no skins won yet and nothing carrying renders a plain no-op line", () => {
    const events = playGoldenRoundLog(fixtureLinks18, players, [skins], {}, [], false);
    const round = reduceRound(events);
    const state = scoreGame(skins, round);
    expect(describeGame(state, round)).toEqual({ title: "Skins", line: "No skins won yet" });
  });
});
