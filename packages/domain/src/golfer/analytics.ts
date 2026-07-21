import type { RoundId } from "../ids.js";
import type { GolferRoundLine } from "./record.js";

// "Fully holed out" (analytics spec 2026-07-21 §2, the shared definition every fold below
// reuses): every hole of the tee set has a `strokes` result — no picked-up/conceded hole, and
// no gap. `holeResults` is absent on lines written before the analytics arc (backfilled by one
// `rebuildProjections` run); such a line is TOLERATED as never fully holed out, never counted
// as a zero-gross round, never a throw.
export const fullyHoledOut = (line: GolferRoundLine): boolean =>
  line.holeResults !== undefined &&
  line.holeResults.length === line.holes &&
  line.holeResults.every((h) => h.result.kind === "strokes");

// Sum of strokes over a fully holed-out line — call only when `fullyHoledOut(line)` (the
// `holeResults!` below documents that precondition rather than re-checking it; a card with any
// non-strokes hole has nothing meaningful to sum).
export const grossOf = (line: GolferRoundLine): number =>
  line.holeResults!.reduce((sum, h) => sum + (h.result.kind === "strokes" ? h.result.strokes : 0), 0);

// One record: the round that set it, its gross, and gross relative to that round's own frozen
// par (spec §3).
export interface BestRound {
  readonly roundId: RoundId;
  readonly gross: number;
  readonly toPar: number;
}

// Lowest gross among fully holed-out lines of that hole count, per hole count independently — a
// 9-hole scramble round never contends for the 18-hole record and vice versa. Absent when no
// line of that hole count is fully holed out.
export interface GolferBests {
  readonly best18?: BestRound;
  readonly best9?: BestRound;
}

export type MilestoneKind = "first-birdie" | "first-eagle" | "broke-100" | "broke-90" | "broke-80";

// Achieved-only — a milestone not yet reached is simply absent from the array, never a
// placeholder entry.
export interface Milestone {
  readonly kind: MilestoneKind;
  readonly roundId: RoundId;
}

// Lowest gross per hole count; tie goes to the EARLIER round — first to set a record holds it,
// so the scan uses strict `<` (an equal-or-later gross never displaces the incumbent) over
// `lines` in their oldest→newest arrival order (golferMetrics' own contract).
export const bestsOf = (lines: readonly GolferRoundLine[]): GolferBests => {
  const bestFor = (holes: 9 | 18): BestRound | undefined => {
    let best: BestRound | undefined;
    for (const line of lines) {
      if (line.holes !== holes || !fullyHoledOut(line)) continue;
      const gross = grossOf(line);
      if (best === undefined || gross < best.gross) best = { roundId: line.roundId, gross, toPar: gross - line.par };
    }
    return best;
  };
  const best18 = bestFor(18);
  const best9 = bestFor(9);
  return { ...(best18 ? { best18 } : {}), ...(best9 ? { best9 } : {}) };
};

// Each kind's earliest qualifying line, achieved-only. The output array is in the FIXED kind
// order below (a stable wire order) — never chronological by achievement date, so an eagle shot
// before a golfer's first birdie still lists "first-birdie" ahead of "first-eagle".
export const milestonesOf = (lines: readonly GolferRoundLine[]): readonly Milestone[] => {
  const firstHole = (test: (underPar: number) => boolean): RoundId | undefined =>
    lines.find((line) => line.holeResults?.some((h) => h.result.kind === "strokes" && test(h.par - h.result.strokes)))?.roundId;
  const firstBroke = (threshold: number): RoundId | undefined =>
    lines.find((line) => line.holes === 18 && fullyHoledOut(line) && grossOf(line) < threshold)?.roundId;
  const found: { kind: MilestoneKind; roundId: RoundId | undefined }[] = [
    { kind: "first-birdie", roundId: firstHole((u) => u === 1) },
    { kind: "first-eagle", roundId: firstHole((u) => u >= 2) },
    { kind: "broke-100", roundId: firstBroke(100) },
    { kind: "broke-90", roundId: firstBroke(90) },
    { kind: "broke-80", roundId: firstBroke(80) },
  ];
  return found.filter((m): m is Milestone => m.roundId !== undefined);
};
