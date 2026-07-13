import type { GameId, GolferId } from "../ids.js";
import { DomainError } from "../errors.js";
import type { RoundState } from "../round/state.js";
import { scoreFourballMatch } from "./fourballMatch.js";
import { scoreSinglesMatch } from "./singlesMatch.js";
import { scoreSkins } from "./skins.js";
import { scoreStableford } from "./stableford.js";
import { scoreStrokePlay } from "./strokePlay.js";

// The framework every game format plugs into: a GameConfig (frozen at game-added
// time, replayed from the event log) scores against the folded RoundState to
// produce a GameState — the thing views render and settlement consumes.
export type GameConfig =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly players: readonly GolferId[]; readonly allowance?: number }
  | { readonly kind: "singles-match"; readonly id: GameId; readonly a: GolferId; readonly b: GolferId; readonly allowance?: number }
  | { readonly kind: "stableford"; readonly id: GameId; readonly players: readonly GolferId[]; readonly allowance?: number }
  | { readonly kind: "fourball-match"; readonly id: GameId; readonly a: readonly [GolferId, GolferId]; readonly b: readonly [GolferId, GolferId]; readonly allowance?: number }
  | { readonly kind: "skins"; readonly id: GameId; readonly players: readonly GolferId[]; readonly allowance?: number };

// A game as configured before the server assigns its GameId — what a client sends when
// adding a game to a round. Distributive
// (via the `G extends GameConfig` indirection) so it stays a 5-arm union of id-less variants
// rather than collapsing to the common-fields-only shape a plain `Omit<GameConfig, "id">`
// would produce over a discriminated union.
export type GameConfigDraft = GameConfig extends infer G ? (G extends GameConfig ? Omit<G, "id"> : never) : never;

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

export interface SkinsLine {
  readonly golferId: GolferId;
  readonly skins: number;
}

export type MatchOutcome = { readonly winner: GolferId; readonly closing: string } | { readonly halved: true };

// Fourball's sides are pairs, not individuals, so its outcome/leader stay in the
// ladder's "a"/"b" vocabulary rather than resolving to a single GolferId like
// singles-match's MatchOutcome does.
export type FourballOutcome = { readonly winner: "a" | "b"; readonly closing: string } | { readonly halved: true };

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
  | { readonly kind: "stableford"; readonly id: GameId; readonly lines: readonly StablefordLine[]; readonly complete: boolean }
  | {
      readonly kind: "fourball-match";
      readonly id: GameId;
      readonly up: number;
      readonly leader?: "a" | "b";
      readonly thru: number;
      readonly remaining: number;
      readonly dormie: boolean;
      readonly outcome?: FourballOutcome;
    }
  | {
      readonly kind: "skins";
      readonly id: GameId;
      readonly lines: readonly SkinsLine[];
      readonly carrying: number; // pot riding into the next undecided hole
      readonly carriedOut: number; // pot stranded after the last hole (complete only)
      readonly complete: boolean;
    };

// Dispatch by kind, not a per-format if/else — each engine owns exactly one entry here.
export const scoreGame = (config: GameConfig, state: RoundState): GameState => {
  switch (config.kind) {
    case "stroke-play":
      return scoreStrokePlay(config, state);
    case "singles-match":
      return scoreSinglesMatch(config, state);
    case "stableford":
      return scoreStableford(config, state);
    case "fourball-match":
      return scoreFourballMatch(config, state);
    case "skins":
      return scoreSkins(config, state);
    default:
      // The union is exhaustive at compile time; this guards runtime inputs that
      // bypass the type system (e.g. deserialized events from an older client).
      throw new DomainError("unknown-game-kind", `no scoring engine for game kind "${(config as { kind: string }).kind}"`);
  }
};
