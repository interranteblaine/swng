import type { GameId, GolferId } from "../ids.js";
import { DomainError } from "../errors.js";
import type { RoundState } from "../round/state.js";
import { scoreSinglesMatch } from "./singlesMatch.js";
import { scoreStableford } from "./stableford.js";
import { scoreStrokePlay } from "./strokePlay.js";

// The framework every game format plugs into: a GameConfig (frozen at game-added
// time, replayed from the event log) scores against the folded RoundState to
// produce a GameState — the thing views render and settlement consumes.
export type GameConfig =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly players: readonly GolferId[]; readonly allowance?: number }
  | { readonly kind: "singles-match"; readonly id: GameId; readonly a: GolferId; readonly b: GolferId; readonly allowance?: number }
  | { readonly kind: "stableford"; readonly id: GameId; readonly players: readonly GolferId[]; readonly allowance?: number };

// pickups > 0 means the total is a running/partial figure, not a completed gross score.
export interface RunningTotal {
  readonly total: number;
  readonly pickups: number;
}

export interface StrokePlayLine {
  readonly golferId: GolferId;
  readonly thru: number;
  readonly gross: RunningTotal;
  readonly net?: RunningTotal;
}

export interface StablefordLine {
  readonly golferId: GolferId;
  readonly thru: number;
  readonly points: number;
}

export type MatchOutcome = { readonly winner: GolferId; readonly closing: string } | { readonly halved: true };

export type GameState =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly lines: readonly StrokePlayLine[]; readonly complete: boolean }
  | {
      readonly kind: "singles-match";
      readonly id: GameId;
      readonly up: number;
      readonly leader?: GolferId;
      readonly thru: number;
      readonly remaining: number;
      readonly dormie: boolean;
      readonly outcome?: MatchOutcome;
    }
  | { readonly kind: "stableford"; readonly id: GameId; readonly lines: readonly StablefordLine[]; readonly complete: boolean };

// Dispatch by kind, not a per-format if/else — each engine owns exactly one entry here.
export const scoreGame = (config: GameConfig, state: RoundState): GameState => {
  switch (config.kind) {
    case "stroke-play":
      return scoreStrokePlay(config, state);
    case "singles-match":
      return scoreSinglesMatch(config, state);
    case "stableford":
      return scoreStableford(config, state);
    default:
      // The union is exhaustive at compile time; this guards runtime inputs that
      // bypass the type system (e.g. deserialized events from an older client).
      throw new DomainError("unknown-game-kind", `no scoring engine for game kind "${(config as { kind: string }).kind}"`);
  }
};
