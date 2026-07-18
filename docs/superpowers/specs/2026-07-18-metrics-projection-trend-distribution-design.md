# The metrics read-projection grows: trend + distribution move server-side (papercut 17)

- **Date:** 2026-07-18
- **Status:** Owner-approved design session (this document is the record). It realizes the intent
  already written into `domain/golfer/metrics.ts`: *"Grows to N members (scoring-vs-par,
  distribution, trend) when a surface needs them — adding a metric is adding a field here, not
  carving a new pathway."* This is that growth for two of those members.
- **Why this exists:** the profile's **scoring distribution** and **index trend** are hand-computed
  in the web today — `DistributionBars` runs a `history.reduce` and `trendPoints` slices/filters the
  differentials into sparkline points (`apps/web/src/routes/ProfilePage.tsx`). That is UI computing
  career analytics, not rendering them. The metrics read-projection already computes the golfer's
  indices server-side and serves them; distribution and trend are the same kind of derived number
  and belong in the same place. Move the math into `golferMetrics`, serve it on the wire, and let
  the front end render it — thin front end, proper API.

## 1. The one-sentence model

**`golferMetrics` is the golfer's read-projection: every derived number over their round lines,
computed once at read time on the server and served on the wire; the front end renders it and
computes nothing.**

## 2. Architecture — no front-end computation

The metric is computed exactly where the indices already are: `golferMetrics(lines)` in
`@swng/domain`, called by `getMyRecord` (`@swng/application`) at read time over the golfer's lines,
serialized onto `GetMyRecordResponse.metrics`. The web's `ProfilePage` **deletes** its `trendPoints`
extraction and its `DistributionBars` `reduce`, and renders `record.metrics.distribution` /
`record.metrics.trend` directly — the same "render the projection" relationship it already has to
`record.metrics.swngIndex` / `whsIndex`.

The rejected alternative — a domain function the *web* calls over the `history` it receives — was
considered and rejected: it puts the derivation trigger back in the front end (the front end should
render the projection, not invoke it), splits one read-projection into two functions, and serves no
purpose the server projection doesn't already serve. There is one metrics projection; it lives on
the server; the API carries it.

## 3. The model — two new members on `GolferMetrics`

```ts
export interface ScoringDistribution {
  readonly eagles: number;
  readonly birdies: number;
  readonly pars: number;
  readonly bogeys: number;
  readonly doublePlus: number;
}

export interface GolferMetrics {
  readonly whsIndex?: IndexMetric;
  readonly swngIndex?: IndexMetric;
  readonly distribution: ScoringDistribution;   // NEW: career totals across ALL lines (zeros if none)
  readonly trend: readonly number[];            // NEW: the newest ≤20 posted differentials, oldest→newest
}
```

- **`distribution` is REQUIRED** (an object, zeros for a golfer with no rounds) — it always renders,
  exactly as `DistributionBars` renders all-zero bars today for a new golfer. The index members
  stay optional (they are `undefined` until enough data); distribution is always computable.
- **`trend` is REQUIRED** (an array, empty or short when there are <2 posted differentials). The
  *rendering* guard ("draw nothing with fewer than 2 points") stays a view decision; the *data* is
  the metric.

## 4. Semantics — byte-identical to what the web computes today

- **distribution:** the career sum of each per-line `distribution` bucket across ALL lines
  (`eagles/birdies/pars/bogeys/doublePlus`) — the whole history, not the trend's 20-round window
  (matching `DistributionBars`' own "summed across the WHOLE history" comment). The per-round
  `GolferRoundLine.distribution` is **unchanged and stays on the line** (raw per-round data); only
  the aggregate is new.
- **trend:** the posted **differentials** (a line with no differential — an unrated or incomplete
  round — contributes none), filtered first, then the newest ≤20 kept in **oldest→newest** order.
  `golferMetrics` receives lines in chronological (oldest→newest) order — the same order the WHS
  index fold already assumes (`getMyRecord` passes `sortLines(...)`) — so trend is
  `differentials.slice(-20)`. This equals today's `history` (newest-first) `.filter().slice(0,20).reverse()`.
- **The trend stays a differential series** (ordinal x-axis, no dates) — semantics unchanged from
  today; this is a move, not a redesign (a dated/index-over-time trend is explicitly out of scope).

## 5. The wire (`GetMyRecordResponse.metrics`)

`metrics` gains two REQUIRED members mirroring the domain:

```ts
metrics: {
  whsIndex?: { value; computedAtMs; differentialsUsed };
  swngIndex?: { value; differentialsUsed };
  distribution: { eagles; birdies; pars; bogeys; doublePlus };   // NEW, required
  trend: readonly number[];                                      // NEW, required
}
```

`getMyRecord` already computes `golferMetrics(sorted)`; it now spreads `distribution` and `trend`
(both always present — a plain spread, not a conditional one) onto the wire metrics beside the
indices. `history` is unchanged (each line keeps its own `distribution`).

## 6. Deploy order & data

- **Backend change → `deploy:beta`, LAMBDA-FIRST.** The new `metrics` members are **required**, so:
  the old web bundle against the new backend is fine (its `getMyRecordResponseSchema` is non-strict
  and silently strips the two extra keys); the new bundle against the *old* backend would throw on
  the missing required fields. Deploy the lambda first, then `publishWeb` — the house pattern.
- **No data migration, no wipe.** distribution and trend are computed on read from the golfer's
  existing lines; nothing is stored, no round-line field is added (unlike the unrated-courses arc).
  A `rebuildProjections` is not needed and neither is a scrap.

## 7. System boundaries (blast radius)

- **`@swng/domain`** (`golfer/metrics.ts`): add `ScoringDistribution`; add `distribution` + `trend`
  to `GolferMetrics`; `golferMetrics` computes them. `resolveIndex`'s structural `metrics` param is
  unaffected (it reads only `whsIndex?`/`swngIndex?`). The per-line `GolferRoundLine.distribution`
  (`golfer/record.ts`) is **untouched**.
- **`@swng/contracts`** (`golfers.ts`): `GetMyRecordResponse.metrics` + `getMyRecordResponseSchema`
  gain the two required members.
- **`@swng/application`** (`getMyRecord.ts`): spread `distribution` + `trend` onto the wire metrics.
- **`@swng/web`** (`routes/ProfilePage.tsx`): delete `trendPoints` and the `DistributionBars`
  `reduce`; `IndexTrend` renders from `metrics.trend`, `DistributionBars` from `metrics.distribution`
  (the `DISTRIBUTION_ROWS` label table stays — labels are a view concern). No other web file.
- **Untouched:** the index math, `resolveIndex`, the strokes/handicap engine, the sealed round, the
  per-round line, the projector, the store.

## 8. Testing intent

- **Domain (`metrics.test.ts`):** `golferMetrics` — distribution sums each bucket across all lines;
  trend is the newest ≤20 differentials oldest→newest; a line with no differential (unrated/
  incomplete) is EXCLUDED from trend but its distribution STILL counts; >20 posted differentials →
  trend keeps exactly the newest 20; empty lines → `distribution` all-zeros and `trend` empty. A
  parity check that the domain trend equals the old `history.filter().slice(0,20).reverse()` for a
  fixed multi-line fixture.
- **Contract (`golfers.test.ts`):** `getMyRecordResponseSchema` accepts metrics carrying
  distribution + trend and REJECTS metrics missing either (they are required).
- **Application (`getMyRecord.test.ts`):** the response's `metrics.distribution`/`metrics.trend`
  equal `golferMetrics(sortedLines)`'s for a fixture with rated + unrated + incomplete lines.
- **Web (`ProfilePage.test.tsx`):** `DistributionBars` renders the values from
  `metrics.distribution` (not a recomputed reduce); `IndexTrend` renders a polyline from
  `metrics.trend` and renders nothing when `trend.length < 2`. The deleted hand-compute tests go
  with the deleted code.

## 9. Close-out (controller-run gate)

`deploy:beta` LAMBDA-FIRST → `publishWeb` → `e2e:beta` ×2 → `e2e:field` → a controller browser walk
on the DEPLOYED `beta.swng.golf`. **The walk needs a golfer with history** — ≥2 posted (rated)
differentials to render a trend, and scored holes to show a non-zero distribution — so the walk
plays/seeds a short multi-round history (or drives an existing e2e history account) rather than a
fresh account whose panels are empty; a fresh-account walk would render the same empty state as
before and prove nothing (the walk-the-feature-with-real-data lesson). Then the docs sweep
(CLAUDE.md arc paragraph).

## 10. Out of scope / deferred

- **Scoring-vs-par** — the third member the `metrics.ts` comment names — is NOT built here (YAGNI;
  no surface renders it). It remains a one-field-later addition when a surface needs it.
- **A dated / index-over-time trend** — the trend stays the existing ordinal differential series.
- **Any change to the per-round line, the index math, or stored data.**
