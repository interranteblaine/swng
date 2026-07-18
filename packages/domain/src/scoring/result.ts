import type { GameId, GolferId } from "../ids.js";
import { DomainError } from "../errors.js";
import type { FourballOutcome, GameState, MatchOutcome, StrokePlayLine } from "./game.js";

// The settlement currency every game format reduces to once it's resolved — what
// a scorecard shows when it's over, as opposed to GameState which also carries
// the in-progress shape live views render.
export type GameResult =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly lines: readonly StrokePlayLine[] }
  | { readonly kind: "singles-match"; readonly id: GameId; readonly outcome: MatchOutcome; readonly thru: number }
  | { readonly kind: "stableford"; readonly id: GameId; readonly points: readonly { readonly golferId: GolferId; readonly points: number }[] }
  | { readonly kind: "fourball-match"; readonly id: GameId; readonly outcome: FourballOutcome; readonly thru: number }
  | {
      readonly kind: "skins";
      readonly id: GameId;
      readonly won: readonly { readonly golferId: GolferId; readonly skins: number }[];
      // Settlement needs the stranded pot: a last-hole tie leaves skins nobody won,
      // and how the group splits (or rolls) that money is theirs to decide.
      readonly carriedOut: number;
    };

// A game "resolves" when: stroke-play/stableford's complete === true; a match's
// outcome !== undefined; skins' complete === true. Undefined means keep polling —
// there is no partial GameResult, only the live GameState for in-progress views.
export const resultOf = (state: GameState): GameResult | undefined => {
  switch (state.kind) {
    case "stroke-play":
      // Settlement strips the live-only relativeToPar — the settled StrokePlayLine stays lean
      // (see game.ts's ScoredStrokePlayLine doc comment).
      return state.complete
        ? { kind: state.kind, id: state.id, scoring: state.scoring, lines: state.lines.map(({ relativeToPar: _relativeToPar, ...line }) => line) }
        : undefined;
    case "singles-match":
      return state.outcome ? { kind: state.kind, id: state.id, outcome: state.outcome, thru: state.thru } : undefined;
    case "stableford":
      return state.complete
        ? { kind: state.kind, id: state.id, points: state.lines.map(({ golferId, points }) => ({ golferId, points })) }
        : undefined;
    case "fourball-match":
      return state.outcome ? { kind: state.kind, id: state.id, outcome: state.outcome, thru: state.thru } : undefined;
    case "skins":
      return state.complete
        ? { kind: state.kind, id: state.id, won: state.lines.map(({ golferId, skins }) => ({ golferId, skins })), carriedOut: state.carriedOut }
        : undefined;
    default:
      // The union is exhaustive at compile time; this guards runtime inputs that
      // bypass the type system (e.g. deserialized state from an older client).
      throw new DomainError("unknown-game-kind", `no result mapping for game kind "${(state as { kind: string }).kind}"`);
  }
};
