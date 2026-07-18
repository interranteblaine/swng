import { combineNineHoleDifferentials, computeIndexDetail, swngIndex } from "../handicap/whs.js";
import type { GolferRoundLine } from "./record.js";
import type { IndexSource } from "./golfer.js";

// One derived number over the golfer's rounds; difficulty labeling lives in the UI, not here.
export interface IndexMetric {
  readonly value: number;
  readonly differentialsUsed: number;
}

// A career scoring profile: par-relative hole buckets, summed across every round line (papercut
// 17 — the same shape GolferRoundLine.distribution already carries per round; this is a sum, not
// a recomputation from cells).
export interface ScoringDistribution {
  readonly eagles: number;
  readonly birdies: number;
  readonly pars: number;
  readonly bogeys: number;
  readonly doublePlus: number;
}

const zeroDistribution: ScoringDistribution = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };

// The metrics projection (handicap-model legibility spec §2, §9; unrated-courses spec §6): a
// read over the golfer's round lines producing every derived index in one place. `whsIndex` is
// Rule 5.2a over RATED differentials only (the existing `differential !== undefined` filter —
// unrated rounds carry none, so they cannot reach it); `swngIndex` is the WHS fold EXTENDED to
// unrated rounds — real `differential` when rated, `ags − par` only when unrated — over every
// ags-bearing round, so a rated-only golfer's swngIndex equals their whsIndex exactly.
// `distribution` and `trend` (papercut 17) are REQUIRED — always present, zeros/`[]` when there's
// no data, unlike the optional index members above which stay absent below their own bootstrap.
// `distribution` is a career total (every line, rated or unrated); `trend` is the posted
// (rated) differentials, oldest → newest (the order `lines` itself arrives in — getMyRecord's own
// sortLines contract), capped at the newest 20. Grows to N members when a surface needs them —
// adding a metric is adding a field here, not carving a new pathway. Read-time only, never
// stored: the fold is pure (no clock); the application stamps time on the wire.
export interface GolferMetrics {
  readonly whsIndex?: IndexMetric;
  readonly swngIndex?: IndexMetric;
  readonly distribution: ScoringDistribution;
  readonly trend: readonly number[];
}

export const golferMetrics = (lines: readonly GolferRoundLine[]): GolferMetrics => {
  const rated = lines.filter((line) => line.differential !== undefined);
  const whs = computeIndexDetail(
    combineNineHoleDifferentials(rated.map((line) => ({ differential: line.differential!, holes: line.holes }))),
  );
  const swng = swngIndex(lines);
  const distribution = lines.reduce<ScoringDistribution>(
    (acc, l) => ({
      eagles: acc.eagles + l.distribution.eagles,
      birdies: acc.birdies + l.distribution.birdies,
      pars: acc.pars + l.distribution.pars,
      bogeys: acc.bogeys + l.distribution.bogeys,
      doublePlus: acc.doublePlus + l.distribution.doublePlus,
    }),
    zeroDistribution,
  );
  return {
    ...(whs !== undefined ? { whsIndex: { value: whs.value, differentialsUsed: whs.differentialsUsed } } : {}),
    ...(swng !== undefined ? { swngIndex: { value: swng.value, differentialsUsed: swng.differentialsUsed } } : {}),
    distribution,
    trend: rated.map((line) => line.differential!).slice(-20),
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
