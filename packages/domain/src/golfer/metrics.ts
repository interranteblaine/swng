import { combineNineHoleDifferentials, computeIndexDetail, suggestedIndex } from "../handicap/whs.js";
import type { GolferRoundLine } from "./record.js";

// One derived number over the golfer's rounds; difficulty labeling lives in the UI, not here.
export interface IndexMetric {
  readonly value: number;
  readonly differentialsUsed: number;
}

// The metrics projection (unrated-courses spec §6): a read over the golfer's round lines
// producing every derived index in one place. `whsIndex` is Rule 5.2a over RATED differentials
// only (the existing `differential !== undefined` filter — unrated rounds carry none, so they
// cannot reach it); `suggestedIndex` is the neutral-course estimate over `ags − par`, every
// ags-bearing round. Grows to N members (scoring-vs-par, distribution, trend) when a surface
// needs them — adding a metric is adding a field here, not carving a new pathway. Read-time
// only, never stored: the fold is pure (no clock); the application stamps time on the wire.
export interface GolferMetrics {
  readonly whsIndex?: IndexMetric;
  readonly suggestedIndex?: IndexMetric;
}

export const golferMetrics = (lines: readonly GolferRoundLine[]): GolferMetrics => {
  const rated = lines.filter((line) => line.differential !== undefined);
  const whs = computeIndexDetail(
    combineNineHoleDifferentials(rated.map((line) => ({ differential: line.differential!, holes: line.holes }))),
  );
  const suggested = suggestedIndex(lines);
  return {
    ...(whs !== undefined ? { whsIndex: { value: whs.value, differentialsUsed: whs.differentialsUsed } } : {}),
    ...(suggested !== undefined ? { suggestedIndex: { value: suggested.value, differentialsUsed: suggested.differentialsUsed } } : {}),
  };
};
