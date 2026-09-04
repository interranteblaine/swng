import { useState } from "react";
import { dotsForHoles, grossForHoles, intendedHoles, netStrokes, parForHoles, roundStrokeAllocation } from "@swng/client";
import { cellAt, findTeeSet, scoredStrokes, underPar } from "@swng/domain";
import type { CourseCard, GolferId, HoleResult, Hole, HoleSelection, Participant, RosterEntry, RoundState, ScoreCell } from "@swng/domain";
import { cardBox } from "../ui/classes";
import { ScorePad } from "./ScorePad";

export interface ScorecardGridProps {
  readonly state: RoundState;
  readonly recordScore: (golferId: GolferId, hole: number, result: HoleResult) => void;
  // Task 6's archived-card reuse: a `final` round's ScorecardGrid is the same component, just
  // with every cell's tap made inert (native `disabled`, not merely "recordScore is a no-op")
  // — the brief's "the pad NEVER opens" is about the tap itself, not just where its result
  // goes. Defaults false so every existing (live) call site is unaffected.
  //
  // Also raised for as long as a finalize attempt is in flight (RoundPage's LiveRound): a score
  // entered in that window would push AFTER the seal and be refused forever. Same meaning in both
  // cases — "this card cannot take a score right now" — so it's the same one flag, and it covers
  // an already-open pad too (below), not just the cells.
  readonly readOnly?: boolean;
}

interface Selection {
  readonly golferId: GolferId;
  readonly hole: number;
}

// The hole numbering/par/SI for the grid's rows: the holes THIS ROUND set out to play (spec
// 2026-08-02 §3c), off the canonical first tee set (real courses keep these identical across
// tees — only yardage/rating/slope vary). Exported: ResultsView's "Final totals" headline reuses
// this SAME list rather than re-deciding which holes make up the round a second way.
export const canonicalHoles = (card: CourseCard, selection: HoleSelection): readonly Hole[] => {
  const teeSet = card.teeSets[0];
  return teeSet ? intendedHoles(teeSet, selection) : [];
};

// First hole where a golfer STILL IN THE ROUND has no cell — the on-course "where are we"
// pointer. The brief said "not every participant"; that was written before `participant-left`
// existed and it is wrong now (2026-09-04 ticket): this pointer asks *who are we still waiting
// on*, and a golfer who left will never score again, so waiting on them pins the highlight to
// their first blank hole for the rest of the round, on every phone, over someone who is not
// there. Departure is the ONLY thing filtered here, and only here — a departed golfer keeps
// their column, their cells and their dots, because that column is the one surface that can mark
// their remaining holes picked-up (how a game resolves around an absence, accounts-only identity
// spec §4) and the only way to fix a hole they did play. Hiding it was designed and rejected.
//
// Reads through cellAt, never a raw membership check on `cells` — a cleared cell is RETAINED in
// state.cells (the fold invariant), so an `in`/key-presence test would treat a cleared cell as
// recorded and leave the highlight past a hole that actually needs re-entry.
//
// `RosterEntry`, not `Participant`: `departed` lives on the roster entry the fold produces.
// Everyone departed yields no pointer at all, which is honest — nobody is scoring that round.
//
// Departure is one of TWO causes of the same stuck pointer, and only this one is fixed here. A
// golfer who JOINS mid-round (joinRound refuses only a final round) has no cell on the holes
// played before they arrived and will never get one, so they pin the pointer to hole 1 exactly
// the same way. Not fixed with this, because the honest rule for that case — ignore a golfer's
// holes before their first cell — is a different predicate with its own edges, and this ticket
// was a departed golfer. Recorded in docs/papercuts.md rather than left for someone to rediscover.
const currentHoleNumber = (holes: readonly Hole[], participants: readonly RosterEntry[], cells: RoundState["cells"]): number | undefined => {
  const stillPlaying = participants.filter((participant) => participant.departed !== true);
  for (const hole of holes) {
    if (stillPlaying.some((p) => cellAt(cells, p.golferId, hole.number) === undefined)) return hole.number;
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
  // dotsForHoles (@swng/client) — the same sum totalDots does, restricted to this ONE segment
  // (totalDots only ever takes a whole per-hole map); this used to hand-roll the reduce inline
  // (task-5 fix round, spec 2026-07-30 §10 review M5).
  const dotsSum = dotsForHoles(dots, segmentHoles);
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
      {/* Dots are strokes RECEIVED, always: the hollow ○ give-back glyph a plus handicap used to
          draw has no reachable state and is deleted with the convention.

          `> 0`, not `!== 0`, and that is the whole guard (review fix round 1). `strokes` is
          non-negative by ONE enforcement point — `strokesInputSchema`'s `min(0)` at the request
          ingress (contracts/commands.ts); the old `resolveStrokes` clamp went with the derivation
          this arc deleted. That single point is the CORRECT placement, not a gap: the only other
          candidate is the stored/fold schema, and a bound there rejects data already written,
          bricking a legitimate round on a read path (Arc A's placement rule). So the render
          degrades instead of trusting: a negative that cannot legitimately exist draws no dot
          rather than throwing `RangeError` out of `"●".repeat(-1)`, which would blank the whole
          card for every player over one bad cell. The number itself still shows. */}
      {dots > 0 && (
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

  const holes = canonicalHoles(state.card, state.holes);
  const current = currentHoleNumber(holes, state.participants, state.cells);

  // The STANDARD CARD's dots: each player's own roster strokes — the number someone typed (spec
  // 2026-07-30 §2) — allocated by stroke index, no game, computed once per render (spec
  // 2026-07-19 §2a). A MEDAL game's dots agree with this by construction; a MATCH game's are the
  // difference off its own lowest and deliberately do not, which its own panel states in words.
  const dotsByGolfer = roundStrokeAllocation(state.participants, state.card, state.holes);

  // OUT / IN only mean anything when the round plays two nines. A round that set out to play ONE
  // nine gets the single unambiguous TOT row, exactly as a nine-hole card already does — and the
  // back nine must take that path too, so the split is by COUNT, not by hole number (a back
  // nine's hole numbers are all above 9, so a numeric split — `h.number <= 9` / `h.number > 9` —
  // would put NOTHING in OUT and all nine holes in IN, rather than treating it as one nine).
  const outHoles = holes.slice(0, 9);
  const inHoles = holes.slice(9);
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
                      sake (review fix, task-4 fix round 1). parForHoles (@swng/client) replaces
                      a hand-rolled reduce that duplicated ResultsView.tsx's own par total (task-5
                      fix round, spec 2026-07-30 §10 review M5). */}
                  <div>Par {parForHoles(segment.holes)}</div>
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

      {/* `!readOnly` closes the one hole a disabled cell leaves open: a pad opened while the card
          was live is still mounted, and still posts, when readOnly is raised under it. Unreachable
          for the archived caller (readOnly is true before any selection can be made) and the whole
          point for the finalize-in-flight one. `selection` is deliberately NOT cleared with it —
          if the attempt is refused (offline) the round is still live, so restoring the golfer's
          own half-finished tap is the least surprising resumption. */}
      {!readOnly && selection && selectedParticipant && selectedHole && (
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
