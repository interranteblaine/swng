import type { Hole } from "../course/card.js";
import { DomainError } from "../errors.js";

export const roundHalfUp = (value: number): number => Math.floor(value + 0.5);

// Dots on the hardest holes first, wrapping past a full lap. Takes the holes BEING PLAYED, not a
// tee set, and ranks them among themselves (spec 2026-08-02 §3d): a nine drawn out of an eighteen
// carries stroke indexes 2, 4 … 18, so reading `strokeIndex` raw would hand out a fraction of the
// typed strokes. Rank ≡ strokeIndex whenever the whole card is played, because stroke index is a
// VALIDATED permutation of 1..N within a tee set (course/course.ts:65-68 throws
// `invalid-stroke-index` otherwise) — so this changes no existing number, pinned in
// strokes.test.ts.
//
// Non-negative by construction: a player's strokes are asserted, and the request schema bounds
// them at min(0), so nobody ever gives strokes back.
export const allocateStrokes = (strokes: number, holes: readonly Hole[]): number[] => {
  const holeCount = holes.length;
  const base = Math.floor(strokes / holeCount);
  const extra = strokes % holeCount;

  // Rank 1 is the hardest hole AMONG THESE, by POSITION in `holes` — not by hole.number, which
  // would collapse two holes that happened to share a number into one rank and silently drop
  // dots (a fragility this function did not use to have, back when it read strokeIndex directly
  // off each hole with no cross-hole lookup at all). Ties are impossible on a real card (stroke
  // index is the validated permutation cited above), so sorting positions by strokeIndex is a
  // total ranking.
  const positionsByRank = holes.map((_, position) => position).sort((a, b) => holes[a]!.strokeIndex - holes[b]!.strokeIndex);
  const rankByPosition = new Array<number>(holeCount);
  positionsByRank.forEach((position, i) => {
    rankByPosition[position] = i + 1;
  });

  return holes.map((_, position) => base + (rankByPosition[position]! <= extra ? 1 : 0));
};

// Hole-number → dots lookup, computed from a SINGLE allocateStrokes run. Callers that need dots
// for every hole (a full scorecard) must build this once and reuse it — calling
// strokesReceivedOnHole per hole instead re-runs allocateStrokes per hole, which is O(holes²) for
// no benefit since one allocation already covers the round.
export const dotsByHole = (strokes: number, holes: readonly Hole[]): ReadonlyMap<number, number> => {
  const dots = allocateStrokes(strokes, holes);
  return new Map(holes.map((hole, index) => [hole.number, dots[index]!]));
};

export const strokesReceivedOnHole = (strokes: number, holes: readonly Hole[], hole: number): number => {
  const dots = dotsByHole(strokes, holes).get(hole);
  if (dots === undefined) throw new DomainError("unknown-hole", `no hole numbered ${hole}`);
  return dots;
};

export const netDoubleBogey = (par: number, strokesReceived: number): number => par + 2 + strokesReceived;

// A cell's net score: gross minus the dots allocated on that hole. Dots are never negative
// (allocateStrokes above), so a net is never above its gross. Callers decide WHEN to show a net
// (e.g. only where dots !== 0); this is only the arithmetic.
export const netStrokes = (gross: number, dots: number): number => gross - dots;
