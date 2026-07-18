import { useState } from "react";
import { netStrokes } from "@swng/client";
import { cellKey, findTeeSet, strokeGrant } from "@swng/domain";
import type { CourseCard, GameState, GolferId, HoleResult, Hole, Participant, RoundState, ScoreCell } from "@swng/domain";
import { gameDots } from "./dots";
import { ScorePad } from "./ScorePad";

export interface ScorecardGridProps {
  readonly state: RoundState;
  // The Task 6 seam (chip selection): concurrent games mean concurrent dot sets, so the grid
  // renders dots/nets for exactly ONE game — this is it. `undefined` (no games yet, or none
  // selected) means plain gross, no dots, no nets. Only `.id`/`.kind` are read here — the
  // full GameConfig (players, allowance, ...) needed to compute dots is looked up from
  // `state.games` below, since GameState alone doesn't carry it.
  readonly activeGame: GameState | undefined;
  readonly recordScore: (golferId: GolferId, hole: number, result: HoleResult) => void;
  // Task 6's archived-card reuse: a `final` round's ScorecardGrid is the same component, just
  // with every cell's tap made inert (native `disabled`, not merely "recordScore is a no-op")
  // — the brief's "the pad NEVER opens" is about the tap itself, not just where its result
  // goes. Defaults false so every existing (live) call site is unaffected.
  readonly readOnly?: boolean;
}

interface Selection {
  readonly golferId: GolferId;
  readonly hole: number;
}

// The canonical hole numbering/par/SI for the grid's rows. Real courses keep these identical
// across every tee at a course (only yardage/rating/slope vary by tee) — the first tee set is
// as good a source as any, so this doesn't force a "primary tee" concept onto the round.
const canonicalHoles = (card: CourseCard): readonly Hole[] => card.teeSets[0]?.holes ?? [];

// First hole where not every participant has a cell — the on-course "where are we" pointer
// (brief: "current hole = first hole where not every participant has a cell").
const currentHoleNumber = (holes: readonly Hole[], participants: readonly Participant[], cells: RoundState["cells"]): number | undefined => {
  for (const hole of holes) {
    if (participants.some((p) => !(cellKey(p.golferId, hole.number) in cells))) return hole.number;
  }
  return undefined;
};

// One shared yardage row-label per hole: the distinct yardages among the tees actually in
// play (usually one value; a group split across tees shows both, "/"-joined, the way a
// paper card lists a yardage row per tee).
const yardageLabel = (card: CourseCard, participants: readonly Participant[], holeNumber: number): string => {
  const tees = [...new Set(participants.map((p) => p.tee))];
  const yardages = tees.map((tee) => findTeeSet(card, tee).holes.find((h) => h.number === holeNumber)?.yardage).filter((y): y is number => y !== undefined);
  return [...new Set(yardages)].join("/");
};

const glyphFor = (result: HoleResult): string => {
  switch (result.kind) {
    case "picked-up":
      return "PU";
    case "conceded":
      return "CN";
    case "strokes":
      return String(result.strokes);
  }
};

interface CellProps {
  readonly participant: Participant;
  readonly hole: Hole;
  readonly cell: ScoreCell | undefined;
  readonly dots: number;
  readonly onTap: () => void;
  readonly readOnly: boolean;
}

// A tappable scorecard cell — dots above, gross (large) + net (small, only where dots apply)
// below. This IS the "tap 1" of the two-tap contract; ScorePad below is "tap 2".
function Cell({ participant, hole, cell, dots, onTap, readOnly }: CellProps) {
  const net = cell?.result.kind === "strokes" && dots !== 0 ? netStrokes(cell.result.strokes, dots) : undefined;

  return (
    <button
      type="button"
      aria-label={`${participant.name} hole ${hole.number}`}
      onClick={onTap}
      disabled={readOnly}
      className="flex min-h-14 min-w-14 flex-col items-center justify-center gap-0.5 rounded-md bg-slate-800 px-1 py-1 active:bg-slate-700 disabled:active:bg-slate-800"
    >
      {(() => {
        const grant = strokeGrant(dots);
        if (grant.kind === "none") return null;
        // received strokes are filled ●; GIVEN strokes (a plus handicap) are hollow ○ — on the
        // screen now, not silently dropped. net = gross − dots already reads gross + 1 for a give.
        return (
          <span aria-hidden className="text-[10px] leading-none text-amber-400">
            {(grant.kind === "receives" ? "●" : "○").repeat(grant.count)}
          </span>
        );
      })()}
      {cell ? (
        <span className={cell.result.kind === "strokes" ? "text-lg font-semibold text-slate-100" : "text-sm font-semibold text-amber-300"}>{glyphFor(cell.result)}</span>
      ) : (
        <span className="text-slate-600">–</span>
      )}
      {net !== undefined && <span className="text-[10px] leading-none text-slate-400">{net}</span>}
    </button>
  );
}

// The scorecard: hole rows × player columns, two-tap score-for-anyone entry (product.md §9).
// Any cell — yours or anyone else's — opens the same ScorePad; tapping a value there posts
// and closes with no confirm step. Rendering is purely a function of `state` (+ `activeGame`
// for dots) — recordScore's optimistic fold (the session layer) is what makes the tapped
// value show up here on the very next render; this component adds no local echo of its own.
export function ScorecardGrid({ state, activeGame, recordScore, readOnly = false }: ScorecardGridProps) {
  const [selection, setSelection] = useState<Selection | undefined>(undefined);

  const holes = canonicalHoles(state.card);
  const current = currentHoleNumber(holes, state.participants, state.cells);

  // activeGame (GameState) only identifies WHICH game is active by id — the dots math needs
  // the frozen GameConfig, which lives in state.games; dots.ts's gameDots is the one place
  // that formula is allowed to live (reused verbatim, not re-derived — SetupPanel's own
  // precedent). A terminated game never contributes dots (M7 Task 6 brief) — StandingsHeader
  // still lets its chip be selected (an "ended" badge, not a removal), but that chip's grid
  // reads exactly like "no game selected" here: a terminated game has stopped consuming
  // scores, so showing dots for it would misrepresent what's actually being allocated.
  const activeConfig = activeGame && !state.terminatedGameIds.has(activeGame.id) ? state.games.find((g) => g.id === activeGame.id) : undefined;
  const dotsByGolfer = activeConfig ? gameDots(activeConfig, state.participants, state.card) : undefined;

  const selectedParticipant = selection && state.participants.find((p) => p.golferId === selection.golferId);
  const selectedHole = selection && holes.find((h) => h.number === selection.hole);

  return (
    <section className="flex flex-col gap-2 p-2 text-slate-100">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            {/* Sticky player header (brief) — column identity stays visible while scrolling
                a long 18-hole card. */}
            <tr className="sticky top-0 z-10 bg-slate-950">
              <th scope="col" className="sticky left-0 z-20 bg-slate-950 px-2 text-left text-xs font-medium text-slate-400">
                Hole
              </th>
              {state.participants.map((p) => (
                <th key={p.golferId} scope="col" className="min-w-14 px-1 text-xs font-medium text-slate-300">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {holes.map((hole) => {
              const isCurrent = hole.number === current;
              const yardage = yardageLabel(state.card, state.participants, hole.number);
              return (
                <tr key={hole.number} aria-label={`Hole ${hole.number}`} aria-current={isCurrent ? "true" : undefined} className={isCurrent ? "bg-emerald-950" : undefined}>
                  <th scope="row" className="sticky left-0 z-10 bg-inherit px-2 text-left text-xs text-slate-400">
                    <div className="font-semibold text-slate-200">{hole.number}</div>
                    <div>
                      Par {hole.par} · SI {hole.strokeIndex}
                      {yardage && ` · ${yardage}y`}
                    </div>
                  </th>
                  {state.participants.map((p) => (
                    <td key={p.golferId}>
                      <Cell
                        participant={p}
                        hole={hole}
                        cell={state.cells[cellKey(p.golferId, hole.number)]}
                        dots={dotsByGolfer?.get(p.golferId)?.get(hole.number) ?? 0}
                        onTap={() => setSelection({ golferId: p.golferId, hole: hole.number })}
                        readOnly={readOnly}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selection && selectedParticipant && selectedHole && (
        <ScorePad
          golfer={selectedParticipant}
          hole={selectedHole}
          onSubmit={(result) => {
            recordScore(selection.golferId, selection.hole, result);
            setSelection(undefined); // closes on post — no confirm step (the two-tap contract)
          }}
          onCancel={() => setSelection(undefined)}
        />
      )}
    </section>
  );
}
