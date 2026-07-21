import type { IndexComputation } from "../handicap/whs.js";
import { combineNineHoleDifferentials, computeIndexDetail, swngIndex } from "../handicap/whs.js";
import type { RoundId } from "../ids.js";
import { roundHalfUp } from "../scoring/strokes.js";
import type { GolferBests, Milestone } from "./analytics.js";
import { bestsOf, milestonesOf } from "./analytics.js";
import type { GolferRoundLine } from "./record.js";
import type { IndexSource } from "./golfer.js";

// One derived number over the golfer's rounds; difficulty labeling lives in the UI, not here.
export interface IndexMetric {
  readonly value: number;
  readonly differentialsUsed: number;
}

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

// One point on "your index over time": the golfer's index AS OF this round — recomputed from the
// rounds up to and including it. swngIndex covers every round; whsIndex holds flat across unrated
// rounds and is absent only before any rated round exists. Both 0.1 (the engines round).
export interface IndexPoint {
  readonly roundId: RoundId;
  readonly swngIndex?: number;
  readonly whsIndex?: number;
}

// The metrics projection (handicap-model legibility spec §2, §9; unrated-courses spec §6;
// papercut 17 — the record grows to a rolling chart): a read over the golfer's round lines
// producing every derived index in one place. `whsIndex` is Rule 5.2a over RATED differentials
// only (the existing `differential !== undefined` filter — unrated rounds carry none, so they
// cannot reach it); `swngIndex` is the WHS fold EXTENDED to unrated rounds — real `differential`
// when rated, `ags − par` only when unrated — over every ags-bearing round, so a rated-only
// golfer's swngIndex equals their whsIndex exactly. `typicalEighteen` and `indexHistory` are
// REQUIRED — always present, zeros/`[]` when there's no data, unlike the optional index members
// above which stay absent below their own bootstrap. `typicalEighteen` is the career scoring
// buckets (every line, rated or unrated) normalized to a per-18-hole rate, so a golfer who plays
// mostly 9s isn't shown a deflated total. `indexHistory` is "your index over time" — one point
// per round, oldest → newest (the order `lines` itself arrives in — getMyRecord's own sortLines
// contract), each recomputed from every line up to and including it; the headline whsIndex/
// swngIndex above is exactly `indexHistory`'s own last point. `bests`/`milestones` (analytics
// spec 2026-07-21 §3) are read over the same lines' `holeResults` via `analytics.ts`'s
// `bestsOf`/`milestonesOf` — REQUIRED like typicalEighteen/indexHistory (an empty `{}`/`[]` is
// the honest answer for a golfer with no fully holed-out lines yet, never absent). Grows to N
// members when a surface needs them — adding a metric is adding a field here, not carving a new
// pathway. Read-time only, never stored: the fold is pure (no clock); the application stamps
// time on the wire.
export interface GolferMetrics {
  readonly whsIndex?: IndexMetric;
  readonly swngIndex?: IndexMetric;
  readonly typicalEighteen: ScoringShape; // per-18 rate (zeros when no decided holes)
  readonly indexHistory: readonly IndexPoint[]; // oldest → newest
  readonly bests: GolferBests;
  readonly milestones: readonly Milestone[];
}

// The current whs + swng index detail from a set of lines — ONE fold, reused by the headline
// (all lines) and by each indexHistory prefix, so the WHS/swng math is never written twice.
const detailsOf = (lines: readonly GolferRoundLine[]): { whs?: IndexComputation; swng?: IndexComputation } => {
  const rated = lines.filter((line) => line.differential !== undefined);
  const whs = computeIndexDetail(
    combineNineHoleDifferentials(rated.map((line) => ({ differential: line.differential!, holes: line.holes }))),
  );
  const swng = swngIndex(lines);
  return { ...(whs !== undefined ? { whs } : {}), ...(swng !== undefined ? { swng } : {}) };
};

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
  const { whs, swng } = detailsOf(lines);
  const indexHistory: readonly IndexPoint[] = lines.map((line, k) => {
    const d = detailsOf(lines.slice(0, k + 1));
    return {
      roundId: line.roundId,
      ...(d.swng !== undefined ? { swngIndex: d.swng.value } : {}),
      ...(d.whs !== undefined ? { whsIndex: d.whs.value } : {}),
    };
  });
  return {
    ...(whs !== undefined ? { whsIndex: { value: whs.value, differentialsUsed: whs.differentialsUsed } } : {}),
    ...(swng !== undefined ? { swngIndex: { value: swng.value, differentialsUsed: swng.differentialsUsed } } : {}),
    typicalEighteen: typicalEighteenOf(lines),
    indexHistory,
    bests: bestsOf(lines),
    milestones: milestonesOf(lines),
  };
};

// "Your index" is never stored — it is resolved every read from the chosen source and the live
// metrics (index-source model spec §4). `undefined` is first-class: a computed source with no
// data yet resolves to `undefined`, NOT 0. A missing source defaults to swng — the model's
// default (spec §3). The `metrics` param is STRUCTURAL (just the two `{ value }` members) so both
// the domain `GolferMetrics` above and the richer wire metrics (getMyRecord's response, which
// also carries `computedAtMs`/`differentialsUsed`) satisfy it without a conversion step.
export interface ResolvedIndex {
  readonly value: number | undefined;
  readonly kind: IndexSource["kind"];
}

export const resolveIndex = (
  source: IndexSource | undefined,
  metrics: { readonly whsIndex?: { readonly value: number }; readonly swngIndex?: { readonly value: number } },
): ResolvedIndex => {
  const chosen = source ?? { kind: "swng" as const };
  switch (chosen.kind) {
    case "swng":
      return { value: metrics.swngIndex?.value, kind: "swng" };
    case "whs":
      return { value: metrics.whsIndex?.value, kind: "whs" };
    case "declared":
      return { value: chosen.value, kind: "declared" };
  }
};
