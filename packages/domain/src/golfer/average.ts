import type { RoundId } from "../ids.js";
import { roundHalfUp } from "../scoring/strokes.js";
import { hasCompleteScore, scoreOf } from "./analytics.js";
import type { GolferRoundLine } from "./record.js";

// What you normally shoot relative to par, per 18 holes (spec 2026-07-29 §2c). A golfer can check
// it by adding up the rounds on their own profile — which is the whole point. A nine-hole round
// contributes its figure DOUBLED: imperfect and accepted (spec §2d).
export const AVERAGE_WINDOW = 10;
const SPREAD_MIN_ROUNDS = 5;

export const overPar = (line: GolferRoundLine): number => {
  const raw = scoreOf(line) - line.par;
  return line.holes === 9 ? raw * 2 : raw;
};

// Only rounds with a score. A pickup means there is no score, so no number is invented for it.
export const scoredOverPar = (lines: readonly GolferRoundLine[]): readonly number[] =>
  lines.filter(hasCompleteScore).map(overPar);

const meanOf = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

// Exported so the crew board can average its OWN set (every finished round in the season
// window) without re-deriving the arithmetic — the board must not silently apply this file's
// rolling 10 on top of the season window (spec §6).
export const averageOfValues = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : roundHalfUp(meanOf(values));

export const spreadOfValues = (values: readonly number[]): number | undefined => {
  if (values.length < SPREAD_MIN_ROUNDS) return undefined;
  const mean = meanOf(values);
  return roundHalfUp(Math.sqrt(meanOf(values.map((v) => (v - mean) ** 2))) * 10) / 10;
};

export const averageOf = (lines: readonly GolferRoundLine[]): number | undefined =>
  averageOfValues(scoredOverPar(lines).slice(-AVERAGE_WINDOW));

export const spreadOf = (lines: readonly GolferRoundLine[]): number | undefined =>
  spreadOfValues(scoredOverPar(lines).slice(-AVERAGE_WINDOW));

export interface AveragePoint {
  readonly roundId: RoundId;
  readonly average: number;
}

// One point per CONTRIBUTING round — a round with a pickup is not a data point.
export const averageHistory = (lines: readonly GolferRoundLine[]): readonly AveragePoint[] => {
  const window: number[] = [];
  const points: AveragePoint[] = [];
  for (const line of lines) {
    if (!hasCompleteScore(line)) continue;
    window.push(overPar(line));
    if (window.length > AVERAGE_WINDOW) window.shift();
    points.push({ roundId: line.roundId, average: averageOfValues(window)! });
  }
  return points;
};
