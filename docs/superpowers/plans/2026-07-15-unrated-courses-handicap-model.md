# Unrated Courses & the Three-Number Handicap Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let golfers enter and play **unrated** courses (no course rating/slope) without inventing numbers; play rated and unrated golfers on one card; and give the golfer a **suggested index** and **suggested course handicap** to declare from, while the golfer's declaration always wins and the WHS-standard computations stay honest.

**Architecture:** Rating/slope become optional-as-a-pair on `TeeSet`. An unrated round produces an adjusted gross score but no differential (a new `handicappingFor` arm), so it scores and plays games normally yet structurally cannot touch the WHS index. The golfer record carries `par` and `courseHandicap` per round so derived numbers work across rated and unrated rounds. Those derived numbers are consolidated into one **read projection** — `golferMetrics(lines): GolferMetrics`, housing `whsIndex` (the read-time WHS index, moved out of `getMyRecord`) and the **suggested index** (the pinned WHS engine on neutral `ags − par` pseudo-differentials) — that `getMyRecord` folds at read time and stores nowhere. `declared` overrides `computed`; `official` collapses into `declared`.

**Tech Stack:** TypeScript ESM monorepo (pnpm), Zod wire schemas, DynamoDB (lib-dynamodb), Vitest, React 19 + react-router, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-15-unrated-courses-handicap-model-design.md` — the authority for every behavior below.

## Global Constraints

- `pnpm validate` (lint + typecheck + build + test, hermetic) GREEN at every commit. Task order enforces this: unrated tees additive first (T1); the round/record change moves domain+contracts together (T2, because `GolferRoundLine`'s new required fields must land in both the type and its Zod mirror at once); the web sheds `official` **before** the contract drops it (T3 before T4 — the recorded consumer-first-deletion lesson).
- **Rating and slope are optional together, never one alone.** A tee is *rated* iff both are set (`isRated`). Exactly one set is a domain rejection (`rating-slope-paired`, 400). Bounds (rating 30–90, slope integer 55–155) are enforced **iff present** — copied verbatim from the existing `validateTeeSet`.
- **An unrated round is `complete` for scoring/games and `unrated` for posting** — it carries an AGS, no differential, and can never reach the WHS `computed` index (the existing `differential !== undefined` filter is what excludes it — do not add a second guard).
- **The suggested index reuses the pinned WHS engine unchanged** — `combineNineHoleDifferentials` + `computeIndexDetail` applied to pseudo-differentials `ags − par`; the small-sample table is never re-derived. Read-time only, never stored.
- **`effectiveIndex = declared ?? computed`.** `HandicapProfile` becomes `{ declared? }`. A legacy stored `official` folds to `declared` on read (when no declared is set); a stored `computed` is dropped. No migration script. At every call site `computed` is sourced from `metrics.whsIndex.value`.
- **Derived indexes live in ONE read projection.** `golferMetrics(lines): GolferMetrics` (domain, pure, read-time — no clock, never stored) housing `whsIndex?` and `suggestedIndex?`, each `{ value, differentialsUsed }`; `getMyRecord` returns `metrics: GolferMetrics`, NOT a bespoke `index`/`suggested` pair. Adding a metric later is adding a member, not a new pathway. The application stamps `computedAtMs` onto the wire `whsIndex` (the domain fold stays pure).
- **Metrics are data points, never a nudge.** The web renders each metric as a labeled value with a one-tap "Use this"; a metric with no data renders `—`. No divergence threshold, no prose sentence, no auto-write.
- **`par` and `courseHandicap` are required on `GolferRoundLine`** (always computable in `archiveGolferLine`). This relies on the completed course-cards scrap having left zero stored round lines — there is no legacy line tier to tolerate.
- **Rated scoring is byte-identical.** Games, dots, AGS, differentials, and the frozen crewSeason/fieldTest decks (all rated) are unchanged. Unrated is strictly additive.
- No `Date.now()`/`randomUUID` inside domain functions. Conditional-spread optional keys — never an explicit `undefined` (DynamoDB `marshall` crash class).
- Commit after each task; message style `feat(scope): …` / `refactor(scope): …`, ending with the Claude Code co-author trailer.
- Controller-only (not in any task): beta deploy, `publishWeb.mjs`, live gates, CLAUDE.md, the browser walk.

## File Map

| Task | Creates | Modifies |
|---|---|---|
| T1 | — | `packages/domain/src/course/card.ts` (+test), `packages/domain/src/course/course.ts` (validation), `packages/domain/src/handicap/whs.ts` (guards) (+test), `packages/contracts/src/round.ts` |
| T2 | — | `packages/domain/src/scoring/allocation.ts` (+test), `packages/domain/src/round/archive.ts`, `packages/domain/src/golfer/record.ts` (+test), `packages/contracts/src/golfers.ts`, test fixtures building `GolferRoundLine` |
| T3 | — | `apps/web/src/routes/ProfilePage.tsx` (+test) |
| T4 | `packages/domain/src/golfer/metrics.ts` (+test) | `packages/domain/src/golfer/golfer.ts` (+test), `packages/domain/src/handicap/whs.ts` (`suggestedIndex`) (+test), `packages/contracts/src/golfers.ts`, `packages/adapters-dynamodb/src/createDynamoGolferStore.ts` (+contract test), `packages/application/src/golfers/getMyRecord.ts` (+test), `packages/application/src/golfers/updateMyGolfer.ts`, `packages/application/src/golfers/golferView.ts`, `apps/web/src/routes/ProfilePage.tsx` (migrate the sole `record.index` read) |
| T5 | — | `apps/web/src/courses/AddCoursePage.tsx` + `EditCoursePage.tsx` + `CoursePage.tsx` + `CourseSummaryCard.tsx` (+tests), `apps/web/src/routes/{CreateRoundPage,JoinRoundPage,ProfilePage}.tsx` (+tests), `packages/contracts/src/courses.ts` (peek), `packages/application/src/rounds/peekRound.ts` |
| T6 | `apps/web/e2e/unratedCourse.spec.ts` | `apps/web/e2e/support.ts` (unrated seed helper) |

---

### Task 1: Domain + contracts — unrated tees exist (additive)

**Files:**
- Modify: `packages/domain/src/course/card.ts` (+ its test), `packages/domain/src/course/course.ts` (`validateTeeSet`), `packages/domain/src/handicap/whs.ts` (`scoreDifferential`/`courseHandicapFor` guards) (+ `whs.test.ts`), `packages/contracts/src/round.ts` (`teeSetSchema`).

**Interfaces (Produces):**
- `TeeSet.rating?: number`, `TeeSet.slope?: number` (optional together); `isRated(tee): boolean`.
- New `DomainError` code `rating-slope-paired` (400) and `tee-unrated` (400).

- [ ] **Step 1: card.ts.** Make `rating`/`slope` optional on `TeeSet` and add `isRated`:

```ts
export interface TeeSet {
  readonly teeId?: TeeId;
  readonly name: string;
  readonly rating?: number; // present ⇔ slope present (validateTeeSet enforces the pairing)
  readonly slope?: number;
  readonly holes: readonly Hole[];
}

// A tee is rated iff both its course rating and slope are set — the one predicate every
// rating/slope-dependent path narrows through (spec §3).
export const isRated = (tee: TeeSet): tee is TeeSet & { rating: number; slope: number } =>
  tee.rating !== undefined && tee.slope !== undefined;
```

- [ ] **Step 2: course.ts validation.** In `validateTeeSet`, replace the unconditional rating/slope checks with paired-and-iff-present logic (keep every other check verbatim):

```ts
const ratingSet = tee.rating !== undefined;
const slopeSet = tee.slope !== undefined;
if (ratingSet !== slopeSet) {
  throw new DomainError("rating-slope-paired", `tee "${tee.name}" must set course rating and slope together, or neither (unrated)`);
}
if (ratingSet) {
  if (tee.rating! < RATING_BOUNDS.min || tee.rating! > RATING_BOUNDS.max) {
    throw new DomainError("invalid-rating", `tee "${tee.name}" rating ${tee.rating} outside ${RATING_BOUNDS.min}..${RATING_BOUNDS.max}`);
  }
  if (!Number.isInteger(tee.slope!) || tee.slope! < SLOPE_BOUNDS.min || tee.slope! > SLOPE_BOUNDS.max) {
    throw new DomainError("invalid-slope", `tee "${tee.name}" slope ${tee.slope} outside ${SLOPE_BOUNDS.min}..${SLOPE_BOUNDS.max}`);
  }
}
```

- [ ] **Step 3: whs.ts guards.** `scoreDifferential` and `courseHandicapFor` read `teeSet.rating`/`slope`, now `number | undefined`. Guard both (they are only legitimately called on rated tees):

```ts
export const scoreDifferential = (teeSet: TeeSet, ags: number): number => {
  if (!isRated(teeSet)) throw new DomainError("tee-unrated", `tee "${teeSet.name}" has no rating/slope — no differential to post`);
  return (113 / teeSet.slope) * (ags - teeSet.rating);
};

export const courseHandicapFor = (index: number, teeSet: TeeSet): number => {
  if (!isRated(teeSet)) throw new DomainError("tee-unrated", `tee "${teeSet.name}" is unrated — use round(index) for a course-handicap estimate`);
  const par = teeSet.holes.reduce((sum, hole) => sum + hole.par, 0);
  return roundHalfUp(index * (teeSet.slope / 113) + (teeSet.rating - par));
};
```

(import `isRated` and `DomainError` in whs.ts.)

- [ ] **Step 4: contracts/round.ts.** `teeSetSchema` rating/slope become `.optional()`:

```ts
export const teeSetSchema = z.object({
  teeId: teeIdSchema.optional(),
  name: z.string(),
  rating: z.number().optional(),
  slope: z.number().optional(),
  holes: z.array(holeSchema).readonly(),
});
```

- [ ] **Step 5: Tests (write alongside).** `card.test.ts`: `isRated` true when both set, false when neither, false when one. `course.test.ts` (or wherever `validateTeeSet` is tested): an unrated tee (both blank) passes; exactly one of rating/slope set throws `rating-slope-paired`; a rated tee with out-of-bounds rating still throws `invalid-rating`. `whs.test.ts`: `scoreDifferential`/`courseHandicapFor` on an unrated tee throw `tee-unrated`; the existing rated worked-example pins are unchanged.
- [ ] **Step 6:** `pnpm build && pnpm validate` green. Commit: `feat(domain,contracts): unrated tees — rating/slope optional as a pair, isRated narrows every dependent path`.

---

### Task 2: Domain + contracts — the unrated round & the record's new facts

**Files:**
- Modify: `packages/domain/src/scoring/allocation.ts` (`handicappingFor`) (+ its test), `packages/domain/src/round/archive.ts` (`handicapping[]` union), `packages/domain/src/golfer/record.ts` (`GolferRoundLine` + `archiveGolferLine`) (+ its test), `packages/contracts/src/golfers.ts` (`golferRoundLineFields`), and every in-repo fixture/test constructing a `GolferRoundLine`.

**Interfaces (Consumes T1's `isRated`. Produces):**
- `handicappingFor` third result `{ golferId; kind: "unrated"; ags }`.
- `GolferRoundLine` gains required `par: number`, `courseHandicap: number`; `ags` now also present on unrated lines.

- [ ] **Step 1: handicappingFor** (`allocation.ts`). Return type gains the `unrated` arm; when `!isRated(teeSet)`, compute AGS and return it without a differential:

```ts
):
  | { readonly golferId: GolferId; readonly kind: "complete"; readonly ags: number; readonly differential: number }
  | { readonly golferId: GolferId; readonly kind: "unrated"; readonly ags: number }
  | { readonly golferId: GolferId; readonly kind: "incomplete" } => {
  const teeSet = findTeeSet(card, participant.tee);
  const holes = new Map<number, HoleResult>();
  for (const hole of teeSet.holes) {
    const cell = cells[cellKey(participant.golferId, hole.number)];
    if (cell) holes.set(hole.number, cell.result);
  }
  try {
    const ags = adjustedGrossScore(teeSet, participant.courseHandicap, holes);
    // Unrated: the round is fully scored (AGS holds) but has no differential to post
    // (spec §4). It stays out of the WHS index by carrying no differential, never by a
    // downstream filter change.
    if (!isRated(teeSet)) return { golferId: participant.golferId, kind: "unrated", ags };
    const differential = scoreDifferential(teeSet, ags);
    return { golferId: participant.golferId, kind: "complete", ags, differential };
  } catch (error) {
    if (error instanceof DomainError && error.code === "holes-undecided") {
      return { golferId: participant.golferId, kind: "incomplete" };
    }
    throw error;
  }
};
```

(import `isRated`.)

- [ ] **Step 2: archive.ts.** Add the `unrated` kind to the `handicapping` union type (archive.ts:40) so `settleRound`'s `.map(handicappingFor …)` result stays assignable. No logic change — `settleRound` already stores whatever `handicappingFor` returns.
- [ ] **Step 3: record.ts.** `GolferRoundLine` gains `par`/`courseHandicap` (required); `archiveGolferLine` sets them and sets `ags` for the unrated kind:

```ts
export interface GolferRoundLine {
  readonly roundId: RoundId;
  readonly courseName: string;
  readonly courseId?: CourseId;
  readonly tee: string;
  readonly holes: 9 | 18;
  readonly par: number;            // sum of the frozen tee's hole pars (spec §5)
  readonly courseHandicap: number; // participant.courseHandicap, frozen at join
  readonly ags?: number;
  readonly differential?: number;
  readonly distribution: { /* unchanged */ };
}
```

In `archiveGolferLine`'s return, add `par` and `courseHandicap`, and broaden the ags/differential spread to cover the unrated kind:

```ts
par: teeSet.holes.reduce((sum, hole) => sum + hole.par, 0),
courseHandicap: participant.courseHandicap,
...(handicapping?.kind === "complete" ? { ags: handicapping.ags, differential: handicapping.differential } : {}),
...(handicapping?.kind === "unrated" ? { ags: handicapping.ags } : {}),
```

- [ ] **Step 4: contracts/golfers.ts.** `golferRoundLineFields` gains `par: z.number()` and `courseHandicap: z.number()` (required, matching the domain type). This flows into `golferRoundLineSchema`, `getMyRecordResponseSchema`, and `getMyRoundsResponseSchema` automatically.
- [ ] **Step 5: Fixtures.** Grep the repo for object literals that satisfy `GolferRoundLine` (domain `record.test.ts`, application `golferSlice.test.ts`, adapters `projectionStore.contract.test.ts`, contracts `golfers.test.ts`, any web fixture) and add `par`/`courseHandicap` to each — the typecheck will name every site. Give them meaningful values (e.g. `par: 72, courseHandicap: 8`) so the T4 suggested-index tests can reuse them.
- [ ] **Step 6: Tests.** `allocation.test.ts`: an unrated tee with all holes decided → `{kind:"unrated", ags}` (assert the AGS equals the rated computation's AGS for the same scores — AGS is rating/slope-independent); still `incomplete` when a hole is undecided. `record.test.ts`: an unrated archive folds to a line with `ags` and NO `differential`, plus `par`/`courseHandicap`; a rated archive still carries the differential.
- [ ] **Step 7:** `pnpm build && pnpm validate` green; `pnpm test:contract` green. Commit: `feat(domain,contracts): unrated rounds post an AGS not a differential; round lines record par + course handicap`.

---

### Task 3: Web sheds `official` (consumer-first)

**Files:** `apps/web/src/routes/ProfilePage.tsx` (+ its test). The only web read of `official` is the `effectiveIndex` composition (ProfilePage.tsx:187).

- [ ] **Step 1:** Change the effective-index composition to drop `official`:

```ts
const effective = effectiveIndex({ declared: auth.golfer?.declared, computed: record?.index?.value });
```

(This compiles today — `effectiveIndex` still accepts `official` as an optional key in T3's pre-change signature; you are simply no longer passing it. After T4 narrows the signature, this call already matches.) Remove any other `auth.golfer?.official` reference on the page if present. Leave `record?.index?.value` as-is — the wire still exposes `index` at this point; T4 renames the record's read side to `record.metrics.whsIndex` and migrates this one read in the same commit as the contract change.
- [ ] **Step 2:** Update the ProfilePage test if it asserted an official-driven effective value; otherwise no test change. `pnpm -F @swng/web test` green.
- [ ] **Step 3:** `pnpm validate` green. Commit: `refactor(web): ProfilePage composes effective index from declared + computed only — official is retired`.

---

### Task 4: Domain + contracts + adapters + application + web — the three-number model & the metrics projection

**Files:**
- Create: `packages/domain/src/golfer/metrics.ts` (+ `metrics.test.ts`).
- Modify: `packages/domain/src/golfer/golfer.ts` (`HandicapProfile`, `effectiveIndex`) (+ test), `packages/domain/src/handicap/whs.ts` (`suggestedIndex`) (+ test), `packages/domain/src/index.ts` (export the metrics module), `packages/contracts/src/golfers.ts` (`GolferView`, `updateMeRequestSchema`, `GetMyRecordResponse`), `packages/adapters-dynamodb/src/createDynamoGolferStore.ts` (fold `official`→`declared` on read) (+ contract test), `packages/application/src/golfers/getMyRecord.ts` (return `metrics`) (+ test), `packages/application/src/golfers/updateMyGolfer.ts` and `golferView.ts` (drop `official`), `apps/web/src/routes/ProfilePage.tsx` (migrate the sole `record.index` read).

**Interfaces (Consumes T2's `GolferRoundLine {par, ags?, differential?, holes}`. Produces):**
- `HandicapProfile = { declared? }`; `effectiveIndex({declared?, computed?}) → {value, source: "declared"|"computed"} | undefined`.
- `suggestedIndex(lines) → IndexComputation | undefined` (whs.ts).
- `IndexMetric = { value: number; differentialsUsed: number }`; `GolferMetrics = { whsIndex?: IndexMetric; suggestedIndex?: IndexMetric }`; `golferMetrics(lines): GolferMetrics` (domain/golfer/metrics.ts, pure — the read projection).
- `GetMyRecordResponse.metrics: { whsIndex?: { value; computedAtMs; differentialsUsed }; suggestedIndex?: { value; differentialsUsed } }` — REPLACES the old top-level `index?`.

- [ ] **Step 1: golfer.ts.** `HandicapProfile` becomes `{ readonly declared?: number }`. Rewrite `effectiveIndex`:

```ts
export const effectiveIndex = (input: { readonly declared?: number; readonly computed?: number }):
  | { readonly value: number; readonly source: "declared" | "computed" } | undefined => {
  if (input.declared !== undefined) return { value: input.declared, source: "declared" };
  if (input.computed !== undefined) return { value: input.computed, source: "computed" };
  return undefined;
};
```

- [ ] **Step 2: whs.ts suggestedIndex.** The declaration aid — the pinned engine on neutral pseudo-differentials:

```ts
// The SUGGESTED index (spec §6): computeIndexDetail over difficulty-neutral pseudo-differentials
// (ags − par, i.e. scoreDifferential at slope 113 / rating = par), including EVERY round that has
// an AGS — rated or unrated. Reuses the pinned small-sample table and the 2020 nine-hole pairing
// verbatim; read-time only, never stored. This is a declaration aid, NOT an effectiveIndex source.
export const suggestedIndex = (lines: readonly { readonly ags?: number; readonly par: number; readonly holes: 9 | 18 }[]): IndexComputation | undefined => {
  const pseudo = lines
    .filter((line): line is typeof line & { ags: number } => line.ags !== undefined)
    .map((line) => ({ differential: line.ags - line.par, holes: line.holes }));
  return computeIndexDetail(combineNineHoleDifferentials(pseudo));
};
```

- [ ] **Step 3: metrics.ts — the read projection.** New file `packages/domain/src/golfer/metrics.ts` holding the metrics shape and the one fold that produces every member. `whsIndex` is the read-time WHS index computation MOVED here out of `getMyRecord` (byte-identical math — rated differentials only); `suggestedIndex` calls Step 2:

```ts
import { combineNineHoleDifferentials, computeIndexDetail, suggestedIndex } from "../handicap/whs.js";
import type { GolferRoundLine } from "./record.js";

// One derived number over the golfer's rounds; difficulty labeling lives in the UI, not here.
export interface IndexMetric {
  readonly value: number;
  readonly differentialsUsed: number;
}

// The metrics projection (spec §6): a read over the golfer's round lines producing every
// derived index in one place. `whsIndex` is Rule 5.2a over RATED differentials only (the
// existing `differential !== undefined` filter — unrated rounds carry none, so they cannot
// reach it); `suggestedIndex` is the neutral-course estimate over `ags − par`, every ags-
// bearing round. Grows to N members (scoring-vs-par, distribution, trend) when a surface needs
// them — adding a metric is adding a field here, not carving a new pathway. Read-time only,
// never stored: the fold is pure (no clock); the application stamps time on the wire.
export interface GolferMetrics {
  readonly whsIndex?: IndexMetric;
  readonly suggestedIndex?: IndexMetric;
}

export const golferMetrics = (lines: readonly GolferRoundLine[]): GolferMetrics => {
  const rated = lines.filter((line) => line.differential !== undefined);
  const whs = computeIndexDetail(
    combineNineHoleDifferentials(rated.map((line) => ({ differential: line.differential!, holes: line.holes }))),
  );
  const suggested = suggestedIndex(lines);
  return {
    ...(whs !== undefined ? { whsIndex: { value: whs.value, differentialsUsed: whs.differentialsUsed } } : {}),
    ...(suggested !== undefined ? { suggestedIndex: { value: suggested.value, differentialsUsed: suggested.differentialsUsed } } : {}),
  };
};
```

Export `GolferMetrics`/`IndexMetric`/`golferMetrics` from `packages/domain/src/index.ts` alongside the other golfer exports.

- [ ] **Step 4: contracts/golfers.ts.** Drop `official` from `GolferView`, `golferViewSchema`, and `updateMeRequestSchema`. REPLACE the record response's top-level `index?` with a required `metrics` object (its two members optional — an empty `{}` is the honest answer for a golfer with no postable rounds):

```ts
export interface GetMyRecordResponse {
  readonly metrics: {
    readonly whsIndex?: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };
    readonly suggestedIndex?: { readonly value: number; readonly differentialsUsed: number };
  };
  readonly history: readonly GolferRoundLine[];
}
// getMyRecordResponseSchema.metrics = z.object({
//   whsIndex: z.object({ value: z.number(), computedAtMs: z.number().int(), differentialsUsed: z.number().int() }).optional(),
//   suggestedIndex: z.object({ value: z.number(), differentialsUsed: z.number().int() }).optional(),
// })  // required object, not .optional()
```

Update the `golfers.ts` header comment that still narrates a lone `index` field on the record.

- [ ] **Step 5: golfer store fold** (`createDynamoGolferStore.ts`). On the read path (`get`/`getBySub` deserialization of the stored golfer item), fold a legacy `official`: if the stored `handicap` has `official` and no `declared`, read it as `declared`; drop `official` and any stored `computed`. One narrow transform where the item becomes a `Golfer`. Contract-test it: put a raw item with `handicap: { official: 12 }` (bypassing the typed put, as the crew legacy-attribute contract test does), read it, assert `handicap: { declared: 12 }`.
- [ ] **Step 6: application.** `updateMyGolfer.ts`: drop the `official` patch arm (the `command.official` spread) — only `declared` remains in the handicap patch. `golferView.ts`: drop `official` from the projection. `getMyRecord.ts`: replace the inline index computation (the `complete`/`combined`/`detail` block) with a single `golferMetrics(sorted)` call — the domain fold now owns the whsIndex math; the app only stamps `computedAtMs` on the wire:

```ts
const metrics = golferMetrics(sorted);
return {
  metrics: {
    ...(metrics.whsIndex !== undefined
      ? { whsIndex: { value: metrics.whsIndex.value, computedAtMs: deps.clock.now(), differentialsUsed: metrics.whsIndex.differentialsUsed } }
      : {}),
    ...(metrics.suggestedIndex !== undefined ? { suggestedIndex: metrics.suggestedIndex } : {}),
  },
  history: sorted.reverse().map(toWireLine),
};
```

Also update the early return for a sub with no golfer row: `return { metrics: {}, history: [] };` (was `{ history: [] }`). Import `golferMetrics`; drop the now-unused `combineNineHoleDifferentials`/`computeIndexDetail` imports. `sorted` lines carry `par`/`ags`/`differential`/`holes` from T2.

- [ ] **Step 7: web reader migration** (`ProfilePage.tsx`). The sole reader of the old `record.index` is ProfilePage's effective-index composition (T3 left it as `record?.index?.value`). Migrate it to the renamed wire — same commit as the contract change, so `pnpm validate` stays green:

```ts
const effective = effectiveIndex({ declared: auth.golfer?.declared, computed: record?.metrics?.whsIndex?.value });
```

(Rendering the metrics as data points is T5 — this step only keeps the effective-index composition compiling against the renamed wire.)

- [ ] **Step 8: Tests.** `golfer.test.ts`: `effectiveIndex` returns declared over computed; computed when no declared; undefined when neither. `whs.test.ts`: `suggestedIndex` over a hand-computed set of `ags − par` values (mix a 9 and an 18 to exercise pairing) matches `computeIndexDetail` on the same pseudo-differentials; a line with no `ags` is skipped. `metrics.test.ts`: `golferMetrics` returns `whsIndex` from rated (differential-bearing) lines only and `suggestedIndex` from every ags-bearing line; a wholly-unrated history yields `{ suggestedIndex }` and no `whsIndex`; an empty history yields `{}`. `getMyRecord` test: response carries `metrics.suggestedIndex`; a wholly-unrated history yields `metrics` with `suggestedIndex` but no `whsIndex`; the newest-first history order is unchanged. Golfer-store contract test as in Step 5.
- [ ] **Step 9:** `pnpm build && pnpm validate` green; `pnpm test:contract` green. Commit: `feat(domain,application,web): the metrics read projection — golferMetrics housing whsIndex + the suggested index; declared overrides computed, official collapses`.

---

### Task 5: Web + contracts — unrated entry/display, suggested course handicap, the profile

**Files:**
- Modify: `packages/contracts/src/courses.ts` (`PeekRoundResponse.teeSets`), `packages/application/src/rounds/peekRound.ts`; `apps/web/src/courses/{AddCoursePage,EditCoursePage,CoursePage,CourseSummaryCard}.tsx`; `apps/web/src/routes/{CreateRoundPage,JoinRoundPage,ProfilePage}.tsx` (+ their tests).

- [ ] **Step 1: peek** — carry par, make rating/slope optional. `PeekRoundResponse.teeSets` becomes `{ name; rating?; slope?; par }` (schema: rating/slope optional, par required int). `peekRound.ts` maps `par: tee.holes.reduce((s,h)=>s+h.par,0)`, `rating: tee.rating, slope: tee.slope` (spread-optional so undefined keys never serialize).
- [ ] **Step 2: entry/display.** AddCoursePage + EditCoursePage: rating and slope inputs become optional — helper text "No course rating on the card? Leave these blank." `canSubmit` no longer requires them; parse them only when non-blank; a value in exactly one of the two shows the `rating-slope-paired` server error on the pair. Display everywhere a tee's numbers render — CoursePage tee `<option>`/summary, CourseSummaryCard's `<select>` and attribution, both create/join tee pickers — use a shared helper:

```ts
export const teeNumbers = (t: { rating?: number; slope?: number }): string =>
  t.rating !== undefined && t.slope !== undefined ? `rating ${t.rating}, slope ${t.slope}` : "unrated";
```

- [ ] **Step 3: suggested course handicap.** On CreateRoundPage (has the full card) and JoinRoundPage (has the peek), pre-fill the course-handicap field, editable, whenever the golfer has an effective index:
  - Compose the effective index client-side: `effectiveIndex({ declared: auth.golfer?.declared, computed: record?.metrics?.whsIndex?.value })`. Fetch `GET /me/record` for `computed` (CreateRoundPage/JoinRoundPage don't today — add a one-shot fetch; if it fails, fall back to `declared` only, never block).
  - Rated selected tee → `courseHandicapFor(effective, tee)`, label "suggested (WHS)". Unrated → `Math.round(effective)`, label "estimated — unrated course". No effective index → today's blank field, no label.
  - Pre-fill only when the field is still at its default/untouched; a golfer's typed value always wins (mirror AddCoursePage's auto-fill idiom: seed once, never overwrite a touched field).
- [ ] **Step 4: ProfilePage.** Beside the declared-index input, render `record.metrics` as labeled key-value data points — `Suggested · {metrics.suggestedIndex.value}` and `WHS index (computed) · {metrics.whsIndex.value}` — each with a one-tap "Use this" that fills the declared field. A metric with no data renders `—` (a golfer with only unrated rounds shows a suggested value and `—` for the WHS index; a brand-new golfer shows `—` for both). No divergence nudge, no threshold, no prose sentence, no auto-write: just the numbers, and the golfer decides which to declare.
- [ ] **Step 5: Tests.** Peek contract test carries par + tolerates an unrated tee. AddCoursePage/EditCoursePage: submit an unrated course (rating/slope blank) → request body omits rating/slope; one-of-two-set surfaces the paired error. CreateRoundPage/JoinRoundPage: with a stubbed effective index, the CH field pre-fills (rated → courseHandicapFor value; unrated → round(index)) and a typed value overrides. ProfilePage: the suggested-index data point renders and "Use this" fills declared; a metric with no data renders `—` (no nudge, no threshold).
- [ ] **Step 6:** `pnpm validate` green. Commit: `feat(web,contracts): enter and play unrated courses; suggested course handicap; the declaration aids on Profile`.

---

### Task 6: E2E — the unrated round, end to end

**Files:** Create `apps/web/e2e/unratedCourse.spec.ts`; modify `apps/web/e2e/support.ts` (an unrated-course seed helper, or a flag on `ensureCourse`).

- [ ] **Step 1:** A signed-in account enters a **9-hole unrated** course (rating/slope blank) through AddCoursePage, lands on the course page (tee reads "unrated"), starts a round on it, adds a skins or singles game, and scores a few holes — asserting **games and dots work** (dot allocation from SI + course handicap, unaffected by the missing rating). Then finalize (or read the record) and assert: the round shows an **AGS but "not posted / unrated"**, the golfer's **WHS index is unchanged** (still whatever it was — an unrated round cannot move it), and the **suggested index** reflects the round (present, derived from `ags − par`). Follow `courseEntry.spec.ts`'s account-minting/token-injection idioms; the hand-picked hole pars/SIs and any dot assertions are the gate — pin them to hand arithmetic, BLOCKED (not adjusted) on disagreement.
- [ ] **Step 2:** Audit `support.ts` and every existing spec: the frozen decks are all **rated** and must stay untouched (their numbers are unchanged by this arc). The unrated seed is a NEW helper/fixture, not a mutation of `fixtureLinks`/`fixtureLinks18`/the crewSeason deck.
- [ ] **Step 3:** `pnpm validate` (typecheck/lint — the spec runs live under the controller's gate). Commit: `test(e2e): an unrated 9-hole course plays games, posts no differential, feeds the suggested index`.

---

## Controller close-out (not a task)

Final whole-branch review (most-capable model, accumulated minors as its triage list) → one beta deploy (lambda) + `publishWeb.mjs` (web) → `pnpm e2e:beta` ×2 → the full field suite incl. the new `unratedCourse.spec.ts` (and confirm the rated decks are byte-unchanged) → a browser walk on beta entering and playing a real unrated course, declaring an index from the suggestion → CLAUDE.md arc paragraph + ledger close.

## Self-Review (performed while writing)

- **Spec coverage:** §3 unrated tees → T1; §4 unrated round → T2; §5 line fields → T2; §6 the metrics projection (`golferMetrics` housing `whsIndex` + the suggested index) → T4; §7 declared-wins/official-collapse + data-points-not-a-nudge → T3 (web sheds official) + T4 (model, wire rename, reader migration) + T5 (data-point display); §8 suggested course handicap → T5; §9 display rule → T5 (surfaced) + recorded; §10 rollout → controller; invariants 1–9 each pinned by a named test.
- **Green-per-commit:** T1 additive (existing cards carry both numbers); T2 moves domain+contracts+fixtures together (required-field change); T3 web-sheds-official before T4 drops it from the contract (consumer-first), leaving `record.index` intact for T4 to rename; T4 renames the record's read side (`index`→`metrics`) across domain+contracts+application AND migrates its one web reader (ProfilePage) in the SAME commit, so validate stays green across the wire rename, plus the store fold so no golfer reader breaks; T5 web additive.
- **Type consistency:** `isRated` (T1) narrows in `handicappingFor`/`suggestedIndex` (T2/T4); `GolferRoundLine {par, ags?, differential?, holes}` (T2) consumed by `golferMetrics` (T4); `golferMetrics(lines): GolferMetrics {whsIndex?, suggestedIndex?}` (T4) surfaced as `GetMyRecordResponse.metrics` and read by ProfilePage as `record.metrics.whsIndex` (T4 migration) / `record.metrics.suggestedIndex` (T5 display); `effectiveIndex({declared?, computed?})` (T4) composed from `declared` + `metrics.whsIndex.value` at every call site (ProfilePage T4/T5, create/join T5); `PeekRoundResponse.teeSets {name,rating?,slope?,par}` (T5) consistent across app + web.
- **Frozen decks:** all rated; T2/T6 explicitly leave them byte-unchanged.
