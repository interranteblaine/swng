import { roundHalfUp } from "../scoring/strokes.js";
import type { GolferBests, Milestone } from "./analytics.js";
import { bestsOf, milestonesOf } from "./analytics.js";
import type { AveragePoint } from "./average.js";
import { averageHistory, averageOf, spreadOf } from "./average.js";
import type { GolferRoundLine } from "./record.js";

// A scoring profile shaped like GolferRoundLine.distribution — used both per-round (there) and
// as a normalized career rate here (typicalEighteen).
export interface ScoringShape {
  readonly eagles: number;
  readonly birdies: number;
  readonly pars: number;
  readonly bogeys: number;
  readonly doublePlus: number;
}

const ZERO_SHAPE: ScoringShape = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };

// The metrics projection (spec 2026-07-29 §5): a read over the golfer's round lines producing
// every derived number in one place, computed at read time and never stored.
//
// `average` is what the golfer normally shoots relative to par over their last AVERAGE_WINDOW
// FINISHED rounds (average.ts owns the arithmetic — score minus par, a nine doubled, a round
// containing a pickup skipped whole because it has no score). `spread` is the standard deviation
// over the same set, gated at five rounds. Both are OPTIONAL: absent is the honest answer for a
// golfer with no round that carries a score, never a 0 and never an invented floor.
//
// `typicalEighteen` and `averageHistory` are REQUIRED — always present, zeros/`[]` when there's
// no data, unlike the two optional members above. `typicalEighteen` is the career scoring buckets
// (every line) normalized to a per-18-hole rate, so a golfer who plays mostly 9s isn't shown a
// deflated total. `averageHistory` is "your average over time" — ONE point per CONTRIBUTING
// round, oldest → newest (the order `lines` itself arrives in — getMyRecord's own sortLines
// contract), each the rolling average as of that round; the headline `average` above is exactly
// averageHistory's own last point. `bests`/`milestones` (analytics spec 2026-07-21 §3) are read
// over the same lines' `holeResults` via analytics.ts's `bestsOf`/`milestonesOf` — REQUIRED the
// same way (an empty `{}`/`[]` is the honest answer for a golfer with no fully holed-out lines
// yet, never absent). Grows to N members when a surface needs them — adding a metric is adding a
// field here, not carving a new pathway. The fold is pure (no clock); the application stamps time
// on the wire.
export interface GolferMetrics {
  readonly average?: number; // vs par per 18, over the last AVERAGE_WINDOW scored rounds
  readonly spread?: number; // standard deviation over the same set, 1 decimal, gated at 5 rounds
  readonly typicalEighteen: ScoringShape; // per-18 rate (zeros when no decided holes)
  readonly averageHistory: readonly AveragePoint[]; // oldest → newest, contributing rounds only
  readonly bests: GolferBests;
  readonly milestones: readonly Milestone[];
}

const typicalEighteenOf = (lines: readonly GolferRoundLine[]): ScoringShape => {
  const t = lines.reduce(
    (acc, l) => ({
      eagles: acc.eagles + l.distribution.eagles,
      birdies: acc.birdies + l.distribution.birdies,
      pars: acc.pars + l.distribution.pars,
      bogeys: acc.bogeys + l.distribution.bogeys,
      doublePlus: acc.doublePlus + l.distribution.doublePlus,
    }),
    ZERO_SHAPE,
  );
  const holes = t.eagles + t.birdies + t.pars + t.bogeys + t.doublePlus;
  if (holes === 0) return ZERO_SHAPE;
  const per18 = (n: number) => roundHalfUp((n / holes) * 18);
  return {
    eagles: per18(t.eagles),
    birdies: per18(t.birdies),
    pars: per18(t.pars),
    bogeys: per18(t.bogeys),
    doublePlus: per18(t.doublePlus),
  };
};

export const golferMetrics = (lines: readonly GolferRoundLine[]): GolferMetrics => {
  const average = averageOf(lines);
  const spread = spreadOf(lines);
  return {
    ...(average !== undefined ? { average } : {}),
    ...(spread !== undefined ? { spread } : {}),
    typicalEighteen: typicalEighteenOf(lines),
    averageHistory: averageHistory(lines),
    bests: bestsOf(lines),
    milestones: milestonesOf(lines),
  };
};
