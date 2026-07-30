import { useState } from "react";
import { grossForHoles, netStrokes, roundStrokeAllocation } from "@swng/client";
import { cellAt, findTeeSet, scoredStrokes, underPar } from "@swng/domain";
import type { CourseCard, GolferId, HoleResult, Hole, Participant, RoundState, ScoreCell } from "@swng/domain";
import { cardBox } from "../ui/classes";
import { ScorePad } from "./ScorePad";

export interface ScorecardGridProps {
  readonly state: RoundState;
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
// Exported: ResultsView's own "Final totals" headline reuses this SAME hole list rather than
// re-deciding "which holes make up this card" a second way.
export const canonicalHoles = (card: CourseCard): readonly Hole[] => card.teeSets[0]?.holes ?? [];

// First hole where not every participant has a cell — the on-course "where are we" pointer
// (brief: "current hole = first hole where not every participant has a cell"). Reads through
// cellAt, never a raw membership check on `cells` — a cleared cell is RETAINED in state.cells
// (the fold invariant), so an `in`/key-presence test would treat a cleared cell as recorded and
// leave the highlight past a hole that actually needs re-entry.
const currentHoleNumber = (holes: readonly Hole[], participants: readonly Participant[], cells: RoundState["cells"]): number | undefined => {
  for (const hole of holes) {
    if (participants.some((p) => cellAt(cells, p.golferId, hole.number) === undefined)) return hole.number;
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
    case "strokes":
      return String(result.strokes);
    case "cleared":
      // Dead in practice: the grid reads every cell through cellAt (round/state.ts), which
      // hides cleared cells from readers entirely (`cell` is undefined below, so this switch
      // never runs on one) — kept only so the switch stays exhaustive over HoleResult's kind.
      return "";
  }
};

// A segment total (OUT/IN/TOT, the same three rows any paper card carries): gross over net, via
// grossForHoles (@swng/client — the ONE place spec §2d's "a card either has a score or it
// doesn't" rule lives, extended from one cell to a whole set of holes) and the same
// netStrokes(gross, dots) every cell above already uses. ResultsView's own "Final totals" line
// calls the SAME grossForHoles, so the two sections can never disagree about the same round the
// way two hand-maintained copies would (review fix, task-4 fix round 1).
interface SegmentTotal {
  readonly gross: number;
  readonly net: number;
}

const segmentTotalFor = (
  golferId: GolferId,
  segmentHoles: readonly Hole[],
  cells: RoundState["cells"],
  dots: ReadonlyMap<number, number> | undefined,
): SegmentTotal | undefined => {
  const gross = grossForHoles(cells, golferId, segmentHoles);
  if (gross === undefined) return undefined;
  const dotsSum = segmentHoles.reduce((sum, hole) => sum + (dots?.get(hole.number) ?? 0), 0);
  return { gross, net: netStrokes(gross, dotsSum) };
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
// w-full: the cell fills its column so it stays centered under the (centered) name header at
// any column width — min-w alone shrink-wraps and hugs the column's left edge (owner field
// report, 2026-07-20).
function Cell({ participant, hole, cell, dots, onTap, readOnly }: CellProps) {
  const gross = cell ? scoredStrokes(cell.result) : undefined;
  const net = gross !== undefined && dots !== 0 ? netStrokes(gross, dots) : undefined;

  return (
    <button
      type="button"
      aria-label={`${participant.name} hole ${hole.number}`}
      onClick={onTap}
      disabled={readOnly}
      className={`${cardBox} flex min-h-14 w-full min-w-14 flex-col items-center justify-center gap-0.5 px-1 py-1 active:bg-goldwash`}
    >
      {/* Dots are strokes RECEIVED, always: a roster number is bounded at zero by the request
          schema (spec 2026-07-30 §11) and a match subtracts the lowest of its own members, so the
          hollow ○ give-back glyph a plus handicap used to draw has no reachable state and is
          deleted with the convention. `repeat` throws RangeError on a negative, which is exactly
          what makes that bound load-bearing rather than cosmetic. */}
      {dots !== 0 && (
        <span aria-hidden className="text-[10px] leading-none text-forest">
          {"●".repeat(dots)}
        </span>
      )}
      {cell ? (
        <span
          className={
            gross !== undefined
              ? `text-lg font-semibold tabular-nums ${underPar(gross, hole.par) ? "text-oxblood" : "text-forest"}`
              : "text-sm font-semibold text-oxblood"
          }
        >
          {glyphFor(cell.result)}
        </span>
      ) : (
        <span className="text-fairway/50">–</span>
      )}
      {net !== undefined && <span className={`text-[10px] leading-none ${underPar(net, hole.par) ? "text-oxblood" : "text-fairway"}`}>{net}</span>}
    </button>
  );
}

// The scorecard: hole rows × player columns, two-tap score-for-anyone entry (product.md §9).
// Any cell — yours or anyone else's — opens the same ScorePad; tapping a value there posts
// and closes with no confirm step. Rendering is purely a function of `state` — no game
// context at all (spec 2026-07-19 §2a: the card never changes). recordScore's optimistic
// fold (the session layer) is what makes the tapped value show up here on the very next
// render; this component adds no local echo of its own.
export function ScorecardGrid({ state, recordScore, readOnly = false }: ScorecardGridProps) {
  const [selection, setSelection] = useState<Selection | undefined>(undefined);

  const holes = canonicalHoles(state.card);
  const current = currentHoleNumber(holes, state.participants, state.cells);

  // The STANDARD CARD's dots: each player's own ROUND strokes — the value the fold derived across
  // the present roster (spec 2026-07-29 §2b) — allocated by stroke index, no game, computed once
  // per render (spec 2026-07-19 §2a). Any concurrent game's own strokes (resolved off that game's
  // own field) live in that game's own panel — this grid never re-derives them.
  const dotsByGolfer = roundStrokeAllocation(state.participants, state.card);

  // OUT (front nine) / IN (back nine) / TOT — the same rows any paper card totals, keyed off
  // hole NUMBER rather than array position (every card in this codebase numbers holes 1..N, but
  // this doesn't need to assume it). OUT/IN only mean anything once a card actually HAS a back
  // nine to split from — on a 9-hole card, "OUT" would cover the exact same holes as "TOT" (a
  // confusing duplicate row, review fix task-4 fix round 1), so both are omitted and only the
  // unambiguous whole-round TOT renders.
  const outHoles = holes.filter((h) => h.number <= 9);
  const inHoles = holes.filter((h) => h.number > 9);
  const segments: readonly { readonly label: string; readonly holes: readonly Hole[] }[] =
    inHoles.length > 0 ? [{ label: "OUT", holes: outHoles }, { label: "IN", holes: inHoles }, { label: "TOT", holes }] : [{ label: "TOT", holes }];

  const selectedParticipant = selection && state.participants.find((p) => p.golferId === selection.golferId);
  const selectedHole = selection && holes.find((h) => h.number === selection.hole);
  // The tapped cell's current result (if any) — read the same way every other cell is (cellAt,
  // never a raw state.cells[...] index), so ScorePad can show `Clear score` only when there's
  // actually something to clear.
  const selectedCell = selection && cellAt(state.cells, selection.golferId, selection.hole);

  return (
    <section className={`${cardBox} flex flex-col gap-2 p-2 text-forest`}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            {/* Sticky player header (brief) — column identity stays visible while scrolling
                a long 18-hole card. */}
            <tr className="sticky top-0 z-10 bg-forest">
              <th scope="col" className="sticky left-0 z-20 bg-forest px-2 text-left font-mono text-[10px] tracking-wide text-cream uppercase">
                Hole
              </th>
              {state.participants.map((p) => (
                <th key={p.golferId} scope="col" className="min-w-14 px-1 text-sm font-bold text-cream">
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
                <tr key={hole.number} aria-label={`Hole ${hole.number}`} aria-current={isCurrent ? "true" : undefined} className={isCurrent ? "bg-goldwash" : undefined}>
                  <th scope="row" className="sticky left-0 z-10 bg-inherit px-2 text-left font-mono text-xs text-fairway">
                    <div className="font-semibold">{hole.number}</div>
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
                        cell={cellAt(state.cells, p.golferId, hole.number)}
                        dots={dotsByGolfer.get(p.golferId)?.get(hole.number) ?? 0}
                        onTap={() => setSelection({ golferId: p.golferId, hole: hole.number })}
                        readOnly={readOnly}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {segments.map((segment) => (
              <tr key={segment.label} aria-label={segment.label}>
                <th scope="row" className="sticky left-0 z-10 bg-inherit px-2 text-left font-mono text-xs text-fairway">
                  <div className="font-semibold">{segment.label}</div>
                  {/* Same "Par N" shape as an ordinary hole row's own header cell above — one
                      composite string, not a number wrapped in its own element for a test's
                      sake (review fix, task-4 fix round 1). */}
                  <div>Par {segment.holes.reduce((sum, hole) => sum + hole.par, 0)}</div>
                </th>
                {state.participants.map((p) => {
                  const total = segmentTotalFor(p.golferId, segment.holes, state.cells, dotsByGolfer.get(p.golferId));
                  return (
                    <td key={p.golferId} className="text-center">
                      {total ? (
                        <>
                          <div className="text-lg font-semibold tabular-nums text-forest">{total.gross}</div>
                          <div className="text-[10px] leading-none text-fairway">{total.net}</div>
                        </>
                      ) : (
                        <span className="text-fairway/50">–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>

      {selection && selectedParticipant && selectedHole && (
        // key forces a fresh ScorePad instance per (golfer, hole): without one, React reuses the
        // same instance across a `selection` change (the sheet has no scrim and cells above stay
        // tappable), so any pad-local state would survive a tap onto a DIFFERENT cell. The key
        // fences that off structurally, whatever state a future ScorePad revision adds.
        <ScorePad
          key={`${selection.golferId}-${selection.hole}`}
          golfer={selectedParticipant}
          hole={selectedHole}
          current={selectedCell?.result}
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
