import type { TeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";

export const roundHalfUp = (value: number): number => Math.floor(value + 0.5);

// Dots on the hardest holes first, wrapping past a full lap. Non-negative by construction: a
// player's strokes are asserted, and the request schema bounds them at min(0) (spec 2026-07-30
// §11), so nobody ever gives strokes back. The give-back branch that mirrored this rule from the
// EASIEST hole is deleted with the plus-handicap convention it served — a negative input now
// allocates negative dots hole-by-hole, which no caller can produce and no renderer accepts
// (ScorecardGrid's `"●".repeat(dots)` throws RangeError on one, which is what makes the bound
// load-bearing).
export const allocateStrokes = (strokes: number, teeSet: TeeSet): number[] => {
  const holeCount = teeSet.holes.length;
  const base = Math.floor(strokes / holeCount);
  const extra = strokes % holeCount;

  return teeSet.holes.map(({ strokeIndex }) => base + (strokeIndex <= extra ? 1 : 0));
};

// Hole-number → dots lookup, computed from a SINGLE allocateStrokes run. Callers that
// need dots for every hole (a full scorecard) must build this once and reuse it —
// calling strokesReceivedOnHole per hole instead re-runs allocateStrokes per hole,
// which is O(holes²) for no benefit since one allocation already covers the round.
export const dotsByHole = (strokes: number, teeSet: TeeSet): ReadonlyMap<number, number> => {
  const dots = allocateStrokes(strokes, teeSet);
  return new Map(teeSet.holes.map((hole, index) => [hole.number, dots[index]!]));
};

export const strokesReceivedOnHole = (strokes: number, teeSet: TeeSet, hole: number): number => {
  const dots = dotsByHole(strokes, teeSet).get(hole);
  if (dots === undefined) throw new DomainError("unknown-hole", `no hole numbered ${hole}`);
  return dots;
};

export const netDoubleBogey = (par: number, strokesReceived: number): number => par + 2 + strokesReceived;

// A cell's net score: gross minus the dots allocated on that hole. Dots are never negative
// (allocateStrokes above), so a net is never above its gross. Callers decide WHEN to show a net
// (e.g. only where dots !== 0); this is only the arithmetic.
export const netStrokes = (gross: number, dots: number): number => gross - dots;
