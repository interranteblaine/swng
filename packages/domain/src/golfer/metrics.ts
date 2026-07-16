import { combineNineHoleDifferentials, computeIndexDetail, swngIndex } from "../handicap/whs.js";
import type { GolferRoundLine } from "./record.js";

// One derived number over the golfer's rounds; difficulty labeling lives in the UI, not here.
export interface IndexMetric {
  readonly value: number;
  readonly differentialsUsed: number;
}

// The metrics projection (handicap-model legibility spec §2, §9; unrated-courses spec §6): a
// read over the golfer's round lines producing every derived index in one place. `whsIndex` is
// Rule 5.2a over RATED differentials only (the existing `differential !== undefined` filter —
// unrated rounds carry none, so they cannot reach it); `swngIndex` is the WHS fold EXTENDED to
// unrated rounds — real `differential` when rated, `ags − par` only when unrated — over every
// ags-bearing round, so a rated-only golfer's swngIndex equals their whsIndex exactly. Grows to
// N members (scoring-vs-par, distribution, trend) when a surface needs them — adding a metric is
// adding a field here, not carving a new pathway. Read-time only, never stored: the fold is pure
// (no clock); the application stamps time on the wire.
export interface GolferMetrics {
  readonly whsIndex?: IndexMetric;
  readonly swngIndex?: IndexMetric;
}

export const golferMetrics = (lines: readonly GolferRoundLine[]): GolferMetrics => {
  const rated = lines.filter((line) => line.differential !== undefined);
  const whs = computeIndexDetail(
    combineNineHoleDifferentials(rated.map((line) => ({ differential: line.differential!, holes: line.holes }))),
  );
  const swng = swngIndex(lines);
  return {
    ...(whs !== undefined ? { whsIndex: { value: whs.value, differentialsUsed: whs.differentialsUsed } } : {}),
    ...(swng !== undefined ? { swngIndex: { value: swng.value, differentialsUsed: swng.differentialsUsed } } : {}),
  };
};
