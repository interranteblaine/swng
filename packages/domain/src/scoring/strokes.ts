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

export const strokesReceivedOnHole = (strokes: number, teeSet: TeeSet, hole: number): number => {
  const index = teeSet.holes.findIndex((h) => h.number === hole);
  const dots = index === -1 ? undefined : allocateStrokes(strokes, teeSet)[index];
  if (dots === undefined) throw new DomainError("unknown-hole", `no hole numbered ${hole}`);
  return dots;
};

export const netDoubleBogey = (par: number, strokesReceived: number): number => par + 2 + strokesReceived;
