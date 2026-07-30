import type { RoundId } from "../ids.js";
import { scoredStrokes } from "../round/holeResult.js";
import type { GolferRoundLine } from "./record.js";

// Every hole has a NUMBER (analytics spec 2026-07-21 §2, the shared definition every fold below
// reuses) — expressed through `scoredStrokes`, the ONE accessor for "does this cell carry a
// stroke count" (round/holeResult.ts), rather than a hand-rolled kind test that could drift from
// it. There used to be a stricter `fullyHoledOut` beside this (a conceded putt meant you didn't
// hole out, so it gated Best and the broke-N milestones while this predicate gated the average)
// — that distinction died with the `conceded` arm (task-1, spec §7): once a gimme is just a
// `strokes` cell, "has a number" and "holed out" are the same question, so `fullyHoledOut` and
// its `grossOf` sum are gone and every caller (Best, the broke-N milestones, the average, the
// course record) reads this one predicate. `holeResults` is absent on lines written before the
// analytics arc (backfilled by one `rebuildProjections` run); such a line is TOLERATED as
// incomplete, never counted as a zero-gross round, never a throw.
export const hasCompleteScore = (line: GolferRoundLine): boolean =>
  line.holeResults !== undefined &&
  line.holeResults.length === line.holes &&
  line.holeResults.every((h) => scoredStrokes(h.result) !== undefined);

// Sum over a line with a complete score — call only when hasCompleteScore(line) (the
// `holeResults!` documents that precondition rather than re-checking it).
export const scoreOf = (line: GolferRoundLine): number =>
  line.holeResults!.reduce((sum, h) => sum + (scoredStrokes(h.result) ?? 0), 0);

// One record: the round that set it, its gross, and gross relative to that round's own frozen
// par (spec §3).
export interface BestRound {
  readonly roundId: RoundId;
  readonly gross: number;
  readonly toPar: number;
}

// Lowest gross among fully-scored lines of that hole count, per hole count independently — a
// 9-hole scramble round never contends for the 18-hole record and vice versa. Absent when no
// line of that hole count has a complete score. There is no holed-out gate: a 79 with two
// gimmes is your best round (spec §7).
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
      if (line.holes !== holes || !hasCompleteScore(line)) continue;
      const gross = scoreOf(line);
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
  // A per-hole scan through `scoredStrokes`, the one accessor for "does this cell carry a
  // stroke count" — a birdie is a birdie whether the ball dropped or the group called it good.
  const firstHole = (test: (underPar: number) => boolean): RoundId | undefined =>
    lines.find((line) =>
      line.holeResults?.some((h) => {
        const strokes = scoredStrokes(h.result);
        return strokes !== undefined && test(h.par - strokes);
      }),
    )?.roundId;
  // The broke-N milestones are a claim about a WHOLE CARD, so they ride hasCompleteScore/scoreOf
  // — the same predicate/sum pair Best uses.
  const firstBroke = (threshold: number): RoundId | undefined =>
    lines.find((line) => line.holes === 18 && hasCompleteScore(line) && scoreOf(line) < threshold)?.roundId;
  const found: { kind: MilestoneKind; roundId: RoundId | undefined }[] = [
    { kind: "first-birdie", roundId: firstHole((u) => u === 1) },
    { kind: "first-eagle", roundId: firstHole((u) => u >= 2) },
    { kind: "broke-100", roundId: firstBroke(100) },
    { kind: "broke-90", roundId: firstBroke(90) },
    { kind: "broke-80", roundId: firstBroke(80) },
  ];
  return found.filter((m): m is Milestone => m.roundId !== undefined);
};
