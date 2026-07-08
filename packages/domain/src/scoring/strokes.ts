import type { TeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";

export const roundHalfUp = (value: number): number => Math.floor(value + 0.5);

export const allocateStrokes = (strokes: number, teeSet: TeeSet): number[] => {
  const holeCount = teeSet.holes.length;
  const magnitude = Math.abs(strokes);
  const base = Math.floor(magnitude / holeCount);
  const extra = magnitude % holeCount;

  return teeSet.holes.map(({ strokeIndex }) => {
    if (strokes >= 0) {
      return base + (strokeIndex <= extra ? 1 : 0);
    }
    // Plus handicaps give strokes back rather than take them: mirror the
    // positive rule by walking from the EASIEST hole (highest strokeIndex)
    // instead of the hardest, so a full lap still spreads evenly and the
    // dots sum exactly to the (negative) allocation.
    const giveBack = base + (strokeIndex > holeCount - extra ? 1 : 0);
    return giveBack === 0 ? 0 : -giveBack;
  });
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
