import type { Hole } from "../course/card.js";
import { DomainError } from "../errors.js";

export const roundHalfUp = (value: number): number => Math.floor(value + 0.5);

// Dots on the hardest holes first, wrapping past a full lap. Takes the holes BEING PLAYED, not a
// tee set, and ranks them among themselves (spec 2026-08-02 §3d): a nine drawn out of an eighteen
// carries stroke indexes 2, 4 … 18, so reading `strokeIndex` raw would hand out a fraction of the
// typed strokes. Rank ≡ strokeIndex whenever the whole card is played, so this changes no existing
// number — pinned in strokes.test.ts.
//
// Non-negative by construction: a player's strokes are asserted, and the request schema bounds
// them at min(0), so nobody ever gives strokes back.
export const allocateStrokes = (strokes: number, holes: readonly Hole[]): number[] => {
  const holeCount = holes.length;
  const base = Math.floor(strokes / holeCount);
  const extra = strokes % holeCount;

  // Rank 1 is the hardest hole AMONG THESE. Ties are impossible on a real card (stroke index is a
  // permutation within a tee set), so a plain ascending sort is a total ranking.
  const rankByHole = new Map(
    [...holes]
      .sort((a, b) => a.strokeIndex - b.strokeIndex)
      .map((hole, index) => [hole.number, index + 1] as const),
  );

  return holes.map((hole) => base + (rankByHole.get(hole.number)! <= extra ? 1 : 0));
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
