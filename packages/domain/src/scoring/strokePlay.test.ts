import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deviceId, gameId, golferId, opId } from "../ids.js";
import type { RoundEvent } from "../round/events.js";
import type { Participant } from "../round/participant.js";
import { reduceRound } from "../round/state.js";
import { scoreGame } from "./game.js";
import { playGoldenRound, playGoldenRoundLog } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";
import { sortedStrokePlayLines } from "./strokePlay.js";
import type { GameState, ScoredStrokePlayLine } from "./game.js";

const A = golferId("ann");
const B = golferId("bo");
const players: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", strokes: 3 },
  { golferId: B, name: "Bo", tee: "white", strokes: 0 },
];

const grossGame = { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } as const;
const netGame = { kind: "stroke-play", id: gameId("g2"), scoring: "net", players: [A, B] } as const;

describe("stroke play — golden cards", () => {
  it("gross: Ann 39, Bo 41, complete", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4],
      [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5],
    });
    // fixtureLinks pars sum to 36 (4+4+3+5+4+3+4+5+4): Ann 39 → +3, Bo 41 → +5.
    // Ann's lower total (39) leads outright.
    expect(state).toMatchObject({
      kind: "stroke-play", complete: true,
      lines: [
        { golferId: A, thru: 9, gross: { total: 39, pickups: 0 }, relativeToPar: 3 },
        { golferId: B, thru: 9, gross: { total: 41, pickups: 0 }, relativeToPar: 5 },
      ],
      leaders: [A],
    });
  });

  it("net with dots and a pickup: Ann nets 44 via net double bogey, Bo nets his gross 37", () => {
    // Stroke play is a MEDAL kind, so each player gets their own roster number — no difference,
    // no anchor (spec 2026-07-30 §3). Bo's typed 0 means no dots and net === gross; Ann's typed 3
    // lands on SI 1..3 (holes 2, 4, 7).
    // Ann picks up on hole 4 (par 5, 1 dot): counts par+2 = 7 net.
    const [state] = playGoldenRound(fixtureLinks, players, [netGame], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    // Net scoring: relativeToPar and the leader are both computed off NET totals (par 36).
    // Ann's nets are 5,5,3,7(pickup),5,4,4,6,5 = 44 → +8; Bo nets his gross 37 → +1, so Bo's
    // lower net total leads — as it also does on gross (37 vs Ann's 39).
    expect(state).toMatchObject({
      kind: "stroke-play", complete: true,
      lines: [
        { golferId: A, thru: 9, gross: { total: 39, pickups: 1 }, net: { total: 44, pickups: 0 }, relativeToPar: 8 },
        { golferId: B, thru: 9, gross: { total: 37, pickups: 0 }, net: { total: 37, pickups: 0 }, relativeToPar: 1 },
      ],
      leaders: [B],
    });
  });

  it("mid-round: totals run over decided holes only, complete=false", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3],
      [B]: [5, 4],
    });
    const lines = (state as GameState & { kind: "stroke-play" }).lines;
    // Par thru holes counted so far: Ann thru 3 (4+4+3=11) → 12-11=+1; Bo thru 2 (4+4=8) → 9-8=+1.
    // Bo's lower total (9 vs 12) leads even though both are +1 to par.
    expect(lines[0]).toMatchObject({ thru: 3, gross: { total: 12, pickups: 0 }, relativeToPar: 1 });
    expect(lines[1]).toMatchObject({ thru: 2, gross: { total: 9, pickups: 0 }, relativeToPar: 1 });
    expect((state as { complete: boolean }).complete).toBe(false);
    expect((state as GameState & { kind: "stroke-play" }).leaders).toEqual([B]);
  });

  it("clearing a scored hole rewinds thru and totals", () => {
    // Score holes 1-3, then clear hole 2 (a later hlc). Stroke play's walk `continue`s over
    // absent cells — a gap is allowed anywhere, not just a dense unscored suffix — so thru
    // counts SCORED holes: hole 3's cell still counts even though hole 2 is now a gap again,
    // matching the walk's ordinary gap semantics rather than stopping at the first gap.
    const log = playGoldenRoundLog(fixtureLinks, players, [grossGame], { [A]: [4, 5, 3] }, [], false);
    const clearH2: RoundEvent = {
      kind: "score-recorded", golferId: A, hole: 2, result: { kind: "cleared" },
      opId: opId("clear-h2"), hlc: { wallMs: 9_999, counter: 0, deviceId: deviceId("clear-device") }, authorId: A,
    };
    const state = reduceRound([...log, clearH2]);
    const [gameState] = state.games.map((config) => scoreGame(config, state));
    const line = (gameState as GameState & { kind: "stroke-play" }).lines.find((l) => l.golferId === A)!;
    // thru 2 (h1 + h3), total 7 (4 + 3) — h2's cleared 5 counted nowhere.
    expect(line).toMatchObject({ thru: 2, gross: { total: 7, pickups: 0 } });
  });

  it("a tie for the lead lists every tied golferId", () => {
    const tieGame = { kind: "stroke-play", id: gameId("g4"), scoring: "gross", players: [A, B] } as const;
    const [state] = playGoldenRound(fixtureLinks, players, [tieGame], {
      [A]: [4, 4, 3, 5, 4, 3, 4, 5, 4],
      [B]: [4, 4, 3, 5, 4, 3, 4, 5, 4],
    });
    expect(state).toMatchObject({ kind: "stroke-play", complete: true, leaders: [A, B] });
  });
});

describe("stroke play — properties", () => {
  // Stroke play is a medal kind, so P's dots are P's own asserted strokes — no anchoring, no
  // subtraction (spec 2026-07-30 §3). Dots are never negative, so P's net can only run at or below
  // P's gross, whatever number the group typed. Q rides along at 0 to keep the game a real
  // two-player card.
  it("net never exceeds gross for a player receiving strokes, with full cards", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 9, maxLength: 9 }),
        fc.integer({ min: 0, max: 18 }),
        (scores, given) => {
          const P = golferId("p");
          const Q = golferId("q");
          const [state] = playGoldenRound(
            fixtureLinks,
            [
              { golferId: P, name: "P", tee: "white", strokes: given },
              { golferId: Q, name: "Q", tee: "white", strokes: 0 },
            ],
            [{ kind: "stroke-play", id: gameId("g"), scoring: "net", players: [P, Q] }],
            { [P]: scores, [Q]: scores },
          );
          const line = (state as GameState & { kind: "stroke-play" }).lines[0]!;
          expect(line.net!.total).toBeLessThanOrEqual(line.gross.total);
        },
      ),
    );
  });
});

// The owner-ruled sort (spec 2026-07-19 §2b), extracted from GamePanel.tsx in task-5's fix round
// (spec 2026-07-30 §10 review) so there is exactly one implementation, called through
// @swng/client rather than hand-sorted per screen.
describe("sortedStrokePlayLines", () => {
  const line = (id: string, relativeToPar: number, thru: number): ScoredStrokePlayLine => ({
    golferId: golferId(id), thru, gross: { total: 0, pickups: 0 }, relativeToPar,
  });

  it("sorts vs-par ascending — the lowest (best) score leads", () => {
    const sorted = sortedStrokePlayLines([line("a", 5, 9), line("b", -2, 9), line("c", 1, 9)]);
    expect(sorted.map((l) => l.golferId)).toEqual([golferId("b"), golferId("c"), golferId("a")]);
  });

  it("breaks a vs-par tie by holes played descending — a thru-0 line never outranks a played one", () => {
    // Both at +0, but "a" hasn't teed off (thru 0) while "b" is thru 9 at even par — "b" leads.
    const sorted = sortedStrokePlayLines([line("a", 0, 0), line("b", 0, 9)]);
    expect(sorted.map((l) => l.golferId)).toEqual([golferId("b"), golferId("a")]);
  });

  it("does not mutate its input array", () => {
    const lines = [line("a", 5, 9), line("b", -2, 9)];
    sortedStrokePlayLines(lines);
    expect(lines.map((l) => l.golferId)).toEqual([golferId("a"), golferId("b")]);
  });
});
