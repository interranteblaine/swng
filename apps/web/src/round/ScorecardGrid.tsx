import { useState } from "react";
import { courseHandicapAllocation, netStrokes } from "@swng/client";
import { cellAt, findTeeSet, scoredStrokes, strokeGrant, underPar } from "@swng/domain";
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
const canonicalHoles = (card: CourseCard): readonly Hole[] => card.teeSets[0]?.holes ?? [];

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
    // A conceded hole is a scored hole everywhere else (spec §2d) — the `c` suffix is the one
    // place left on the card that still marks it as conceded rather than holed out.
    case "conceded":
      return `${result.strokes}c`;
    case "strokes":
      return String(result.strokes);
    case "cleared":
      // Dead in practice: the grid reads every cell through cellAt (round/state.ts), which
      // hides cleared cells from readers entirely (`cell` is undefined below, so this switch
      // never runs on one) — kept only so the switch stays exhaustive over HoleResult's kind.
      return "";
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
// w-full: the cell fills its column so it stays centered under the (centered) name header at
// any column width — min-w alone shrink-wraps and hugs the column's left edge (owner field
// report, 2026-07-20).
function Cell({ participant, hole, cell, dots, onTap, readOnly }: CellProps) {
  // A conceded hole is a scored hole everywhere but its glyph (spec §2d) — scoredStrokes reads
  // its number exactly like a `strokes` cell, so net and the under-par ink below apply to it too.
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
      {(() => {
        const grant = strokeGrant(dots);
        if (grant.kind === "none") return null;
        // received strokes are filled ●; GIVEN strokes (a plus handicap) are hollow ○ — on the
        // screen now, not silently dropped. net = gross − dots already reads gross + 1 for a give.
        return (
          <span aria-hidden className="text-[10px] leading-none text-forest">
            {(grant.kind === "receives" ? "●" : "○").repeat(grant.count)}
          </span>
        );
      })()}
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

  // The STANDARD CARD's dots: each player's own course handicap, allocated by stroke index —
  // no game, computed once per render (spec 2026-07-19 §2a). Any concurrent
  // game's own strokes (resolved off that game's own field) live in that game's own
  // panel — this grid never re-derives them.
  const dotsByGolfer = courseHandicapAllocation(state.participants, state.card);

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
        </table>
      </div>

      {selection && selectedParticipant && selectedHole && (
        // key forces a fresh ScorePad instance per (golfer, hole): without one, React reuses the
        // same instance across a `selection` change (the sheet has no scrim and cells above stay
        // tappable), so ScorePad's own `conceding` state (useState, ScorePad.tsx) would survive a
        // tap onto a DIFFERENT cell — posting a conceded score for the wrong player. The key
        // fences off any future pad-local state the same way, not just this one bug.
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
