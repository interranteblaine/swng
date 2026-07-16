# Handicap-model legibility — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the shipped handicap model legible on the screen and in the API, exactly as the
model doc describes — one owned index, strokes derived per round with the derivation shown, no
hidden precedence — and fix the swng-index computation.

**Authority:** `docs/superpowers/specs/2026-07-16-handicap-index-strokes-model-design.md` is
the source of truth for every behavior below. Read it first. This plan implements its §9
change list; it does NOT touch the "stays" list (unrated entry/play, AGS-not-differential,
`par`/`courseHandicap` on the line, the sealed round).

**Architecture:** The corrections are a rename (`suggested` → `swngIndex`), a one-line domain
computation change (swng index = WHS fold extended to unrated), a change of *which* computed
number the active index defaults to (`whsIndex` → `swngIndex`), and two web surfaces
(profile, create/join) reworked so the through-line is visible. No snapshot/round changes.

**Tech Stack:** TypeScript ESM monorepo (pnpm), Zod wire schemas, React 19, Vitest, Playwright.

## Global Constraints

- `pnpm validate` GREEN at every commit.
- **Naming:** `suggested`/`suggestedIndex` becomes **`swngIndex`** everywhere (domain, contracts,
  web, e2e). No occurrence of "suggested" for this concept survives.
- **swng index computation (model §2):** over the golfer's round lines, each line contributes
  `line.differential` when it has one (rated), else `line.ags − line.par` (unrated); a line
  with no `ags` is skipped. Then the existing `combineNineHoleDifferentials` +
  `computeIndexDetail`. Result: a rated-only golfer's swng index **equals** their WHS index.
- **Active index (model §3):** "Your index" = the golfer's override (`declared`) if set, else
  the **swng index** (was: WHS index). It is always shown with its source; never a value the
  UI resolves off-screen.
- **Strokes (model §4/§7):** at create/join, the strokes field has a plain label ("Strokes you
  get here"), shows its derivation ("N — from your index (X) on this course"), is editable, and
  for an unrated tee uses `round(index / 2)` on a 9-hole course / `round(index)` on 18 (fixing
  the shipped `round(index)`), labeled as an estimate. It is never silently pre-filled without
  its derivation, and never framed as a separate declaration.
- Handicap math stays in the domain — the web calls `courseHandicapFor` /
  `courseHandicapFromRatingSlopePar` / `effectiveIndex` / `swngIndex`, never re-inlines a formula.
- Conditional-spread optional keys — never an explicit `undefined`.
- If a node/pnpm command dies with `MODULE_NOT_FOUND` about a cmux/NODE_OPTIONS preload file,
  re-run prefixed with `NODE_OPTIONS=` (env flake).
- Commit per task; `feat`/`refactor(scope): …` + the Claude Code co-author trailer. Do NOT push.
- Controller-only (not a task): reseed beta, deploy, `publishWeb`, live gates, CLAUDE.md.

---

### Task 1: Domain + contracts + web reads — rename to `swngIndex` and fix its computation

**Files:** `packages/domain/src/handicap/whs.ts` (+test), `packages/domain/src/golfer/metrics.ts`
(+test), `packages/domain/src/index.ts`, `packages/contracts/src/golfers.ts` (+test),
`packages/application/src/golfers/getMyRecord.ts` (+test), every web/e2e reader of
`metrics.suggestedIndex` (`apps/web/src/routes/ProfilePage.tsx` + its test; audit
`apps/web/e2e/*.spec.ts`).

**Interfaces (Produces):** `swngIndex(lines): IndexComputation | undefined` (whs.ts);
`GolferMetrics = { whsIndex?, swngIndex? }`; `GetMyRecordResponse.metrics.swngIndex`.

- [ ] **Step 1:** Rename `suggestedIndex` → `swngIndex` in `whs.ts`, and change the per-line
  map so a rated line uses its `differential` and an unrated line uses `ags − par`:

```ts
export const swngIndex = (
  lines: readonly { readonly ags?: number; readonly differential?: number; readonly par: number; readonly holes: 9 | 18 }[],
): IndexComputation | undefined => {
  const entries = lines
    .filter((line): line is typeof line & { ags: number } => line.ags !== undefined)
    .map((line) => ({ differential: line.differential ?? line.ags - line.par, holes: line.holes }));
  return computeIndexDetail(combineNineHoleDifferentials(entries));
};
```

- [ ] **Step 2:** `metrics.ts`: rename `GolferMetrics.suggestedIndex` → `swngIndex`; `golferMetrics`
  calls `swngIndex(lines)`. Update `packages/domain/src/index.ts` export. The `whsIndex` member is
  unchanged (rated differentials only).
- [ ] **Step 3:** `contracts/golfers.ts`: rename `GetMyRecordResponse.metrics.suggestedIndex` →
  `swngIndex` (interface + schema).
- [ ] **Step 4:** `getMyRecord.ts`: rename the `suggestedIndex` spread key → `swngIndex`.
- [ ] **Step 5:** Web/e2e reads: `ProfilePage.tsx` `DECLARATION_AIDS` `suggestedIndex` →
  `swngIndex` and copy "Suggested" → "swng index"; grep `apps/web` + `e2e` for
  `suggestedIndex`/"suggested" and rename each (the `unratedCourse.spec.ts` pin reads
  `metrics.suggestedIndex` — rename to `swngIndex`; its VALUE is unchanged, all its rounds are
  unrated so `differential` is absent and `ags − par` still applies).
- [ ] **Step 6:** Tests. `whs.test.ts`: `swngIndex` over a rated-only set equals
  `computeIndexDetail(combineNineHoleDifferentials(theDifferentials))` (i.e. equals the WHS
  computation); a mixed set uses `differential` for the rated lines and `ags − par` for the
  unrated; an all-unrated set is unchanged from the old behavior. `metrics.test.ts`/`getMyRecord`:
  the member is named `swngIndex`. `pnpm validate` + `pnpm test:contract` green.
- [ ] **Step 7:** Commit: `refactor(domain,contracts,web): the swng index — WHS fold extended to unrated, renamed from "suggested"`.

---

### Task 2: Web profile — one visible "Your index", defaulting to the swng index

**Files:** `apps/web/src/routes/ProfilePage.tsx` (+ its test).

Model §3/§7. The profile must show ONE active "Your index" with its source, the swng index as
the default, WHS as an adoptable reference, and the override.

- [ ] **Step 1:** Source the composed index from the swng index, not WHS:
  `effectiveIndex({ declared: auth.golfer?.declared, computed: record?.metrics?.swngIndex?.value })`.
  So the active "Your index" is `declared ?? swngIndex` (was `declared ?? whsIndex`).
- [ ] **Step 2:** Rework the index block into one labeled **"Your index"** showing the active
  value and its source (your override, or "computed from your rounds"), with two adoptable data
  points beneath: **swng index** ("from all your rounds") and **WHS index** ("rated rounds,
  official rules"), each with "Use this" (sets the override to that value); and the override
  input. No blank "Declared index" box standing alone, and no number used that isn't shown. A
  metric with no data renders `—`.
- [ ] **Step 3:** Tests. The active value shown is the swng index when nothing is declared (and
  equals WHS for a rated-only fixture); "Use this" on WHS sets the declared value; a metric with
  no data renders `—`; still no divergence-nudge/threshold copy.
- [ ] **Step 4:** `pnpm validate` green. Commit: `feat(web): profile shows one "Your index" (defaults to the swng index, WHS adoptable, override) — no hidden precedence`.

---

### Task 3: Web create/join — strokes shown with their derivation, editable, hole-count-correct

**Files:** `apps/web/src/routes/CreateRoundPage.tsx` (+test), `apps/web/src/routes/JoinRoundPage.tsx` (+test).

Model §4/§7. The strokes field is your index turned into today's strokes, shown with its
derivation, editable, plain-labeled.

- [ ] **Step 1:** Both pages compose the active index from the swng index:
  `effectiveIndex({ declared: auth.golfer?.declared, computed: record?.metrics?.swngIndex?.value })`.
- [ ] **Step 2:** The strokes field: plain label **"Strokes you get here"** (drop "Course
  handicap" jargon); the value is the derived course handicap shown WITH its derivation —
  "N — from your index (X) on this course" — and remains editable (a group can change it). It
  must never read as a separate declaration nor appear without its derivation.
- [ ] **Step 3:** Fix the unrated estimate for hole count: rated tee → `courseHandicapFor` /
  `courseHandicapFromRatingSlopePar` (unchanged); unrated tee → `round(index)` on an 18-hole
  card but **`round(index / 2)` on a 9-hole card**, labeled "estimate — unrated course". Derive
  the hole count from the selected tee (Create: `selectedTeeSet.holes.length`; Join: the peek
  tee — it carries `par` but not `holes`, so thread the hole count through the peek OR infer 9
  vs 18 from the tee data the peek already provides; if the peek lacks hole count, add it to the
  peek response, mirroring how `par` was added).
- [ ] **Step 4:** Keep seed-once/typed-wins (a typed value is never overwritten). No effective
  index → the field is empty with no derivation line (you just type your strokes).
- [ ] **Step 5:** Tests. Rated → the derived value + its derivation text render and the field is
  editable; unrated 9-hole → `round(index/2)`; unrated 18-hole → `round(index)`; a typed value
  survives; no "Course handicap" label remains.
- [ ] **Step 6:** `pnpm validate` green. Commit: `feat(web): create/join show "Strokes you get here" with their derivation; unrated estimate is hole-count-correct`.

---

### Task 4: E2E + close-out audit

**Files:** `apps/web/e2e/unratedCourse.spec.ts` and any spec touching the renamed field / new copy.

- [ ] **Step 1:** Rename `metrics.suggestedIndex` → `swngIndex` in the e2e pins (value unchanged
  for all-unrated/all-rated oracles — the computation change only moves a *mixed* golfer's swng
  index). Update any create/join selector that matched "Course handicap" to the new "Strokes you
  get here" label, and any profile selector to the new "Your index" surface.
- [ ] **Step 2:** `pnpm validate` (typecheck/lint the specs — live runs are the controller's
  gate). Commit: `test(e2e): swngIndex rename + the new strokes/index copy`.

## Self-Review (performed while writing)
- **Spec coverage:** §2 computation + rename → T1; §3 one visible index default-swng → T2; §4/§7
  strokes derivation + hole-count → T3; §8 API rename → T1; e2e → T4.
- **Green-per-commit:** T1's rename is atomic across contracts + all readers (incl. web/e2e) —
  the typecheck names every site; T2/T3 are web-only; T4 is test-only.
- **Type consistency:** `swngIndex` member (T1) read by ProfilePage/create/join as
  `record.metrics.swngIndex` (T2/T3); `effectiveIndex({declared, computed})` composed from
  `swngIndex.value` at all three sites.
- **Stays untouched:** unrated entry/play, AGS-not-differential, `par`/`courseHandicap`, the
  sealed round, `whsIndex` (rated-only).
