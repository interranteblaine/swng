import { useState } from "react";
import type { GameId, GameState, RoundState } from "@swng/domain";
import { describeGame } from "../games/describeGame";
import { GamePanel } from "../games/GamePanel";

export interface StandingsHeaderProps {
  readonly state: RoundState;
  readonly games: readonly GameState[];
  // The "End game…" trigger (rendered inside the open panel's own footer, spec 2026-07-19
  // §2b) — live rounds only. Omitted entirely by ResultsView's own archived-card reuse of this
  // component, which is what keeps that reuse from needing a second "is this live" prop to stay
  // in sync with `state.status`: no onTerminate, no End affordance, full stop. A rejection
  // renders a fixed friendly line, never the raw message (server texts here can carry game
  // uuids — the same class of leak papercut 1 killed in the finalize dialog).
  readonly onTerminate?: (gameId: GameId) => Promise<void>;
}

// One chip per game, always visible above the grid — spec 2026-07-19 §2a/§2b: the card is
// game-agnostic now (Task 3), so chips no longer select anything for the grid. A tap on a chip
// is purely a disclosure toggle: it expands that game's own panel inline below the chip row;
// tapping another chip switches; tapping the open chip closes it. Plain buttons, not tabs — no
// single chip is ever "the" current one anymore, so there's nothing tablist semantics would
// correctly describe.
export function StandingsHeader({ state, games, onTerminate }: StandingsHeaderProps) {
  const [expandedGameId, setExpandedGameId] = useState<GameId | undefined>(undefined); // default: all collapsed
  const [confirmingId, setConfirmingId] = useState<GameId | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (games.length === 0) return null; // nothing to stand for yet — SetupPanel covers pre-game state

  const confirmingGame = games.find((g) => g.id === confirmingId);
  const confirmingTitle = confirmingGame ? describeGame(confirmingGame, state).title : undefined;
  const expandedGame = games.find((g) => g.id === expandedGameId);

  const openConfirm = (gameId: GameId) => {
    setError(undefined);
    setConfirmingId(gameId);
  };

  const confirmTerminate = async () => {
    if (!confirmingId || !onTerminate) return;
    setBusy(true);
    setError(undefined);
    try {
      await onTerminate(confirmingId);
      setConfirmingId(undefined);
    } catch {
      // See onTerminate's own prop doc: fixed line, never the raw message.
      setError("Could not end the game — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex gap-2 overflow-x-auto p-2">
        {games.map((game) => {
          const { title, line } = describeGame(game, state);
          const expanded = game.id === expandedGameId;
          const terminated = state.terminatedGameIds.has(game.id);

          return (
            <button
              key={game.id}
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedGameId(expanded ? undefined : game.id)}
              className={`flex min-h-14 shrink-0 flex-col items-start justify-center gap-0.5 rounded-lg px-3 py-1 text-left whitespace-nowrap ${
                // Color alone can't carry "which chip is open" (color-blind / grayscale
                // readability) — the border + weight are the non-color cue; border-transparent
                // (not border-0) keeps the collapsed chip's box the same size as the open one.
                expanded ? "border-2 border-current bg-emerald-700 font-semibold text-slate-50" : "border border-transparent bg-slate-800 text-slate-300"
              }`}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
                {title}
                {terminated && <span className="ml-1 rounded bg-slate-600 px-1 py-0.5 text-slate-200 normal-case">Ended</span>}
              </span>
              <span className="flex items-center gap-1 text-sm font-medium">
                {line}
                <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
              </span>
            </button>
          );
        })}
      </div>

      {expandedGame && (
        <div className="px-2 pb-2">
          <GamePanel game={expandedGame} state={state} onTerminate={onTerminate ? () => openConfirm(expandedGame.id) : undefined} />
        </div>
      )}

      {confirmingId && confirmingTitle && (
        <div role="dialog" aria-label={`End ${confirmingTitle}`} className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 rounded-t-2xl bg-slate-900 p-4 shadow-2xl">
          <p className="text-sm text-slate-300">End {confirmingTitle}? It stops scoring for this game — it won&apos;t be included in the final results.</p>
          <button
            type="button"
            onClick={() => void confirmTerminate()}
            disabled={busy}
            className="min-h-14 rounded-lg bg-red-800 px-4 text-base font-semibold text-slate-100 disabled:opacity-50"
          >
            {busy ? "Ending…" : "End game"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingId(undefined)}
            disabled={busy}
            className="min-h-14 rounded-lg bg-slate-800 px-4 text-base font-medium text-slate-300 disabled:opacity-50"
          >
            Cancel
          </button>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}
