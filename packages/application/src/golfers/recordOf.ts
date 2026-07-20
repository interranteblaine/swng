import type { GolferMetrics, GolferRoundLine } from "@swng/domain";
import { golferMetrics, postedDifferential } from "@swng/domain";
import { sortLines } from "../projections/projectArchive.js";

// Strips the projection store's internal finalizedAtMs (sort metadata, not part of the
// wire shape) — a wire history line is exactly GolferRoundLine, not an extension of it.
const toWireLine = (line: GolferRoundLine & { readonly finalizedAtMs: number }): GolferRoundLine => ({
  roundId: line.roundId,
  courseName: line.courseName,
  // courseId (course-cards spec §4, the analytics join key) — omitted for pre-scrap lines
  // whose card carried no source (tolerated as absent, no migration).
  ...(line.courseId !== undefined ? { courseId: line.courseId } : {}),
  tee: line.tee,
  holes: line.holes,
  par: line.par,
  courseHandicap: line.courseHandicap,
  ...(line.ags !== undefined ? { ags: line.ags } : {}),
  // A posted differential is a one-decimal value (postedDifferential's own doc comment) — the
  // wire NEVER carries the raw full-precision figure the index fold averages internally. Only
  // this display step rounds; golferMetrics below still folds the RAW `sorted` lines.
  ...(line.differential !== undefined ? { differential: postedDifferential(line.differential) } : {}),
  distribution: line.distribution,
});

// The shared lines→{metrics, history} fold (navigation spec §6a): "the SAME lines-to-
// {metrics, history} fold getMyRecord runs, extracted to one shared helper both use cases
// call — never a second implementation." getMyRecord.ts (self) and getGolfer.ts (anyone,
// GET /golfers/{golferId}) both call this. `lines` is a golfer's raw, UNORDERED store rows
// (ProjectionStore.listLines' own contract) — sortLines gives oldest→newest for the index
// fold (golferMetrics), and `.reverse()` turns that same order into newest-first for the wire
// history, one ordering serving both consumers.
//
// `metrics` here is the BARE domain GolferMetrics — no `computedAtMs` on whsIndex. That
// read-time stamp is getMyRecord.ts's own addition on top of this fold's output (it needs a
// Clock this pure function doesn't take); getGolfer.ts serves the bare shape as-is
// (GetGolferResponse's own `metrics: GolferMetrics` field). `recordOf([])` is already the
// honest empty answer (golferMetrics([]) yields a zeroed typicalEighteen + empty indexHistory,
// no computed indexes) — there is no separate "no data" branch to keep in sync.
export const recordOf = (
  lines: readonly (GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number })[],
): { metrics: GolferMetrics; history: readonly GolferRoundLine[] } => {
  const sorted = sortLines(lines);
  return {
    metrics: golferMetrics(sorted),
    history: sorted.reverse().map(toWireLine),
  };
};
