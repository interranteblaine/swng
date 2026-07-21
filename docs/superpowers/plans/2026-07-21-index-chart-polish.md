# Index Chart Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the "index over time" chart — 20-round window, honest y-scale with mono
ticks, fluid width, date anchors, merged caption — per the owner-approved mockup.

**Architecture:** Spec `docs/superpowers/specs/2026-07-21-index-chart-polish-design.md`
(binding). One additive optional wire change (`finalizedAt`/`createdAt` on record history
rows); everything else is presentation inside `IndexOverTime` plus one new web hook.

**Tech Stack:** Existing monorepo layers (contracts/application/web). No new dependencies.

## Global Constraints

- `pnpm validate` green at EVERY commit. Single-file runs: `pnpm --filter <pkg> exec vitest run <file>`.
- The chart windows to the LAST 20 rounds (`INDEX_CHART_WINDOW = 20`), a web-side slice; the wire keeps serving full `indexHistory`; header meta = "your/their last {drawn} round(s)".
- Y-bounds exactly: `lo=min, hi=max` over DRAWN values; if `hi−lo < 4` expand symmetrically about the midpoint to span 4; then `lo=floor(lo), hi=ceil(hi)`. Tick step: 1 if span ≤ 4, 2 if span ≤ 8, else 5; ticks from `ceil(lo/step)*step` to `hi`.
- Tick labels render through `formatCourseHandicap` (the domain's ONE integer plus-convention formatter) — a tick below scratch reads `+2`, NEVER a bare `-2`. The whole-tree signed-render grep gate applies to the axis with no carve-out.
- No frame: the `cardBox` class comes OFF the svg; gridlines are `--color-hairline`; hollow WHS markers fill with the page cream; each series' latest point draws r=4 (others r=2.5).
- Fluid width via `useContainerWidth` (ResizeObserver; fallback 320 when unavailable; clamp min 260), height fixed 150, container capped `max-w-xl`; coordinates at CSS-pixel scale.
- Caption line replaces the legend row: `● swng {v} · ○ WHS {v}` via `formatHandicapIndex`, `—` when absent.
- Date anchors: `createdAt ?? finalizedAt` joined from `history` by `roundId`; local `MMM d`, both gain `, yyyy` when the two anchors fall in different years; omitted when either date is unavailable.
- Wire fields are OPTIONAL on the schemas (new bundle tolerates an old lambda); deploy is lambda-first at close-out regardless.
- Existing testids (`index-chart`, `index-line-*`, `index-dot-*`) keep their meaning; the 8-round gate and its copy are untouched.
- Work on local `main`; never push.

---

### Task 1: The wire — record history rows carry their dates

**Files:**
- Modify: `packages/application/src/golfers/recordOf.ts` (toWireLine passes the two fields through)
- Modify: `packages/contracts/src/golfers.ts` (GetMyRecordResponse + GetGolferResponse history rows, types + schemas)
- Test: `packages/application/src/golfers/golferSlice.test.ts` (extend an existing getMyRecord/getGolfer assertion)

**Interfaces:**
- Consumes: the projection store line shape `GolferRoundLine & { finalizedAtMs: number; createdAtMs?: number }` (already recordOf's input type).
- Produces (Task 2 renders these): `history` rows typed `GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number }` on BOTH responses, with `finalizedAt` always present in practice.

- [ ] **Step 1: Failing test** — in `golferSlice.test.ts`, extend an existing getMyRecord (and one getGolfer) history assertion: each returned history row's `finalizedAt` equals the line's stored `finalizedAtMs`, and `createdAt` equals `createdAtMs` when the fixture has one / is absent when it doesn't. Run: `pnpm --filter @swng/application exec vitest run src/golfers/golferSlice.test.ts` — expect FAIL (fields stripped today).
- [ ] **Step 2: Implement** — in `recordOf.ts`, the wire row becomes an extension (mirroring GetMyRounds' rename discipline), and the strip-comment updates to say what is now deliberately passed through:

```ts
// The store's finalizedAtMs/createdAtMs cross the wire under GetMyRounds' own names
// (finalizedAt/createdAt) — the index chart's date anchors need them (index-chart-polish
// spec §1.6). Optional on the wire; always present in practice for finalizedAt.
const toWireLine = (
  line: GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number },
): GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number } => ({
  roundId: line.roundId,
  courseName: line.courseName,
  ...(line.courseId !== undefined ? { courseId: line.courseId } : {}),
  tee: line.tee,
  holes: line.holes,
  par: line.par,
  courseHandicap: line.courseHandicap,
  ...(line.ags !== undefined ? { ags: line.ags } : {}),
  ...(line.differential !== undefined ? { differential: postedDifferential(line.differential) } : {}),
  distribution: line.distribution,
  finalizedAt: line.finalizedAtMs,
  ...(line.createdAtMs !== undefined ? { createdAt: line.createdAtMs } : {}),
});
```

(Keep the existing courseId/differential comments in place — the block above shows the
whole object so nothing is guessed; `recordOf`'s signature and both use cases are
unchanged.)

- [ ] **Step 3: Contracts** — in `golfers.ts`, both history types become
`readonly (GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number })[]`
(lines 162 and 220 today), and both schemas (lines 174 and 227) become:

```ts
history: z.array(z.object({ ...golferRoundLineFields, finalizedAt: z.number().int().optional(), createdAt: z.number().int().optional() })).readonly(),
```

Add one contracts test (or extend an existing parse test) proving a history row
WITHOUT the new fields still parses — the old-lambda tolerance pin.

- [ ] **Step 4: Run + validate** — the Step 1 file PASSES; then `pnpm validate`.
- [ ] **Step 5: Commit** — `feat(contracts,application): record history rows carry finalizedAt/createdAt — the chart's date anchors`

---

### Task 2: The chart — window, scale, fluid width, anchors, caption

**Files:**
- Create: `apps/web/src/ui/useContainerWidth.ts`
- Modify: `apps/web/src/golfers/RecordSections.tsx` (the `IndexOverTime` component only)
- Test: `apps/web/src/golfers/RecordSections.test.tsx` (extend); `apps/web/src/routes/ProfilePage.test.tsx` + `apps/web/src/golfers/GolferPage.test.tsx` only if their existing chart assertions need reconciling (testids survive; check the legend-row assertions)

**Interfaces:**
- Consumes: Task 1's `history` rows (`finalizedAt?`/`createdAt?`), `metrics.indexHistory` (unchanged), `formatHandicapIndex` + `formatCourseHandicap` from `@swng/domain`.
- Produces: `useContainerWidth(): { ref: RefObject<HTMLDivElement | null>; width: number }` — measured width, fallback 320, min clamp 260.

- [ ] **Step 1: The hook** — `apps/web/src/ui/useContainerWidth.ts`:

```ts
import { useEffect, useRef, useState } from "react";

// Measured container width for fluid SVG charts (index-chart-polish spec §1.4): the svg
// renders at the column's real CSS-pixel width so type/dots/strokes never scale with it.
// happy-dom has no ResizeObserver — the fallback keeps test renders deterministic.
const FALLBACK_WIDTH = 320;
const MIN_WIDTH = 260;

export function useContainerWidth(): { ref: React.RefObject<HTMLDivElement | null>; width: number } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(MIN_WIDTH, Math.round(w)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
```

- [ ] **Step 2: Failing tests first** — extend `RecordSections.test.tsx` (fixtures: build
points as `{ roundId, swngIndex }` arrays; history rows matching by roundId with
`finalizedAt`/`createdAt` as each case needs). New assertions:
  - **Window:** 25 points → `index-dot-swng` count is 20 and the meta text reads `last 20 rounds`; 9 points → 9 dots, `last 9 rounds` (existing behavior preserved).
  - **Min-span:** all 9 swng values inside `[9.0, 9.6]` → assert tick labels exactly `["8", "10", "12"]`, with the hand-derivation written into the test comment (spec §1.2 run by hand: span 0.6 < 4 → expand about midpoint 9.3 → 7.3..11.3; floor/ceil → 7..12; span 5 → step 2; ticks `ceil(7/2)*2 = 8`, `10`, `12`).
  - **Plus convention:** values spanning `−2.4..1.8` → bounds `−3..2` (span 4 already ≥... midpoint −0.3, span 4.2 → no expand; floor(−2.4)=−3, ceil(1.8)=2, span 5 → step 2) → ticks `−2, 0, 2` render as `+2`, `0`, `2` — assert the label `+2` exists and NO text node matches `/^-\d/`.
  - **Gridlines:** number of `line` elements with the gridline testid equals the tick-label count.
  - **No frame:** the svg's `class` contains neither `border` nor `bg-card`.
  - **Endpoint emphasis:** the LAST `index-dot-swng` has `r="4"`, every other `r="2.5"`; same for WHS.
  - **Caption:** a single line matching `● swng 1.2 · ○ WHS 0.2` for the fixture's latest values; the old standalone legend row (`● swng` beside `○ WHS` with no numbers) is GONE.
  - **Anchors:** with dated history, two mono texts render the first/last drawn rounds' dates (`createdAt` preferred over `finalizedAt` — one fixture proves preference); with any anchor date missing, no date text renders; two anchors in different years both include the year.
  Run: `pnpm --filter @swng/web exec vitest run src/golfers/RecordSections.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement `IndexOverTime`** — rewrite the render path (gate branch, heading row, testids, person copy all unchanged):

```tsx
const INDEX_CHART_WINDOW = 20; // the WHS window (Rule 5.2a) — spec §1.1; slicing is honest: every point folds the whole career before it

// Chart geometry (spec §1.2–§1.4) — presentation math, not golf compute: nice bounds with
// the min-span honesty rule, whole-index ticks, CSS-pixel coordinates.
const yBounds = (values: readonly number[]): { lo: number; hi: number; step: number } => {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2;
    lo = mid - 2;
    hi = mid + 2;
  }
  lo = Math.floor(lo);
  hi = Math.ceil(hi);
  const span = hi - lo;
  return { lo, hi, step: span <= 4 ? 1 : span <= 8 ? 2 : 5 };
};
const ticksFor = ({ lo, hi, step }: { lo: number; hi: number; step: number }): readonly number[] => {
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
};
```

Inside the component (after the gate): `const drawn = points.slice(-INDEX_CHART_WINDOW);`
— every existing derivation (`values`, `pointsFor`, latest values, the meta count `n`)
moves onto `drawn`. Layout constants: `ML = 30, MR = 12, MT = 10, MB = 24`, `height = 150`,
`const { ref, width } = useContainerWidth();` with the svg inside `<div ref={ref} className="max-w-xl">`;
plot width `width − ML − MR`, plot height `height − MT − MB`;
`x(i) = ML + (i / (drawnN − 1)) * plotW` (guard `drawnN ≤ 1` → `ML`),
`y(v) = MT + plotH − ((v − lo) / (hi − lo)) * plotH`.
Render order: gridlines+tick labels (labels `text-anchor="end"` at `x = ML − 7`,
`formatCourseHandicap(t)` — reused as the model's one integer plus-convention formatter,
comment it), then WHS polyline, then swng polyline (swng on top), then WHS dots
(`fill: var(--color-cream)` equivalent via the cream class token, `r={2.5}`, last `r={4}`),
then swng dots (`r={2.5}`, last `r={4}`), then anchor texts at `y = height − 6`
(`x = ML` start-anchored; `x = width − MR` end-anchored, mono 11px fairway). Date logic:

```tsx
const anchorDate = (roundId: RoundId): number | undefined => {
  const row = history.find((line) => line.roundId === roundId);
  return row?.createdAt ?? row?.finalizedAt;
};
const firstMs = drawn.length > 0 ? anchorDate(drawn[0].roundId) : undefined;
const lastMs = drawn.length > 0 ? anchorDate(drawn[drawn.length - 1].roundId) : undefined;
const crossYear = firstMs !== undefined && lastMs !== undefined && new Date(firstMs).getFullYear() !== new Date(lastMs).getFullYear();
const anchorLabel = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(crossYear ? { year: "numeric" } : {}) }).format(new Date(ms));
```

Anchors render only when BOTH `firstMs` and `lastMs` are defined. `IndexOverTime` gains a
`history` prop (the same already-fetched response array RecordSections holds — a render
join, the bests/milestones precedent). The caption replaces both the legend row and the
old summary: `● swng {fmt} · ○ WHS {fmt}` (one `<p>`; values via `formatHandicapIndex`,
`—` when undefined). Gridlines get `data-testid="index-gridline"`.

- [ ] **Step 4: Run the failing file — PASS.** Then run the page suites and reconcile
ONLY assertions the new DOM invalidates (the legend-row texts; vertex pins on ≤10-round
fixtures stay valid): `pnpm --filter @swng/web exec vitest run src/routes/ProfilePage.test.tsx src/golfers/GolferPage.test.tsx src/golfers/RecordSections.test.tsx`
- [ ] **Step 5: `pnpm validate`.** **Step 6: Commit** — `feat(web): the index chart, finished — 20-round window, honest scale, fluid width, date anchors`

---

### Task 3: E2E reconciliation — verify, don't assume

**Files:**
- Verify (modify only if a sweep hit demands it): `apps/web/e2e/*.spec.ts`, `e2e/src/**`

- [ ] **Step 1: Sweep** — grep both e2e trees for chart couplings: `index-chart`,
`index-line`, `index-dot`, `index-gridline`, `● swng`, `○ WHS`, `last \d+ rounds?`,
`swng \d` / `WHS \d` adjacent to chart context, and any locator anchored on the OLD
two-row legend/summary. As of spec-writing the expectation is ZERO hits that lock chart
DOM (identityRecord's index assertions target the "Your index" section, not the chart) —
verify each hit against the new JSX rather than trusting that expectation.
- [ ] **Step 2: Reconcile** any real coupling locator-by-locator against the new DOM
(the games-legibility idiom: accessible-name/testid-driven, verified against JSX).
If the sweep is clean, record that in the task report — an empty diff is a valid
deliverable here.
- [ ] **Step 3: `pnpm validate`** (typecheck gate; Playwright runs at controller close-out).
- [ ] **Step 4: Commit** (only if files changed) — `test(e2e): reconcile chart locators with the finished index chart`

---

## Close-out (controller-run, NOT a task)

`pnpm validate` at HEAD → `deploy:beta` LAMBDA-FIRST (wire fields optional, but the
standing order discipline holds) → `publish:web:beta` → `e2e:beta` ×2 → `e2e:field` →
browser walk on deployed beta.swng.golf (an ≥8-round golfer's profile: ticks, gridlines,
date anchors, endpoint emphasis, caption, no clipped markers, at phone width) → docs
sweep (CLAUDE.md arc paragraph; spec/plan corrections if reality diverged). NO wipe.

## Self-review notes

- Spec coverage: §1.1→T2 (window), §1.2→T2 (bounds/ticks/plus-gate), §1.3→T2 (geometry),
  §1.4→T2 (hook), §1.5→T2 (caption), §1.6→T1 (wire) + T2 (anchors), §3 e2e→T3,
  close-out→controller.
- The T2 Step 2 min-span fixture's hand-derivation is written INTO the test comment by
  instruction — the reviewer re-derives it (the oracle discipline).
- Type consistency: T1's `finalizedAt?`/`createdAt?` optional wire rows are exactly what
  T2's `anchorDate` consumes; `useContainerWidth`'s return shape is used verbatim in T2.
- One deliberate dedup: `IndexOverTime` takes `history` as a prop rather than re-fetching —
  same response object RecordSections already renders.
