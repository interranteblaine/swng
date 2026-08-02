import type { CourseId } from "../ids.js";
import { scoredStrokes } from "../round/holeResult.js";
import { roundHalfUp } from "../scoring/strokes.js";
import type { BestRound } from "./analytics.js";
import { hasCompleteScore, scoreOf } from "./analytics.js";
import type { GolferRoundLine } from "./record.js";

// "Your record here" — the per-course fold over a golfer's own lines (analytics spec 2026-07-21
// §4). `rounds`/`best*`/`scoringAverage*` show from the golfer's 1st round at the course; the
// per-hole `insights` block is gated behind ≥5 rounds AT THIS COURSE (the domain owns the gate,
// never the web — the index-over-time ≥8-round precedent). Lines arrive oldest→newest (the
// golferMetrics contract) — tie-breaks and "most recent par" both lean on that order.
//
// best/scoringAverage are split by hole count (round-plays-a-nine spec 2026-08-02, Finding 1):
// before that arc one courseId could only ever produce lines of one hole count, so a single
// number was safe. Now a course can hold both a front/back-nine round and an 18-hole round, and
// mixing their gross totals produces nonsense (a 45 on 9 holes reading as the course "best", or a
// 9-and-an-18 averaged together). `bestsOf` (analytics.ts) and `crewScoreboard` already treat a
// nine and an eighteen as separate record classes — this mirrors `bestsOf` exactly rather than
// inventing a normalization. The per-hole `insights` block is untouched: it aggregates by hole
// NUMBER, so a nine simply contributes nine holes to it, same as it always has.

export interface CourseHoleInsight {
  readonly hole: number;
  readonly par: number;
  readonly plays: number;
}

export interface CourseRecord {
  readonly rounds: number; // lines at this course, any state
  readonly best18?: BestRound;
  readonly best9?: BestRound;
  readonly scoringAverage18?: number; // mean gross over fully-scored 18-hole lines, 1 decimal
  readonly scoringAverage9?: number; // mean gross over fully-scored 9-hole lines, 1 decimal
  readonly insights?: {
    readonly worstHole?: CourseHoleInsight & { readonly avgOverPar: number; readonly doublePlus: number };
    readonly scoringHole?: CourseHoleInsight & { readonly parOrBetter: number };
    readonly neverBirdied?: readonly number[]; // present iff 1..3 holes remain
  };
}

const INSIGHTS_MIN_ROUNDS = 5;
const HOLE_INSIGHT_MIN_PLAYS = 3;
const NEVER_BIRDIED_MIN = 1;
const NEVER_BIRDIED_MAX = 3;

// One hole's running aggregate, built from every cell that carries a NUMBER (a `strokes` cell —
// spec §7: a gimme is recorded at its score, so it's already in there). A picked-up hole has no
// number and stays out. `par` tracks the MOST RECENT line's par for that hole regardless of that
// line's result kind (a later card revision's par is the truth even for a hole the golfer picked
// up on that round).
interface HoleAgg {
  par: number;
  strokesPlays: number; // holes played to a number here
  sumOverPar: number; // Σ(strokes − par) over those plays, unrounded — ranking uses this raw value
  doublePlus: number; // strokes ≥ par + 2
  parOrBetter: number; // strokes ≤ par
  underPar: number; // strokes < par (birdie or better)
}

// Aggregates every DECIDED cell across every line at this course that has `holeResults` — lines
// without it (pre-analytics-arc, until one rebuildProjections backfill) are skipped whole, never
// a throw or a zero. Reused by worstHole/scoringHole/neverBirdied so the three folds can never
// disagree about what a hole's numbers are.
const aggregateHoles = (lines: readonly GolferRoundLine[]): Map<number, HoleAgg> => {
  const holes = new Map<number, HoleAgg>();
  for (const line of lines) {
    if (!line.holeResults) continue;
    for (const h of line.holeResults) {
      const agg = holes.get(h.hole) ?? { par: h.par, strokesPlays: 0, sumOverPar: 0, doublePlus: 0, parOrBetter: 0, underPar: 0 };
      agg.par = h.par; // lines arrive oldest→newest, so the last write wins — "most recent line's par"
      const strokes = scoredStrokes(h.result);
      if (strokes !== undefined) {
        const overPar = strokes - h.par;
        agg.strokesPlays += 1;
        agg.sumOverPar += overPar;
        if (overPar >= 2) agg.doublePlus += 1;
        if (overPar <= 0) agg.parOrBetter += 1;
        if (overPar < 0) agg.underPar += 1;
      }
      holes.set(h.hole, agg);
    }
  }
  return holes;
};

// worstHole: highest mean strokes-over-par among ≥3-strokes-play holes; ties → more doublePlus,
// then the LOWER hole number. Comparison is over the RAW (unrounded) mean — avgOverPar in the
// output is rounded only for display, never for ranking.
const worstHoleOf = (holes: Map<number, HoleAgg>): (CourseHoleInsight & { avgOverPar: number; doublePlus: number }) | undefined => {
  let best: { hole: number; agg: HoleAgg; mean: number } | undefined;
  for (const [hole, agg] of holes) {
    if (agg.strokesPlays < HOLE_INSIGHT_MIN_PLAYS) continue;
    const mean = agg.sumOverPar / agg.strokesPlays;
    const better =
      best === undefined ||
      mean > best.mean ||
      (mean === best.mean && (agg.doublePlus > best.agg.doublePlus || (agg.doublePlus === best.agg.doublePlus && hole < best.hole)));
    if (better) best = { hole, agg, mean };
  }
  if (!best) return undefined;
  return {
    hole: best.hole,
    par: best.agg.par,
    plays: best.agg.strokesPlays,
    avgOverPar: roundHalfUp(best.mean * 10) / 10,
    doublePlus: best.agg.doublePlus,
  };
};

// scoringHole: highest par-or-better RATE among ≥3-strokes-play holes; ties → the LOWER hole
// number. `parOrBetter` in the output is the raw count (the phrase states it "of N plays"), never
// the rate itself.
const scoringHoleOf = (holes: Map<number, HoleAgg>): (CourseHoleInsight & { parOrBetter: number }) | undefined => {
  let best: { hole: number; agg: HoleAgg; rate: number } | undefined;
  for (const [hole, agg] of holes) {
    if (agg.strokesPlays < HOLE_INSIGHT_MIN_PLAYS) continue;
    const rate = agg.parOrBetter / agg.strokesPlays;
    const better = best === undefined || rate > best.rate || (rate === best.rate && hole < best.hole);
    if (better) best = { hole, agg, rate };
  }
  if (!best) return undefined;
  return { hole: best.hole, par: best.agg.par, plays: best.agg.strokesPlays, parOrBetter: best.agg.parOrBetter };
};

// neverBirdied: holes with ≥1 strokes-play and zero under-par plays, ascending by hole number —
// shown only when 1..3 remain (0 is nothing to say; 4+ is noise, the web never sees the count).
const neverBirdiedOf = (holes: Map<number, HoleAgg>): readonly number[] | undefined => {
  const remaining = [...holes.entries()]
    .filter(([, agg]) => agg.strokesPlays >= 1 && agg.underPar === 0)
    .map(([hole]) => hole)
    .sort((a, b) => a - b);
  return remaining.length >= NEVER_BIRDIED_MIN && remaining.length <= NEVER_BIRDIED_MAX ? remaining : undefined;
};

export const courseRecord = (lines: readonly GolferRoundLine[], courseId: CourseId): CourseRecord => {
  const courseLines = lines.filter((line) => line.courseId === courseId);
  const rounds = courseLines.length;

  const fullyScored = courseLines.filter(hasCompleteScore);

  // Lowest gross among fully-scored lines of that hole count, per hole count independently — the
  // `bestsOf` (analytics.ts) precedent applied to one course instead of a whole career.
  const bestFor = (holes: 9 | 18): BestRound | undefined => {
    let best: BestRound | undefined;
    for (const line of fullyScored) {
      if (line.holes !== holes) continue;
      const gross = scoreOf(line);
      if (best === undefined || gross < best.gross) best = { roundId: line.roundId, gross, toPar: gross - line.par };
    }
    return best;
  };
  const best18 = bestFor(18);
  const best9 = bestFor(9);

  const averageFor = (holes: 9 | 18): number | undefined => {
    const scored = fullyScored.filter((line) => line.holes === holes);
    return scored.length > 0 ? roundHalfUp((scored.reduce((sum, line) => sum + scoreOf(line), 0) / scored.length) * 10) / 10 : undefined;
  };
  const scoringAverage18 = averageFor(18);
  const scoringAverage9 = averageFor(9);

  const insights =
    rounds >= INSIGHTS_MIN_ROUNDS
      ? (() => {
          const holes = aggregateHoles(courseLines);
          const worstHole = worstHoleOf(holes);
          const scoringHole = scoringHoleOf(holes);
          const neverBirdied = neverBirdiedOf(holes);
          return {
            ...(worstHole ? { worstHole } : {}),
            ...(scoringHole ? { scoringHole } : {}),
            ...(neverBirdied ? { neverBirdied } : {}),
          };
        })()
      : undefined;

  return {
    rounds,
    ...(best18 !== undefined ? { best18 } : {}),
    ...(best9 !== undefined ? { best9 } : {}),
    ...(scoringAverage18 !== undefined ? { scoringAverage18 } : {}),
    ...(scoringAverage9 !== undefined ? { scoringAverage9 } : {}),
    ...(insights !== undefined ? { insights } : {}),
  };
};
