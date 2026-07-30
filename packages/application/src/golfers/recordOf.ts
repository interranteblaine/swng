import type { GolferMetrics, GolferRoundLine } from "@swng/domain";
import { golferMetrics } from "@swng/domain";
import { sortLines } from "../projections/projectArchive.js";

// The store's finalizedAtMs/createdAtMs cross the wire under GetMyRounds' own names
// (finalizedAt/createdAt) — the index chart's date anchors need them (index-chart-polish
// spec §1.6). Optional on the wire; always present in practice for finalizedAt.
const toWireLine = (
  line: GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number },
): GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number } => ({
  roundId: line.roundId,
  courseName: line.courseName,
  // courseId (course-cards spec §4, the analytics join key) — omitted for pre-scrap lines
  // whose card carried no source (tolerated as absent, no migration).
  ...(line.courseId !== undefined ? { courseId: line.courseId } : {}),
  tee: line.tee,
  holes: line.holes,
  par: line.par,
  // The strokes this player played off, and the round's own gross (absent when the card carries a
  // pickup or a gap). `score` is what a history row renders: holeResults never crosses the wire.
  strokes: line.strokes,
  ...(line.score !== undefined ? { score: line.score } : {}),
  distribution: line.distribution,
  finalizedAt: line.finalizedAtMs,
  ...(line.createdAtMs !== undefined ? { createdAt: line.createdAtMs } : {}),
});

// The shared lines→{metrics, history} fold (navigation spec §6a): "the SAME lines-to-
// {metrics, history} fold getMyRecord runs, extracted to one shared helper both use cases
// call — never a second implementation." getMyRecord.ts (self) and getGolfer.ts (anyone,
// GET /golfers/{golferId}) both call this. `lines` is a golfer's raw, UNORDERED store rows
// (ProjectionStore.listLines' own contract) — sortLines gives oldest→newest for the index
// fold (golferMetrics), and `.reverse()` turns that same order into newest-first for the wire
// history, one ordering serving both consumers.
//
// `metrics` is the BARE domain GolferMetrics, and BOTH responses now serve it as-is: the
// read-time `computedAtMs` stamp that used to ride getMyRecord's own whsIndex went with the index
// itself (spec 2026-07-29 §7), so there is no longer any difference between the two shapes.
// `recordOf([])` is already the honest empty answer (golferMetrics([]) yields a zeroed
// typicalEighteen + empty averageHistory, no average/spread) — there is no separate "no data"
// branch to keep in sync.
export const recordOf = (
  lines: readonly (GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number })[],
): { metrics: GolferMetrics; history: readonly (GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number })[] } => {
  const sorted = sortLines(lines);
  return {
    metrics: golferMetrics(sorted),
    history: sorted.reverse().map(toWireLine),
  };
};
