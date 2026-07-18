# Golfer record redesign — index over time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the profile's unlabeled differential sparkline with a rolling dual-index chart (swng + WHS, gated under 8 rounds), reframe the career distribution as a "typical 18," lead history rows with the score, and canonicalize the displayed differential to 0.1.

**Architecture:** All golf math stays in `@swng/domain` and is served on `GET /me/record` (the boundary from the restore-domain-boundary arc holds — the web plots served numbers, computing no golf result). `golferMetrics` grows `indexHistory` (each round's swng/WHS index recomputed from the rounds up to it) and `typicalEighteen`, and **loses** `trend` and `distribution`. The application rounds the wire `history[].differential` to 0.1. The web renders a two-line chart + gate, the typical-18 line, and score-first history.

**Tech Stack:** TypeScript ESM, Zod, React 19, Vitest.

**Authority:** `docs/superpowers/specs/2026-07-18-golfer-record-index-over-time-design.md`. Judge each change on the merits, not the spec's say-so.

## Global Constraints

- **The domain owns the numbers; the web renders.** Every derived value (`indexHistory`, `typicalEighteen`, the 0.1 differential) is computed in `@swng/domain` and served. `apps/web` plots/formats served numbers only — the ESLint compute fence still holds (a chart mapping `metrics.indexHistory` to SVG points is presentation; SVG coordinate math is view).
- **`indexHistory` point** = `{ roundId, swngIndex?, whsIndex? }`, **oldest→newest**. `swngIndex` = the swng index computed from rounds `0..k` (absent only if no ags-bearing round in that prefix). `whsIndex` = the WHS index from `0..k` (holds flat across unrated rounds; absent only before any rated round). Both **rounded to 0.1** (the index engines already round). The x-axis is round sequence — **no calendar date** (the wire history line carries no timestamp; adding one is out of scope, noted in the spec).
- **`typicalEighteen`** = each career bucket normalized to a per-18 rate: `roundHalfUp(bucket / holesDecided × 18)`; all-zero when there are no decided holes.
- **`trend` and `distribution` are DELETED** from `GolferMetrics` and the wire `metrics`. Nothing derives golf results from them anymore.
- **The index's internal precision is untouched.** Only the *displayed* differential is rounded (via a new `postedDifferential`); `scoreDifferential`/`computeIndexDetail`/`swngIndex` are not changed. `golferMetrics` receives the raw (unrounded) lines, exactly as today.
- **The 8-round gate** is one constant on the web; under it the chart is not drawn (a "keep going" message shows).
- Optional keys conditional-spread, never explicit `undefined`. Co-located `*.test.ts(x)`, `import ... from "vitest"`, per-file `.js` ESM imports.
- Green per commit: `NODE_OPTIONS= pnpm validate`; `pnpm test:contract` after the contract change. Downstream (web/app) resolves `@swng/domain` via built `dist/` — `NODE_OPTIONS= pnpm -F @swng/domain build` before a downstream focused test.
- Commit per task; `feat`/`refactor(scope): …` + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push.
- Controller-only (not a task): deploy (lambda + `publish:web:beta` together — the wire both adds and removes required fields, so deploy the lambda then publish/invalidate immediately; the only window is a stale cached bundle hitting the new response, self-healing on invalidation — no wipe), the live gates, the browser walk, CLAUDE.md.

---

### Task 1: Domain — `indexHistory`, `typicalEighteen`, `postedDifferential`; drop `trend`/`distribution`

**Files:**
- Modify: `packages/domain/src/golfer/metrics.ts`
- Modify: `packages/domain/src/handicap/whs.ts` (add `postedDifferential`)
- Test: `packages/domain/src/golfer/metrics.test.ts`, `packages/domain/src/handicap/whs.test.ts`

**Interfaces (Produces):**
- `ScoringShape { eagles; birdies; pars; bogeys; doublePlus: number }` (all required)
- `IndexPoint { roundId: RoundId; swngIndex?: number; whsIndex?: number }`
- `GolferMetrics` gains `typicalEighteen: ScoringShape` and `indexHistory: readonly IndexPoint[]` (both required); **loses** `distribution` and `trend`.
- `postedDifferential(differential: number): number` (0.1-rounded), from `@swng/domain`.

- [ ] **Step 1: Failing tests.** In `whs.test.ts` add a `postedDifferential` block: `postedDifferential(23.563565891472873) === 23.6`, `postedDifferential(0.7883720930232608) === 0.8`, `postedDifferential(8.672093023255819) === 8.7`, `postedDifferential(-1.25) === -1.2` (roundHalfUp: .05 up). In `metrics.test.ts`, replace the old `distribution`/`trend` describe blocks with:
  - `typicalEighteen`: over a fixture of 2 rated 18s + 1 unrated 9 whose per-round `distribution` buckets sum to a known career total, assert each bucket equals `roundHalfUp(total/holes×18)`; empty lines → all zeros.
  - `indexHistory`: for an oldest→newest fixture, assert `indexHistory[k].swngIndex`/`.whsIndex` equal `golferMetrics(lines.slice(0,k+1))`'s `swngIndex?.value`/`whsIndex?.value` at each `k`; the first point before any rated round has `whsIndex` absent but `swngIndex` present; an unrated round in the middle holds `whsIndex` flat (equal to the prior point); values are 0.1 (e.g. no long floats).
  - `golferMetrics` no longer returns `distribution` or `trend` (assert the keys are absent).
- [ ] **Step 2: Run — FAIL.** `NODE_OPTIONS= pnpm -F @swng/domain exec vitest run src/handicap/whs.test.ts src/golfer/metrics.test.ts`
- [ ] **Step 3: Implement `postedDifferential`** in `whs.ts` beside `scoreDifferential` (uses the file's existing `roundHalfUp`):

```ts
// A posted Score Differential is a one-decimal value — a golfer's record reads 23.6, not the raw
// full-precision figure the index averages internally (scoreDifferential stays unrounded on purpose;
// see its comment). Round only where the differential is SHOWN, never before it feeds the index.
export const postedDifferential = (differential: number): number => roundHalfUp(differential * 10) / 10;
```

- [ ] **Step 4: Rewrite `metrics.ts`.** Replace the `distribution`/`trend` members and their computation. Add `roundHalfUp` to the `../scoring/strokes.js` imports and `RoundId` to the `../ids.js` type import.

```ts
export interface ScoringShape {
  readonly eagles: number; readonly birdies: number; readonly pars: number;
  readonly bogeys: number; readonly doublePlus: number;
}

// One point on "your index over time": the golfer's index AS OF this round — recomputed from the
// rounds up to and including it. swngIndex covers every round; whsIndex holds flat across unrated
// rounds and is absent only before any rated round exists. Both 0.1 (the engines round).
export interface IndexPoint {
  readonly roundId: RoundId;
  readonly swngIndex?: number;
  readonly whsIndex?: number;
}

export interface GolferMetrics {
  readonly whsIndex?: IndexMetric;
  readonly swngIndex?: IndexMetric;
  readonly typicalEighteen: ScoringShape;      // per-18 rate (zeros when no decided holes)
  readonly indexHistory: readonly IndexPoint[]; // oldest→newest
}

const ZERO_SHAPE: ScoringShape = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };

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
  return { eagles: per18(t.eagles), birdies: per18(t.birdies), pars: per18(t.pars), bogeys: per18(t.bogeys), doublePlus: per18(t.doublePlus) };
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
  };
};
```
  Confirm `IndexComputation` is the type `computeIndexDetail`/`swngIndex` return (import it or the local alias already in scope). `resolveIndex` below is unchanged.
- [ ] **Step 5: Run — PASS.** Same command as Step 2. Then `NODE_OPTIONS= pnpm -F @swng/domain exec vitest run` (whole package) — GREEN.
- [ ] **Step 6: Commit** `feat(domain): the record is your index over time (rolling swng+WHS) and a typical-18 — differential trend and career distribution are gone`.

---

### Task 2: Contracts — the new `metrics` wire shape

**Files:**
- Modify: `packages/contracts/src/golfers.ts`
- Test: `packages/contracts/src/golfers.test.ts`

**Interfaces (Consumes):** the Task 1 `GolferMetrics` shape. **(Produces):** `GetMyRecordResponse.metrics` with `typicalEighteen` + `indexHistory`, no `distribution`/`trend`.

- [ ] **Step 1: Failing contract tests.** Update `golfers.test.ts` round-trip fixtures to the new shape (drop `distribution`/`trend`, add `typicalEighteen` + `indexHistory`). Add rejection tests: a `metrics` missing `typicalEighteen` throws; missing `indexHistory` throws.
- [ ] **Step 2: Run — FAIL.** `NODE_OPTIONS= pnpm -F @swng/contracts exec vitest run src/golfers.test.ts`
- [ ] **Step 3: Edit `GetMyRecordResponse.metrics`** (interface + `getMyRecordResponseSchema`). Remove `distribution` and `trend`. Add (both required):

```ts
// interface:
  readonly typicalEighteen: { readonly eagles: number; readonly birdies: number; readonly pars: number; readonly bogeys: number; readonly doublePlus: number };
  readonly indexHistory: readonly { readonly roundId: RoundId; readonly swngIndex?: number; readonly whsIndex?: number }[];

// schema (inside metrics: z.object({ … })):
  typicalEighteen: z.object({ eagles: z.number().int(), birdies: z.number().int(), pars: z.number().int(), bogeys: z.number().int(), doublePlus: z.number().int() }),
  indexHistory: z.array(z.object({ roundId: roundIdSchema, swngIndex: z.number().optional(), whsIndex: z.number().optional() })).readonly(),
```
  Use the existing `roundIdSchema` (already imported in this file; if not, import it from `./round.js` or wherever `RoundId` ids are schema'd — match the file's other id schemas). Update the doc comment above the interface to describe `indexHistory`/`typicalEighteen`.
- [ ] **Step 4: Run — PASS.** Step 2 command, then `NODE_OPTIONS= pnpm -F @swng/contracts exec vitest run`.
- [ ] **Step 5: Commit** `feat(contracts): /me/record serves indexHistory + typicalEighteen; drops trend + distribution`.

---

### Task 3: Application — serve the new metrics; round the wire differential to 0.1

**Files:**
- Modify: `packages/application/src/golfers/getMyRecord.ts`
- Test: `packages/application/src/golfers/golferSlice.test.ts`
- Fixture sweep: any `GetMyRecordResponse`/`metrics` fixture in `packages`/`apps`.

**Interfaces (Consumes):** Task 1 `golferMetrics`/`postedDifferential`, Task 2 wire shape.

- [ ] **Step 1: Failing tests.** In `golferSlice.test.ts`: (a) the no-golfer early return equals `{ metrics: { typicalEighteen: {all zeros}, indexHistory: [] }, history: [] }`; (b) for a mixed rated/unrated fixture, `response.metrics.typicalEighteen`/`.indexHistory` equal `golferMetrics(sorted)`'s, and `response.history[i].differential` equals `postedDifferential(rawDifferential)` (a 0.1 value, not the raw float) while the golfer's `swngIndex`/`whsIndex` headline still match `golferMetrics(sorted)` (proving the index is computed from the RAW lines, not the rounded wire value).
- [ ] **Step 2: Run — FAIL.** `NODE_OPTIONS= pnpm -F @swng/domain build && NODE_OPTIONS= pnpm -F @swng/contracts build && NODE_OPTIONS= pnpm -F @swng/application exec vitest run src/golfers/golferSlice.test.ts`
- [ ] **Step 3: Edit `getMyRecord.ts`.** Import `postedDifferential`. In `toWireLine`, round the differential:

```ts
    ...(line.differential !== undefined ? { differential: postedDifferential(line.differential) } : {}),
```
  In the response `metrics`, replace the removed `distribution` spread and drop `trend`; add `typicalEighteen` + `indexHistory` (plain, always present):

```ts
      metrics: {
        ...(metrics.whsIndex !== undefined
          ? { whsIndex: { value: metrics.whsIndex.value, computedAtMs: deps.clock.now(), differentialsUsed: metrics.whsIndex.differentialsUsed } }
          : {}),
        ...(metrics.swngIndex !== undefined ? { swngIndex: metrics.swngIndex } : {}),
        typicalEighteen: metrics.typicalEighteen,
        indexHistory: metrics.indexHistory,
      },
```
  Change the no-golfer early return to `{ metrics: { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, indexHistory: [] }, history: [] }`. `golferMetrics(sorted)` still receives the raw `sorted` lines (unchanged) — only `toWireLine`'s output differential is rounded.
- [ ] **Step 4: Fixture sweep.** `grep -rn "metrics:" packages apps --include=*.ts --include=*.tsx | grep -viE "\.metrics\.|dist/"` plus the web mocks; every `GetMyRecordResponse` fixture drops `distribution`/`trend` and gains `typicalEighteen` (zeros or asserted) + `indexHistory` (`[]` or asserted).
- [ ] **Step 5: Run — PASS.** Step 2 command, then `NODE_OPTIONS= pnpm validate` + `NODE_OPTIONS= pnpm test:contract` — GREEN.
- [ ] **Step 6: Commit** `feat(application): serve indexHistory + typicalEighteen; the posted differential on the wire is 0.1`.

---

### Task 4: Web — the two-line index chart + gate, typical-18, score-first history

**Files:**
- Modify: `apps/web/src/routes/ProfilePage.tsx`
- Test: `apps/web/src/routes/ProfilePage.test.tsx`

**Interfaces (Consumes):** the Task 2 `metrics` shape.

- [ ] **Step 1: Read the current `ProfilePage.tsx`** and report the exact `IndexTrend` + `DistributionBars` components and the render sites of `record?.metrics.trend` / `.distribution` and the History list, so the edit is surgical. (`formatHandicapIndex`/`resolveIndex` imports stay — allowed formatters.)
- [ ] **Step 2: Failing tests** in `ProfilePage.test.tsx`:
  - **Gate:** a record with `history.length < 8` renders the copy `Your index history shows up at 8 rounds` and NO chart `<svg>`/`<polyline>`; with `history.length >= 8` and a populated `indexHistory` renders a chart with a swng polyline and a WHS polyline.
  - **Typical 18:** given `typicalEighteen: { eagles:0, birdies:2, pars:8, bogeys:5, doublePlus:3 }`, the "typical 18" line renders those numbers (e.g. `8 pars`, `2 birdies`).
  - **Score-first history:** a history line `{ ags: 81, par: 72, … }` renders `81 (+9)`; a 9-hole `{ ags: 47, par: 36, holes: 9 }` renders `47 (+11)` and a `9 holes` marker; a rated line's differential renders as its 0.1 value (from the wire) or is absent, but never a long float.
  - Remove the old trend/distribution assertions.
- [ ] **Step 3: Run — FAIL.** `NODE_OPTIONS= pnpm -F @swng/domain build && NODE_OPTIONS= pnpm -F @swng/web exec vitest run src/routes/ProfilePage.test.tsx`
- [ ] **Step 4: Implement.** Delete `IndexTrend` (differential polyline) and `DistributionBars`. Add:
  - **`IndexOverTime`** — props `{ points: GetMyRecordResponse["metrics"]["indexHistory"]; roundsPlayed: number }`. If `roundsPlayed < INDEX_HISTORY_MIN_ROUNDS` (a module const `= 8`), render the gate copy: `Your index history shows up at ${INDEX_HISTORY_MIN_ROUNDS} rounds — you've played ${roundsPlayed}. Keep going.` Otherwise render an `<svg>` with two `<polyline>`s: one from the points that have `swngIndex` (label "swng"), one from those with `whsIndex` (label "WHS"). Map a point at index `i` with value `v` to `x = (i/(n-1))*W`, `y = H - ((v - min)/(max - min))*H` over the combined value range (SVG coordinate math — view). A one-point/degenerate range renders dots, not a line. Include a small legend (`● swng`, `○ WHS`) and the latest values via `formatHandicapIndex`.
  - **Typical-18 line** — `In a typical 18: {birdies} birdies · {pars} pars · {bogeys} bogeys · {doublePlus} double+` (prepend `{eagles} eagle+ · ` only when `eagles > 0`), reading `record?.metrics.typicalEighteen ?? {…zeros}`.
  - **History rows** lead with the score: `{courseName} · {tee} · {ags} ({vsPar})` where `vsPar` is a local presentation helper `(ags, par) => { const d = ags - par; return d === 0 ? "E" : d > 0 ? \`+${d}\` : \`${d}\`; }`; append `· 9 holes` when `holes === 9`; render the differential (already 0.1 from the wire) as a quiet secondary detail or omit — no golf math (no domain compute import).
  - Render sites: `<IndexOverTime points={record?.metrics.indexHistory ?? []} roundsPlayed={record?.history.length ?? 0} />`. Remove every `record?.metrics.trend` / `.distribution` reference.
- [ ] **Step 5: Run — PASS.** Step 3 command, then `NODE_OPTIONS= pnpm -F @swng/web exec vitest run` (whole package) — GREEN. Confirm the ESLint compute fence still passes (`NODE_OPTIONS= pnpm lint`) — the new code imports no `@swng/domain` compute.
- [ ] **Step 6: Commit** `feat(web): the record shows your index over time (swng+WHS, gated), a typical 18, and score-first history`.

---

### Task 5: Full gate + e2e reconciliation

**Files:** `apps/web/e2e/*`, `e2e/*` as needed.

- [ ] **Step 1: Reconcile e2e.** `grep -rniE "metrics.(distribution|trend)|distribution:|Scoring distribution|Index trend" apps/web/e2e e2e` and update any assertion/fixture that referenced the removed fields to the new shape (or delete if it asserted the old distribution). Most e2e read `metrics.whsIndex`/`.swngIndex` only (unchanged) — likely near-zero-diff; record it if so.
- [ ] **Step 2: Run** `NODE_OPTIONS= pnpm validate` + `NODE_OPTIONS= pnpm test:contract` — GREEN. Commit only if a spec/fixture changed: `test(e2e): profile metrics assert indexHistory/typicalEighteen`.

---

## Close-out (controller-run gate)
`deploy:beta` then `publish:web:beta` + CloudFront invalidate **immediately** (the wire both adds and removes required fields — no clean single order; the exposed window is a stale cached bundle throwing on `GET /me/record`, self-healing on invalidation). **No data wipe** (compute-on-read). → `e2e:beta` ×2 → `e2e:field` → a browser walk on a golfer WITH ≥8 finalized rounds (the two-line chart draws; a <8 golfer shows the gate) AND a look at the typical-18 line + score-first history + a 0.1 differential → docs sweep (CLAUDE.md).

## Self-Review (performed while writing)
- **Spec coverage:** §2a rolling dual-index + gate → T1 (`indexHistory`) + T4 (chart/gate); §2b headline/source untouched → not modified (confirmed: `resolveIndex` and the picker are out of scope, T4 leaves them); §2c typical-18 → T1 (`typicalEighteen`) + T4; §2d score-first history + 0.1 differential → T3 (`postedDifferential` on the wire) + T4 (rows); §3 boundary → Global Constraints + T4 Step 5 fence check; §4 deploy → close-out; §5 testing → each task's domain-first tests.
- **Deviation from the spec, noted:** the spec's `indexHistory` point listed `finalizedAtMs`; the plan drops it — `golferMetrics` works over `GolferRoundLine` (which has `roundId`, not `finalizedAtMs`), the chart x-axis is round sequence, and no calendar date is in scope. `roundId` + oldest→newest order is sufficient.
- **Type consistency:** `ScoringShape`/`IndexPoint`/`typicalEighteen`/`indexHistory` names match across T1→T2→T3→T4; `postedDifferential` defined in T1, used in T3.
- **Numbers don't silently move:** the index headline is still computed from raw lines (T3 Step 1 pins it); only the *displayed* differential rounds. `typicalEighteen`/`indexHistory` are new, tested against `golferMetrics` directly.
