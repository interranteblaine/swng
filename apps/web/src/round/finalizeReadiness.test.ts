import { describe, expect, it } from "vitest";
import { cellKey, deviceId, fixtureLinks18, gameId, golferId, opId, roundId, scoreGame } from "@swng/domain";
import type { GameConfig, GameState, RosterEntry, RoundState, ScoreCell } from "@swng/domain";
import { unresolvedGames } from "./finalizeReadiness";

const ANN = golferId("ann");
const PAT = golferId("pat");
const participants: readonly RosterEntry[] = [
  { golferId: ANN, name: "Ann", tee: "white", strokes: 8 },
  { golferId: PAT, name: "Pat", tee: "white", strokes: 2 },
];

let opCounter = 0;
const cell = (result: ScoreCell["result"], recordedBy: typeof ANN): ScoreCell => ({
  result,
  recordedBy,
  hlc: { wallMs: 1, counter: 0, deviceId: deviceId("d") },
  opId: opId(`op-${(opCounter += 1)}`),
});

const stablefordConfig: GameConfig = { kind: "stableford", id: gameId("g-stableford"), players: [ANN, PAT] };
const skinsConfig: GameConfig = { kind: "skins", id: gameId("g-skins"), scoring: "net", players: [ANN, PAT] };

// Ann's fully scored (holes 1-18); Pat only played hole 1 — holes 2-18 unscored for Pat, in
// BOTH games. `fixtureLinks18` is the 18-hole fixture (packages/domain's own fixture).
const cellsWithPatStoppedAtHole1: RoundState["cells"] = {
  ...Object.fromEntries(fixtureLinks18.teeSets[0]!.holes.map((h) => [cellKey(ANN, h.number), cell({ kind: "strokes", strokes: 4 }, ANN)])),
  [cellKey(PAT, 1)]: cell({ kind: "strokes", strokes: 5 }, PAT),
};

const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks18,
  playedAtMs: 1_000,
  participants,
  games: [stablefordConfig],
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

describe("unresolvedGames", () => {
  it("is empty when every game has resolved", () => {
    const cells = Object.fromEntries(
      fixtureLinks18.teeSets[0]!.holes.flatMap((h) => [
        [cellKey(ANN, h.number), cell({ kind: "strokes", strokes: 4 }, ANN)],
        [cellKey(PAT, h.number), cell({ kind: "strokes", strokes: 4 }, PAT)],
      ]),
    );
    const state = baseState({ cells });
    const games: readonly GameState[] = [scoreGame(stablefordConfig, state)];

    expect(unresolvedGames(state, games)).toEqual([]);
  });

  it("names an unresolved game by its own describeGame title, with the missing hole range and golfer", () => {
    const state = baseState({ cells: cellsWithPatStoppedAtHole1 });
    const games: readonly GameState[] = [scoreGame(stablefordConfig, state)];

    const result = unresolvedGames(state, games);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ gameId: stablefordConfig.id, title: "Stableford" });
    expect(result[0]!.missing).toBe("holes 2–18 unscored for Pat");
  });

  it("excludes a terminated game even though its GameState is still unresolved", () => {
    const state = baseState({ cells: cellsWithPatStoppedAtHole1, terminatedGameIds: new Set([stablefordConfig.id]) });
    const games: readonly GameState[] = [scoreGame(stablefordConfig, state)];

    expect(unresolvedGames(state, games)).toEqual([]);
  });

  it("lists multiple unresolved games independently, one per game", () => {
    const state = baseState({ games: [stablefordConfig, skinsConfig], cells: cellsWithPatStoppedAtHole1 });
    const games: readonly GameState[] = [scoreGame(stablefordConfig, state), scoreGame(skinsConfig, state)];

    const result = unresolvedGames(state, games);

    expect(result.map((r) => r.gameId)).toEqual([stablefordConfig.id, skinsConfig.id]);
    expect(result.every((r) => r.missing === "holes 2–18 unscored for Pat")).toBe(true);
  });

  it("groups players who share an identical missing-hole set into one clause", () => {
    // Neither Ann nor Pat has posted anything past hole 1 — both missing holes 2-18 alike.
    const state = baseState({ cells: { [cellKey(ANN, 1)]: cell({ kind: "strokes", strokes: 4 }, ANN), [cellKey(PAT, 1)]: cell({ kind: "strokes", strokes: 5 }, PAT) } });
    const games: readonly GameState[] = [scoreGame(stablefordConfig, state)];

    const result = unresolvedGames(state, games);

    expect(result[0]!.missing).toBe("holes 2–18 unscored for Ann, Pat");
  });

  it("formats a single missing hole without a range dash", () => {
    const holes = fixtureLinks18.teeSets[0]!.holes;
    const cells: RoundState["cells"] = {
      ...Object.fromEntries(holes.map((h) => [cellKey(ANN, h.number), cell({ kind: "strokes", strokes: 4 }, ANN)])),
      ...Object.fromEntries(holes.filter((h) => h.number !== 18).map((h) => [cellKey(PAT, h.number), cell({ kind: "strokes", strokes: 4 }, PAT)])),
    };
    const state = baseState({ cells });
    const games: readonly GameState[] = [scoreGame(stablefordConfig, state)];

    expect(unresolvedGames(state, games)[0]!.missing).toBe("hole 18 unscored for Pat");
  });
});
