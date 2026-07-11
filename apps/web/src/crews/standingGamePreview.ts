import type { GolferId } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { GAME_KIND_LABEL } from "../round/SetupPanel";

// One label-and-names formatter, reused by StandingGameEditor (listing the preset's currently
// configured games) AND CreateRoundPage (previewing what "Play the usual" is about to add) —
// the second instance is what earns this its own module rather than a copy in each page
// (conventions §0). Presentational only: this has nothing to do with scoring or the M7 dots/
// audit discipline (`state.games`/`terminatedGameIds`) — a StandingGame preset carries no
// GameId and is never part of a live RoundState.
export const describeStandingGame = (game: GameConfigInput, nameFor: (id: GolferId) => string): string => {
  const label = GAME_KIND_LABEL[game.kind];
  switch (game.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return `${label} — ${game.players.map(nameFor).join(", ")}`;
    case "singles-match":
      return `${label} — ${nameFor(game.a)} vs ${nameFor(game.b)}`;
    case "fourball-match":
      return `${label} — ${game.a.map(nameFor).join(" & ")} vs ${game.b.map(nameFor).join(" & ")}`;
  }
};
