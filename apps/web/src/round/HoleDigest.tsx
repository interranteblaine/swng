import { useCallback, useEffect, useRef, useState } from "react";
import { cellKey, scoreGame } from "@swng/domain";
import type { GameId, GameState, RoundState } from "@swng/domain";
import { describeGame } from "../games/describeGame";

export interface GameChangeLine {
  readonly gameId: GameId;
  readonly title: string;
  readonly line: string; // the game's CURRENT (post-completion) describeGame line — always shown
  readonly previousLine: string | undefined; // the pre-completion line, only when it differs from `line`
}

export interface HoleDigestData {
  readonly hole: number;
  readonly lines: readonly GameChangeLine[];
}

const canonicalHoles = (round: RoundState) => round.card.teeSets[0]?.holes ?? []; // same convention as ScorecardGrid.tsx's own canonicalHoles

const holeComplete = (round: RoundState, holeNumber: number): boolean => round.participants.every((p) => cellKey(p.golferId, holeNumber) in round.cells);

// Which write is currently winning each cell — NOT object reference equality on `state`
// itself. @swng/client's session hands back a genuinely NEW RoundState object (a fresh
// computeState() after invalidateCache()) whenever an optimistically-pending event gets
// folded in as confirmed via sync, even though the resulting cells are byte-identical
// (reduceRound's opId dedupe folds the same event to the same winner either way) — a
// reference check here would spuriously treat that transition as "the next score entry" and
// dismiss a digest that just opened, before the golfer ever saw it. Sorted so insertion order
// (which can differ between an optimistic fold and a re-confirmed one) can't cause a false
// "changed" either.
const cellsSignature = (cells: RoundState["cells"]): string =>
  Object.keys(cells)
    .sort()
    .map((key) => `${key}=${cells[key]!.opId}@${cells[key]!.hlc.wallMs}.${cells[key]!.hlc.counter}`)
    .join("|");

// The fixed digest trigger (brief): an overlay fires once, exactly on the render where a hole
// transitions from incomplete to complete ("every participant has a cell for it") — never a
// recomputation that re-fires on every render, and never again for a later correction to an
// already-complete hole. `digestedRef` is the single guard for both: every hole ever OBSERVED
// complete — including ones already complete at first mount, seeded here without firing since
// mounting isn't itself a transition — gets added, so a same-hole correction later finds it
// already marked and skips, no matter how (or whether) the earlier digest was dismissed.
export const useHoleDigest = (state: RoundState, games: readonly GameState[]): { digest: HoleDigestData | undefined; dismiss: () => void } => {
  const digestedRef = useRef<Set<number>>(new Set());
  const prevStateRef = useRef<RoundState | undefined>(undefined);
  const [digest, setDigest] = useState<HoleDigestData | undefined>(undefined);

  useEffect(() => {
    const prevState = prevStateRef.current;
    const firstRun = prevState === undefined;

    // A genuine cells change — a correction, or the very score that completes a hole below —
    // closes whatever digest is currently showing first ("dismissed... by the next score
    // entry," brief); a fresh digest may still open right after, in this same pass. Content-
    // based (see cellsSignature's own comment), not `prevState !== state`.
    if (!firstRun && cellsSignature(prevState.cells) !== cellsSignature(state.cells)) setDigest(undefined);

    const newlyComplete: number[] = [];
    for (const hole of canonicalHoles(state)) {
      if (digestedRef.current.has(hole.number) || !holeComplete(state, hole.number)) continue;
      digestedRef.current.add(hole.number);
      if (!firstRun) newlyComplete.push(hole.number);
    }

    if (prevState && newlyComplete.length > 0) {
      const hole = Math.min(...newlyComplete); // lowest newly-completed hole this pass — chronologically first
      const lines: GameChangeLine[] = state.games.map((config) => {
        const after = games.find((g) => g.id === config.id);
        // `after` should always resolve (games is scoreGame() over these same configs), but a
        // future/unknown kind the session already filtered out is a real possibility upstream —
        // degrade to the bare title rather than crash the whole digest over one game.
        const afterDesc = after ? describeGame(after, state) : { title: config.kind, line: "" };
        const existedBefore = prevState.games.some((g) => g.id === config.id);
        const beforeLine = existedBefore ? describeGame(scoreGame(config, prevState), prevState).line : undefined;
        return { gameId: config.id, title: afterDesc.title, line: afterDesc.line, previousLine: beforeLine !== afterDesc.line ? beforeLine : undefined };
      });
      setDigest({ hole, lines });
    }

    prevStateRef.current = state;
  }, [state, games]);

  const dismiss = useCallback(() => setDigest(undefined), []);
  return { digest, dismiss };
};

export interface HoleDigestProps {
  readonly digest: HoleDigestData;
  readonly onDismiss: () => void;
}

// The between-holes digest (product.md §"Game state, always"): "where does everything stand
// right now" for every game, surfaced without anyone asking. `role="status"` (not "dialog" —
// ScorePad's own role): this is a passive, dismissible info card, never a thing the user must
// act on before continuing to score, so it shouldn't read to assistive tech as a modal that
// demands input (and mustn't collide with ScorePad's own dialog role when both could
// plausibly be open — e.g. a single-participant round where one tap both posts a score AND
// completes the hole).
export function HoleDigest({ digest, onDismiss }: HoleDigestProps) {
  return (
    <div
      role="status"
      aria-label={`After hole ${digest.hole}`}
      onClick={onDismiss}
      className="fixed inset-x-0 bottom-20 z-40 mx-auto flex max-w-md flex-col gap-2 rounded-xl bg-slate-900 p-4 text-slate-100 shadow-2xl"
    >
      <p className="text-sm font-semibold text-slate-300">After {digest.hole}</p>
      <ul className="flex flex-col gap-1">
        {digest.lines.map((line) => (
          <li key={line.gameId} className="text-sm">
            <span className="font-medium">
              {line.title}: {line.line}
            </span>
            {line.previousLine && <span className="block text-xs text-slate-500">was {line.previousLine}</span>}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation(); // the card itself is already a dismiss target; avoid a double-fire
          onDismiss();
        }}
        className="min-h-8 self-end rounded-md bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300"
      >
        Dismiss
      </button>
    </div>
  );
}
