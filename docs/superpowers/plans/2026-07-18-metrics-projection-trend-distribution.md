# Metrics projection: trend + distribution move server-side — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Move the profile's scoring-distribution and index-trend math out of the web's hand-rolled
`reduce`/slice and into the `golferMetrics` server read-projection, served on the wire, so the front
end renders `record.metrics.*` and computes nothing.

**Authority:** `docs/superpowers/specs/2026-07-18-metrics-projection-trend-distribution-design.md` is
the source of truth. Read it first. The per-round `GolferRoundLine.distribution`, the index math,
and the sealed round are unchanged and must not be touched.

**Architecture:** `golferMetrics(lines)` in `@swng/domain` grows two required members
(`distribution`, `trend`); `getMyRecord` (`@swng/application`) already calls it and now serializes
them onto `GetMyRecordResponse.metrics` (`@swng/contracts`); `ProfilePage` (`@swng/web`) deletes its
`trendPoints`/`reduce` and renders the wire fields. Backend change → `deploy:beta` LAMBDA-FIRST, then
`publishWeb`; no data migration (computed on read from existing lines).

**Tech Stack:** TypeScript ESM, Zod, React 19, Vitest + happy-dom, Playwright.

## Global Constraints

- **The metrics projection is server-side (spec §2).** No front-end aggregation — the web renders
  `record.metrics.distribution` / `record.metrics.trend`; it does not compute them.
- **The two new members (spec §3):**
  ```ts
  export interface ScoringDistribution {
    readonly eagles: number; readonly birdies: number; readonly pars: number;
    readonly bogeys: number; readonly doublePlus: number;
  }
  // on GolferMetrics: distribution: ScoringDistribution (REQUIRED, zeros if none);
  //                   trend: readonly number[] (REQUIRED, empty/short if <2 differentials).
  ```
  The index members (`whsIndex?`/`swngIndex?`) stay OPTIONAL. distribution/trend are always
  computable, so they are required (not optional).
- **Semantics byte-identical to today (spec §4):** distribution = career sum of each per-line
  `distribution` bucket across ALL lines; trend = posted **differentials** (a line without one
  contributes none), filtered first, then the newest ≤20 in **oldest→newest** order — and because
  `golferMetrics` receives chronological (oldest→newest) lines, that is `differentials.slice(-20)`.
  This equals the web's current `history` (newest-first) `.filter().slice(0,20).reverse()`.
- **`GolferRoundLine.distribution` (the per-round line) is UNTOUCHED** — only the aggregate is new.
- **Deploy LAMBDA-FIRST** (new required wire fields; old bundle strips extras, new bundle needs
  them). No wipe, no `rebuildProjections`.
- Conditional-spread optional keys — never an explicit `undefined`. distribution/trend are always
  present, so they are a PLAIN spread/assignment, not conditional.
- `pnpm validate` GREEN at the end of each task; `pnpm test:contract` green after the contracts task.
- If a node/pnpm command dies with a `MODULE_NOT_FOUND` cmux/NODE_OPTIONS preload error, re-run
  prefixed with `NODE_OPTIONS=`. Web/domain focused test: `NODE_OPTIONS= pnpm -F <pkg> exec vitest run <path>`.
- Commit per task; `feat`/`refactor(scope): …` + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push.
- Controller-only (not a task): `deploy:beta`, `publishWeb`, live gates, the browser walk, CLAUDE.md.

---

### Task 1: Domain — `golferMetrics` grows distribution + trend

**Files:**
- Modify: `packages/domain/src/golfer/metrics.ts`
- Test: `packages/domain/src/golfer/metrics.test.ts`

**Interfaces (Produces):** `ScoringDistribution` (5 int members); `GolferMetrics.distribution:
ScoringDistribution` and `GolferMetrics.trend: readonly number[]` (both required).

- [ ] **Step 1:** Write failing tests in `metrics.test.ts`:

```ts
import { golferMetrics } from "./metrics.js";
// a minimal line factory — only the fields golferMetrics reads
const line = (differential: number | undefined, dist: Partial<Record<"eagles"|"birdies"|"pars"|"bogeys"|"doublePlus", number>> = {}) =>
  ({
    roundId: "r" as never, courseName: "C", tee: "white", holes: 18 as const, par: 72, courseHandicap: 10,
    ...(differential !== undefined ? { differential, ags: 90 } : {}),
    distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0, ...dist },
  }) as unknown as import("./record.js").GolferRoundLine;

describe("golferMetrics distribution + trend", () => {
  it("distribution sums each bucket across ALL lines (rated and not)", () => {
    const m = golferMetrics([line(10.0, { birdies: 1, pars: 10 }), line(undefined, { pars: 5, bogeys: 3 })]);
    expect(m.distribution).toEqual({ eagles: 0, birdies: 1, pars: 15, bogeys: 3, doublePlus: 0 });
  });
  it("trend is the posted differentials, oldest→newest, excluding lines without one", () => {
    const m = golferMetrics([line(12.0), line(undefined), line(10.5), line(11.0)]);
    expect(m.trend).toEqual([12.0, 10.5, 11.0]);
  });
  it("trend keeps only the newest 20 differentials (oldest→newest)", () => {
    const lines = Array.from({ length: 25 }, (_, i) => line(i)); // differentials 0..24, chronological
    expect(golferMetrics(lines).trend).toEqual(Array.from({ length: 20 }, (_, i) => i + 5)); // newest 20: 5..24
  });
  it("empty lines → zero distribution and empty trend", () => {
    const m = golferMetrics([]);
    expect(m.distribution).toEqual({ eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 });
    expect(m.trend).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run: `NODE_OPTIONS= pnpm -F @swng/domain exec vitest run src/golfer/metrics.test.ts` — FAIL (distribution/trend undefined).

- [ ] **Step 3:** In `metrics.ts`, add `ScoringDistribution` and extend `GolferMetrics` (update the
  interface's doc comment to note distribution/trend are now realized, no longer "grows to"):

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
  // Career scoring totals across ALL lines (zeros for a golfer with no rounds) and the newest ≤20
  // posted differentials oldest→newest (a differential series; a line without one — unrated/
  // incomplete — contributes none). Computed at read time from the lines, never stored, same as the
  // indices above. `lines` arrive chronological (oldest→newest), so trend is differentials.slice(-20).
  readonly distribution: ScoringDistribution;
  readonly trend: readonly number[];
}
```

- [ ] **Step 4:** In `golferMetrics`, compute both and add to the returned object (plain, always
  present — not a conditional spread):

```ts
export const golferMetrics = (lines: readonly GolferRoundLine[]): GolferMetrics => {
  const rated = lines.filter((line) => line.differential !== undefined);
  const whs = computeIndexDetail(
    combineNineHoleDifferentials(rated.map((line) => ({ differential: line.differential!, holes: line.holes }))),
  );
  const swng = swngIndex(lines);
  const distribution = lines.reduce<ScoringDistribution>(
    (acc, line) => ({
      eagles: acc.eagles + line.distribution.eagles,
      birdies: acc.birdies + line.distribution.birdies,
      pars: acc.pars + line.distribution.pars,
      bogeys: acc.bogeys + line.distribution.bogeys,
      doublePlus: acc.doublePlus + line.distribution.doublePlus,
    }),
    { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  );
  // Newest ≤20 differentials, oldest→newest. Lines are chronological, so filter-then-slice(-20)
  // equals the web's old newest-first `.filter().slice(0,20).reverse()`.
  const trend = rated.map((line) => line.differential!).slice(-20);
  return {
    ...(whs !== undefined ? { whsIndex: { value: whs.value, differentialsUsed: whs.differentialsUsed } } : {}),
    ...(swng !== undefined ? { swngIndex: { value: swng.value, differentialsUsed: swng.differentialsUsed } } : {}),
    distribution,
    trend,
  };
};
```

- [ ] **Step 5:** Run the test — PASS. Then `NODE_OPTIONS= pnpm -F @swng/domain exec vitest run` — all
  domain green. (Confirm `ScoringDistribution` surfaces from the barrel — `metrics.js` is already
  `export *`-ed in `src/index.ts`, so the new type is exported automatically.)

- [ ] **Step 6:** `NODE_OPTIONS= pnpm validate` — GREEN. Commit:
  `feat(domain): golferMetrics grows distribution + trend — the read-projection, not the UI, computes them`.

---

### Task 2: Contracts + Application — the wire carries it, `getMyRecord` serves it

Combined because the wire fields are REQUIRED: the moment the contract requires them, `getMyRecord`
(which constructs the response) and every `GetMyRecordResponse` test fixture must provide them, or
typecheck breaks. One coherent green commit.

**Files:**
- Modify: `packages/contracts/src/golfers.ts`, `packages/application/src/golfers/getMyRecord.ts`
- Test: `packages/contracts/src/golfers.test.ts`, `packages/application/src/golfers/getMyRecord.test.ts`
- Sweep: any test fixture constructing a `GetMyRecordResponse` / a `metrics` object.

**Interfaces (Consumes):** `ScoringDistribution` from `@swng/domain`. **(Produces):**
`GetMyRecordResponse.metrics.distribution` (required) + `.trend: readonly number[]` (required).

- [ ] **Step 1:** `contracts/golfers.ts` — extend the `GetMyRecordResponse.metrics` interface and
  `getMyRecordResponseSchema`. Add to the interface's `metrics`:

```ts
    readonly distribution: { readonly eagles: number; readonly birdies: number; readonly pars: number; readonly bogeys: number; readonly doublePlus: number };
    readonly trend: readonly number[];
```
  and to the schema's `metrics: z.object({ … })`:

```ts
    distribution: z.object({ eagles: z.number().int(), birdies: z.number().int(), pars: z.number().int(), bogeys: z.number().int(), doublePlus: z.number().int() }),
    trend: z.array(z.number()).readonly(),
```
  Update the `GetMyRecordResponse` doc comment to note distribution + trend are part of the metrics
  read-projection (computed at read time, never stored — same framing as the indices).

- [ ] **Step 2:** Contract tests in `golfers.test.ts`: `getMyRecordResponseSchema` accepts a metrics
  object carrying `distribution` + `trend`; REJECTS one missing `distribution`, and one missing
  `trend` (both required). An empty-history shape `{ metrics: { distribution: {…zeros}, trend: [] }, history: [] }` parses.

- [ ] **Step 3:** `application/getMyRecord.ts` — spread the two new members onto the wire metrics
  (they are always present on `golferMetrics`'s result, so a plain spread):

```ts
    const metrics = golferMetrics(sorted);

    return {
      metrics: {
        ...(metrics.whsIndex !== undefined
          ? { whsIndex: { value: metrics.whsIndex.value, computedAtMs: deps.clock.now(), differentialsUsed: metrics.whsIndex.differentialsUsed } }
          : {}),
        ...(metrics.swngIndex !== undefined ? { swngIndex: metrics.swngIndex } : {}),
        distribution: metrics.distribution,
        trend: metrics.trend,
      },
      history: sorted.reverse().map(toWireLine),
    };
```
  Note the empty-record early return `return { metrics: {}, history: [] }` (getMyRecord.ts:35) now
  fails typecheck — `metrics` requires distribution + trend. Fix it to the honest empty shape:

```ts
    if (!found) return { metrics: { distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, trend: [] }, history: [] };
```

- [ ] **Step 4:** `getMyRecord.test.ts` — assert the response's `metrics.distribution` and
  `metrics.trend` equal `golferMetrics(sortedLines)`'s for a fixture mixing rated + unrated +
  incomplete lines; assert the no-golfer early return carries zero distribution + empty trend.

- [ ] **Step 5:** Fixture sweep — every OTHER test that constructs a `GetMyRecordResponse` or a bare
  `metrics` object now needs the two required members. Find them:
  `grep -rn "metrics:" packages apps --include=*.ts --include=*.tsx | grep -viE "dist/|\.metrics\.|metricsStore" | grep -iE "whsIndex|swngIndex|GetMyRecord|metrics: \{\}"`
  and the web mocks: `grep -rn "metrics:" apps/web/src --include=*.tsx`. Add
  `distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, trend: []` (or
  meaningful values where a test asserts them) to each. The ProfilePage test's metrics fixtures are
  updated fully in Task 3; here, just make every fixture typecheck (add the zero/empty members).

- [ ] **Step 6:** `NODE_OPTIONS= pnpm validate` + `NODE_OPTIONS= pnpm test:contract` — GREEN. Commit:
  `feat(contracts,application): GET /me/record serves distribution + trend on metrics`.

---

### Task 3: Web — ProfilePage renders the projection, deletes the hand-compute

**Files:**
- Modify: `apps/web/src/routes/ProfilePage.tsx`
- Test: `apps/web/src/routes/ProfilePage.test.tsx`

- [ ] **Step 1:** Delete `trendPoints` (`ProfilePage.tsx:11-19`). Change `IndexTrend` to take the
  points directly from the metric:

```tsx
function IndexTrend({ points }: { readonly points: readonly number[] }) {
  if (points.length < 2) return null; // nothing to trend with 0-1 posted differentials
  const width = 280;
  const height = 72;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const coords = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg role="img" aria-label="Index trend" viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="rounded-lg bg-slate-900 text-emerald-400">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}
```
  (The `x`/`y` `.toFixed(1)` are SVG pixel coordinates — unrelated to the handicap-index format gate.)

- [ ] **Step 2:** Change `DistributionBars` to take the aggregate from the metric and drop the
  `reduce` (keep `DISTRIBUTION_ROWS` — labels are a view concern). Its `DistributionKey` type keys off
  the wire distribution shape:

```tsx
type DistributionKey = keyof GetMyRecordResponse["metrics"]["distribution"];
const DISTRIBUTION_ROWS: readonly { readonly key: DistributionKey; readonly label: string }[] = [
  { key: "eagles", label: "Eagle or better" },
  { key: "birdies", label: "Birdie" },
  { key: "pars", label: "Par" },
  { key: "bogeys", label: "Bogey" },
  { key: "doublePlus", label: "Double bogey+" },
];

function DistributionBars({ distribution }: { readonly distribution: GetMyRecordResponse["metrics"]["distribution"] }) {
  const max = Math.max(1, ...DISTRIBUTION_ROWS.map((row) => distribution[row.key]));
  return (
    <ul aria-label="Scoring distribution" className="flex flex-col gap-1">
      {DISTRIBUTION_ROWS.map((row) => (
        <li key={row.key} className="flex items-center gap-2 text-sm text-slate-300">
          <span className="w-32 shrink-0 text-slate-400">{row.label}</span>
          <span className="h-3 min-w-[2px] rounded bg-emerald-700" style={{ width: `${(distribution[row.key] / max) * 100}%` }} />
          <span>{distribution[row.key]}</span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3:** Update the render site (the "Your record" section, ~`ProfilePage.tsx:372-373`). It
  currently passes `history`; pass the metric fields. `metrics` may be undefined before the record
  loads, so default to the empty shape:

```tsx
        <IndexTrend points={record?.metrics.trend ?? []} />
        <DistributionBars distribution={record?.metrics.distribution ?? { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }} />
```
  If `const history = record?.history ?? []` (`:220`) is now unused, remove it; if the history list
  below still uses it, leave it.

- [ ] **Step 4:** `ProfilePage.test.tsx` — delete the tests that exercised the old `trendPoints`/
  `reduce` and replace them: `DistributionBars` renders the values from `metrics.distribution`
  (assert a fixture with e.g. `birdies: 3` shows `3` in the "Scoring distribution" list, WITHOUT the
  component summing anything itself); `IndexTrend` renders a `<polyline>` when `metrics.trend` has ≥2
  points and renders nothing (no `img` role "Index trend") when it has <2. Any metrics fixture in
  this file gains real `distribution`/`trend` values where asserted (zeros/empty otherwise).

- [ ] **Step 5:** `NODE_OPTIONS= pnpm validate` — GREEN. Grep confirms the web no longer aggregates:
  `grep -n "reduce\|trendPoints\|\.distribution\[" apps/web/src/routes/ProfilePage.tsx` shows no
  history-aggregating `reduce` and no `trendPoints` (the only `distribution[row.key]` reads index the
  already-computed metric, not a per-line sum). Commit:
  `refactor(web): ProfilePage renders metrics.distribution + metrics.trend — no hand-rolled aggregation`.

---

### Task 4: E2E reconciliation + validate

**Files:** `apps/web/e2e/identityRecord.spec.ts` and any spec asserting the profile "Your record"
distribution or trend.

- [ ] **Step 1:** Grep the e2e dirs for assertions on the record panels:
  `grep -rn "Scoring distribution\|Index trend\|Eagle or better\|Birdie\|Double bogey\|Your record" apps/web/e2e e2e`.
  The rendered numbers are byte-identical (same computation, moved server-side) and the DOM structure
  (aria-labels "Scoring distribution" / "Index trend", the rows) is unchanged, so assertions on the
  displayed values or those labels stay valid — reconcile only if a spec keyed off the deleted
  `trendPoints`/`reduce` internals (it cannot from Playwright). If nothing needs changing (likely a
  zero-diff, as with prior arcs), record it in the report and do NOT create an empty commit.

- [ ] **Step 2:** `NODE_OPTIONS= pnpm validate` (typechecks/lints the specs; live runs are the
  controller's gate). If any spec changed, commit: `test(e2e): profile record panels read the served metrics`. If zero-diff, note it and skip the commit.

## Self-Review (performed while writing)
- **Spec coverage:** §2 server-computed/thin-web → Task 1 (domain) + Task 3 (web renders, no reduce);
  §3 the two required members → Task 1 (domain) + Task 2 (wire); §4 semantics (distribution = all-line
  sum, trend = differentials.slice(-20) = old newest-first filter/slice/reverse) → Task 1 Steps 1/4 +
  the parity assertion; §5 wire required + getMyRecord serialize + empty-return fix → Task 2; §6
  deploy lambda-first / no wipe → controller close-out (not a task); §7 GolferRoundLine untouched →
  no record.ts edit in any task; §8 tests → Steps in Tasks 1–3; §9 walk-needs-history → close-out.
- **No placeholders:** every step has concrete code or an exact command.
- **Type consistency:** `ScoringDistribution` is the SAME 5-int shape in domain, the contract's inline
  metrics object, and the web's `keyof …metrics.distribution`; `trend: readonly number[]` identical
  across domain/contract/web; `golferMetrics(sorted)`'s result feeds getMyRecord's spread unchanged.
- **Green-per-commit:** Task 1 is green alone (producer sets the new members; no consumer requires
  them yet); Task 2 combines the required-wire-field with its producer + the fixture sweep so
  typecheck stays green; Task 3 swaps the render and deletes the dead compute together.
- **Stays untouched:** the index math, `resolveIndex`, `GolferRoundLine.distribution`, the strokes/
  handicap engine, the projector, the store, the sealed round.
