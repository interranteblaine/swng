import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { GameConfig } from "./game.js";
import { gameMembers } from "./game.js";

// The ONE per-kind player-list switch in the domain (round/archive.ts's settleRound
// departure-omission rule and unresolvedGames both call this instead of re-deriving it, and
// apps/web's dots.ts delegates here too rather than keeping its own line-for-line-identical
// copy) — pinned for all five kinds, including singles/fourball (the review finding this task
// closes: only the medal-family kinds had a direct test before this file existed).
const ANN = golferId("ann");
const BO = golferId("bo");
const CAL = golferId("cal");
const DEE = golferId("dee");

describe("gameMembers", () => {
  it("stroke-play: config.players, in order", () => {
    const config: GameConfig = { kind: "stroke-play", id: gameId("g"), scoring: "net", players: [ANN, BO] };
    expect(gameMembers(config)).toEqual([ANN, BO]);
  });

  it("stableford: config.players, in order", () => {
    const config: GameConfig = { kind: "stableford", id: gameId("g"), players: [ANN, BO, CAL] };
    expect(gameMembers(config)).toEqual([ANN, BO, CAL]);
  });

  it("skins: config.players, in order", () => {
    const config: GameConfig = { kind: "skins", id: gameId("g"), scoring: "net", players: [CAL, DEE] };
    expect(gameMembers(config)).toEqual([CAL, DEE]);
  });

  it("singles-match: [a, b]", () => {
    const config: GameConfig = { kind: "singles-match", id: gameId("g"), a: ANN, b: BO };
    expect(gameMembers(config)).toEqual([ANN, BO]);
  });

  it("fourball-match: [...a, ...b]", () => {
    const config: GameConfig = { kind: "fourball-match", id: gameId("g"), a: [ANN, BO], b: [CAL, DEE] };
    expect(gameMembers(config)).toEqual([ANN, BO, CAL, DEE]);
  });
});
