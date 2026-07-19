import { useState } from "react";
import type { GameId, GameState, RoundState } from "@swng/domain";
import { describeGame } from "../games/describeGame";
import { GameSheet } from "../games/GameSheet";

export interface StandingsHeaderProps {
  readonly state: RoundState;
  readonly games: readonly GameState[];
  // undefined only before any game exists — RoundPage's own default-to-first-game selection
  // seam (Task 5's fixed decision) means this is otherwise always one of `games`' ids.
  readonly activeGameId: GameId | undefined;
  readonly onSelect: (gameId: GameId) => void;
  // The "End game…" overflow (M7 Task 6 brief) — live rounds only. Omitted entirely by
  // ResultsView's own archived-card reuse of this component, which is what keeps that reuse
  // from needing a second "is this live" prop to stay in sync with `state.status`: no
  // onTerminate, no overflow control, full stop. A rejection renders a fixed friendly line,
  // never the raw message (server texts here can carry game uuids — the same class of leak
  // papercut 1 killed in the finalize dialog).
  readonly onTerminate?: (gameId: GameId) => Promise<void>;
}

// One chip per game, always visible above the grid (brief) — tapping a chip is the ONLY way
// the grid's active game (dots/nets) changes, so this is a tablist, not a button row: exactly
// one chip is ever the "current" one, matching native tab semantics for assistive tech.
export function StandingsHeader({ state, games, activeGameId, onSelect, onTerminate }: StandingsHeaderProps) {
  const [confirmingId, setConfirmingId] = useState<GameId | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sheetGameId, setSheetGameId] = useState<GameId | undefined>(undefined);

  if (games.length === 0) return null; // nothing to stand for yet — SetupPanel covers pre-game state

  const confirmingGame = games.find((g) => g.id === confirmingId);
  const confirmingTitle = confirmingGame ? describeGame(confirmingGame, state).title : undefined;
  const sheetGame = games.find((g) => g.id === sheetGameId);

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
      <div role="tablist" aria-label="Games" className="flex gap-2 overflow-x-auto p-2">
        {games.map((game) => {
          const { title, line } = describeGame(game, state);
          const active = game.id === activeGameId;
          const terminated = state.terminatedGameIds.has(game.id);
          // "Live rounds only" (brief): state.status !== "live" is the archived-card case
          // (ResultsView's own reuse) — checked here too, not just by onTerminate's absence,
          // as defense-in-depth against a future caller passing one in by mistake.
          const canTerminate = Boolean(onTerminate) && state.status === "live" && !terminated;

          return (
            <div key={game.id} className="flex shrink-0 items-stretch gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => (active ? setSheetGameId(game.id) : onSelect(game.id))}
                className={`flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-lg px-3 py-1 text-left whitespace-nowrap ${
                  // Color alone can't carry "which chip is active" (color-blind / grayscale
                  // readability) — the border + weight are the non-color cue; border-transparent
                  // (not border-0) keeps the inactive chip's box the same size as the active one.
                  active ? "border-2 border-current bg-emerald-700 font-semibold text-slate-50" : "border border-transparent bg-slate-800 text-slate-300"
                }`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
                  {title}
                  {terminated && <span className="ml-1 rounded bg-slate-600 px-1 py-0.5 text-slate-200 normal-case">Ended</span>}
                  {active && (
                    <span aria-hidden="true" className="ml-1">
                      ›
                    </span>
                  )}
                </span>
                <span className="text-sm font-medium">{line}</span>
              </button>
              {canTerminate && (
                <button
                  type="button"
                  aria-label={`End ${title}`}
                  onClick={() => openConfirm(game.id)}
                  className="min-h-14 rounded-lg bg-slate-800 px-2 text-lg text-slate-400"
                >
                  ⋯
                </button>
              )}
            </div>
          );
        })}
      </div>

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

      {sheetGame && <GameSheet game={sheetGame} state={state} onClose={() => setSheetGameId(undefined)} />}
    </>
  );
}
