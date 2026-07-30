import { describe, expect, it } from "vitest";
import { deviceId, fixtureLinks, gameId, golferId, opId, reduceRound, roundId, scoreGame } from "@swng/domain";
import type { GameConfig, HoleResult, OpId, RoundEvent } from "@swng/domain";
import { foldAndScore } from "./scoring.js";

const ROUND_ID = roundId("round-1");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");
const SERVER_DEVICE = deviceId("server");

const toResult = (score: number): HoleResult => ({ kind: "strokes", strokes: score });

// A small round log — round-created + both golfers + a stableford game + nine holes each —
// built from domain primitives (the client may import only @swng/domain + @swng/contracts),
// mirroring session.test.ts's own buildServerLog.
const buildLog = (extraGames: readonly GameConfig[] = []): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`op-${(opCounter += 1)}`);

  const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN_ID, BO_ID] };

  const annScores = [4, 5, 3, 6, 4, 5, 4, 5, 4];
  const boScores = [5, 4, 4, 5, 3, 6, 4, 4, 5];

  const events: RoundEvent[] = [
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", strokes: 3 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: BO_ID, name: "Bo", tee: "white", strokes: 0 }, authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: stableford, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    ...extraGames.map((config): RoundEvent => ({ kind: "game-added", config, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() })),
  ];
  for (let hole = 1; hole <= 9; hole += 1) {
    events.push({ kind: "score-recorded", golferId: ANN_ID, hole, result: toResult(annScores[hole - 1]!), authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() });
    events.push({ kind: "score-recorded", golferId: BO_ID, hole, result: toResult(boScores[hole - 1]!), authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() });
  }
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
};

describe("foldAndScore — the read-only cousin of RoundSession's live fold", () => {
  it("folds an event log and scores its games identically to reduceRound + scoreGame", () => {
    const events = buildLog();
    const { state, games } = foldAndScore(events);

    // Same state the domain fold produces — foldAndScore adds no transformation of its own.
    expect(state).toEqual(reduceRound(events));

    // Same scored games the live session would render: reduceRound → scoreGame, per game.
    const expected = state.games.map((config) => scoreGame(config, state));
    expect(games).toEqual(expected);

    const stableford = games.find((game) => game.kind === "stableford");
    expect(stableford?.kind).toBe("stableford");
  });

  it("filters an unknown/future game kind out of the scored games rather than throwing", () => {
    const unknownGame = { kind: "wolf-9000", id: gameId("game-unknown") } as unknown as GameConfig;
    const events = buildLog([unknownGame]);

    let games: ReturnType<typeof foldAndScore>["games"] = [];
    expect(() => {
      games = foldAndScore(events).games;
    }).not.toThrow();

    const kinds = games.map((game) => game.kind);
    expect(kinds).toContain("stableford");
    expect(kinds).not.toContain("wolf-9000");
  });

  it("throws (via reduceRound's genesis check) on a log with no round-created event", () => {
    expect(() => foldAndScore([])).toThrow();
  });
});
