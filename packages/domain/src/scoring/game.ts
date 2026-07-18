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

// The live-scored stroke-play line: StrokePlayLine plus a mid-round "thru N, +3" progress
// figure. This stays OFF the settled StrokePlayLine/GameResult on purpose — relativeToPar is
// a live-standings concern, not a fact of a sealed settlement, and the settled line must stay
// lean so old stored snapshots (no relativeToPar) keep parsing (tolerate-old-data invariant).
export type ScoredStrokePlayLine = StrokePlayLine & {
  // Scored total (net when the game is net-scored, else gross) minus par over the first
  // `thru` holes of the player's own tee — golf's own vs-par notation. Computed here so
  // describeGame (and any other view) never re-derives it from the course card.
  readonly relativeToPar: number;
};

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
  | {
      readonly kind: "stroke-play";
      readonly id: GameId;
      readonly scoring: "gross" | "net";
      readonly lines: readonly ScoredStrokePlayLine[];
      readonly complete: boolean;
      // The golferId(s) at the lowest total (net when net-scored, else gross), ties included —
      // plural because medal play (unlike match play's single opponent) can tie for the lead.
      // Named distinctly from match-play's singular `leader` so the two never collide.
      readonly leaders: readonly GolferId[];
    }
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
  | {
      readonly kind: "stableford";
      readonly id: GameId;
      readonly lines: readonly StablefordLine[];
      readonly complete: boolean;
      // The golferId(s) at the highest points, ties included — see stroke-play's `leaders` doc.
      readonly leaders: readonly GolferId[];
    }
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
      // Count of holes decided so far (every player recorded a cell, in card order, stopping
      // at the first gap) — the same walk carrying/carriedOut settle over. Lets a view name
      // which hole a live carry is riding into (holesDecided + 1) without replaying the walk.
      readonly holesDecided: number;
    };

// Every golferId a game config references — the union across all five kinds' player fields
// (players[] for the medal family, a/b for singles, the two pairs for fourball). Exhaustive by
// kind — a new game kind must add its own arm here (TS flags the missing return path). The ONE
// implementation: settleRound's departure-omission rule and the finalize-readiness view
// (round/archive.ts) both call this rather than each re-deriving the same per-kind switch.
export const gameMembers = (config: GameConfig): readonly GolferId[] => {
  switch (config.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return config.players;
    case "singles-match":
      return [config.a, config.b];
    case "fourball-match":
      return [...config.a, ...config.b];
  }
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
