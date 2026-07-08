import type { GameId, GolferId } from "../ids.js";
import { DomainError } from "../errors.js";
import type { GameState, MatchOutcome, StrokePlayLine } from "./game.js";

// The settlement currency every game format reduces to once it's resolved — what
// a scorecard shows when it's over, as opposed to GameState which also carries
// the in-progress shape live views render. This union is the END state across
// M2: this task lands only the members for the formats that exist today
// (stroke-play, singles-match, stableford); Tasks 3-4 each add their member
// (and their resultOf case) alongside their engine.
export type GameResult =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly lines: readonly StrokePlayLine[] }
  | { readonly kind: "singles-match"; readonly id: GameId; readonly outcome: MatchOutcome; readonly thru: number }
  | { readonly kind: "stableford"; readonly id: GameId; readonly points: readonly { readonly golferId: GolferId; readonly points: number }[] };

// A game "resolves" when: stroke-play/stableford's complete === true; a match's
// outcome !== undefined; skins' complete === true. Undefined means keep polling —
// there is no partial GameResult, only the live GameState for in-progress views.
export const resultOf = (state: GameState): GameResult | undefined => {
  switch (state.kind) {
    case "stroke-play":
      return state.complete ? { kind: state.kind, id: state.id, scoring: state.scoring, lines: state.lines } : undefined;
    case "singles-match":
      return state.outcome ? { kind: state.kind, id: state.id, outcome: state.outcome, thru: state.thru } : undefined;
    case "stableford":
      return state.complete
        ? { kind: state.kind, id: state.id, points: state.lines.map(({ golferId, points }) => ({ golferId, points })) }
        : undefined;
    default:
      // The union is exhaustive at compile time; this guards runtime inputs that
      // bypass the type system (e.g. deserialized state from an older client).
      throw new DomainError("unknown-game-kind", `no result mapping for game kind "${(state as { kind: string }).kind}"`);
  }
};
