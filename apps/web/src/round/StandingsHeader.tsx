import type { GameId, GameState, RoundState } from "@swng/domain";
import { describeGame } from "../games/describeGame";

export interface StandingsHeaderProps {
  readonly state: RoundState;
  readonly games: readonly GameState[];
  // undefined only before any game exists — RoundPage's own default-to-first-game selection
  // seam (Task 5's fixed decision) means this is otherwise always one of `games`' ids.
  readonly activeGameId: GameId | undefined;
  readonly onSelect: (gameId: GameId) => void;
}

// One chip per game, always visible above the grid (brief) — tapping a chip is the ONLY way
// the grid's active game (dots/nets) changes, so this is a tablist, not a button row: exactly
// one chip is ever the "current" one, matching native tab semantics for assistive tech.
export function StandingsHeader({ state, games, activeGameId, onSelect }: StandingsHeaderProps) {
  if (games.length === 0) return null; // nothing to stand for yet — SetupPanel covers pre-game state

  return (
    <div role="tablist" aria-label="Games" className="flex gap-2 overflow-x-auto p-2">
      {games.map((game) => {
        const { title, line } = describeGame(game, state);
        const active = game.id === activeGameId;
        return (
          <button
            key={game.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(game.id)}
            className={`flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-lg px-3 py-1 text-left whitespace-nowrap ${
              // Color alone can't carry "which chip is active" (color-blind / grayscale
              // readability) — the border + weight are the non-color cue; border-transparent
              // (not border-0) keeps the inactive chip's box the same size as the active one.
              active ? "border-2 border-current bg-emerald-700 font-semibold text-slate-50" : "border border-transparent bg-slate-800 text-slate-300"
            }`}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">{title}</span>
            <span className="text-sm font-medium">{line}</span>
          </button>
        );
      })}
    </div>
  );
}
