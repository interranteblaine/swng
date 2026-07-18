# Restore the domain boundary — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Get every golf computation out of `apps/web` and into `@swng/domain`, so the server serves
all read results through the API and the frontend only renders. Papercut 17 is one line item inside
this.

**Authority:** `docs/superpowers/specs/2026-07-18-restore-domain-boundary-design.md`. It records the
reasoning; it is not itself proof anything is right — judge each change on whether the number is
identical before/after and whether the web still computes it. The numbers must not move (the field
oracle decks and e2e gates enforce that).

**The architecture, grounded in the code (not aspirational):**
- `@swng/domain` — golf logic, one copy.
- The **server** runs it behind the API for all reads + finalize.
- `@swng/client` — already folds AND scores on-device: its `RoundSession` exposes `state()`
  (`reduceRound(confirmed ∪ outbox)`) and `games()` (`scoreGame` over `state().games`). The live
  round (`useRoundSession`) already reads `session.games()` and does no scoring itself.
- `apps/web` — the UI. Renders only. The defect is the places that deviate from what the live round
  already does: two screens reach past `@swng/client` into `@swng/domain`, and several panels
  compute results on top of what they're handed.

**The three moves:** (1) move all golf math into `@swng/domain` and make its outputs *complete* so
nothing computes on top; (2) route the two deviating screens through `@swng/client` like the live
round; (3) lock it — `apps/web` may not import `@swng/domain` compute, enforced by ESLint.

**Tech Stack:** TypeScript ESM, Zod, React 19, Vitest, Playwright.

## Global Constraints

- **The numbers do not change.** Every moved computation produces the identical result; this is a
  relocation, not a recomputation. A moved number that differs is a bug. The e2e oracle decks
  (`fieldDeck18`, `crewSeasonDeck`) and `pnpm e2e:field`/`e2e:beta` are the backstop.
- **`apps/web` computes no golf result.** It reads results from the API or from `@swng/client`
  (`session.games()` / a read-only fold), and it may call only *presentation* helpers from
  `@swng/domain` (`formatHandicapIndex`, `formatCourseHandicap`, `strokeGrant`, `resolveIndex`),
  *type* imports, *id constructors* (`deviceId`/`courseId`/`roundId`/…), and pure *accessors* that
  produce no golf result (`cellKey`, `findTeeSet`). Everything that computes a golf result
  (`scoreGame`, `reduceRound`, `settleRound`, `golferMetrics`, `allocateStrokes`,
  `gameStrokeAllocation`, `courseHandicapFor`, `courseHandicapFromRatingSlopePar`, `handicappingFor`,
  `resultOf`, `defaultAllowance`, `playingHandicap`) leaves the web.
- **Every moved computation gets a domain unit test** — the point is that the core vouches for the
  number. Web tests shrink to "renders the value it was given."
- **Green per commit:** `pnpm validate` at the end of each task; `pnpm test:contract` after any
  contract change.
- Conditional-spread optional keys — never an explicit `undefined`.
- `NODE_OPTIONS=` prefix if a cmux `MODULE_NOT_FOUND` preload error appears. Focused test:
  `NODE_OPTIONS= pnpm -F <pkg> exec vitest run <file>`.
- Commit per task; `feat`/`refactor(scope): …` + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push.
- Controller-only (not a task): `deploy:beta`, `publishWeb`, live gates, the browser walk, CLAUDE.md.

---

### Task 1: Analytics move to the server (absorbs papercut 17)

`golferMetrics` grows `distribution` + `trend`; the API serves them; `ProfilePage` renders them and
deletes its `reduce`/`trendPoints`.

**Files:** `packages/domain/src/golfer/metrics.ts` (+test); `packages/contracts/src/golfers.ts`
(+test); `packages/application/src/golfers/getMyRecord.ts` (+test); `apps/web/src/routes/ProfilePage.tsx`
(+test); fixture sweep for `GetMyRecordResponse`.

**Interfaces (Produces):** `ScoringDistribution` (5 int members); `GolferMetrics.distribution:
ScoringDistribution` + `GolferMetrics.trend: readonly number[]` (both required);
`GetMyRecordResponse.metrics.distribution` + `.trend`.

- [ ] **Step 1:** Failing domain tests in `metrics.test.ts`: `golferMetrics([...]).distribution`
  sums each bucket across ALL lines; `.trend` is the posted differentials (lines without one
  excluded), newest ≤20, oldest→newest (`= rated.map(l=>l.differential!).slice(-20)`); empty lines →
  zeros + `[]`; >20 → newest 20.
- [ ] **Step 2:** Run — FAIL. Then add to `metrics.ts`:

```ts
export interface ScoringDistribution {
  readonly eagles: number; readonly birdies: number; readonly pars: number;
  readonly bogeys: number; readonly doublePlus: number;
}
// on GolferMetrics, both required:
  readonly distribution: ScoringDistribution;   // career totals across all lines (zeros if none)
  readonly trend: readonly number[];            // newest ≤20 posted differentials, oldest→newest
```
  In `golferMetrics`, `const rated = lines.filter(l => l.differential !== undefined)` (already
  exists); compute `distribution` by summing `line.distribution` across `lines`, `trend =
  rated.map(l => l.differential!).slice(-20)`; add both to the returned object (plain, always
  present). Run — PASS.
- [ ] **Step 3:** `contracts/golfers.ts` — add to `GetMyRecordResponse.metrics` and
  `getMyRecordResponseSchema`: `distribution` (`z.object` of 5 `z.number().int()`) and
  `trend: z.array(z.number()).readonly()`, both required. Contract tests accept them, reject a
  metrics object missing either.
- [ ] **Step 4:** `application/getMyRecord.ts` — spread `distribution: metrics.distribution, trend:
  metrics.trend` onto the wire metrics (plain, always present). Fix the no-golfer early return to
  `{ metrics: { distribution: {eagles:0,birdies:0,pars:0,bogeys:0,doublePlus:0}, trend: [] }, history: [] }`.
  Test: response metrics equal `golferMetrics(sorted)`'s for a mixed rated/unrated/incomplete fixture.
- [ ] **Step 5:** Fixture sweep — every `GetMyRecordResponse`/`metrics` fixture gains the two
  members: `grep -rn "metrics:" packages apps --include=*.ts --include=*.tsx | grep -viE "\.metrics\.|dist/"`
  and the web mocks. Add zeros/empty (or asserted values).
- [ ] **Step 6:** `ProfilePage.tsx` — delete `trendPoints` and the `DistributionBars` `reduce`.
  `IndexTrend` takes `points: readonly number[]` (renders `<polyline>` only when `≥2`);
  `DistributionBars` takes `distribution` (its `DistributionKey = keyof
  GetMyRecordResponse["metrics"]["distribution"]`; `Math.max(1,...)` scaling is VIEW, stays). Render
  site passes `record?.metrics.trend ?? []` and `record?.metrics.distribution ?? {…zeros}`. Update
  the ProfilePage tests to assert render-from-metrics (no recomputed reduce).
- [ ] **Step 7:** `NODE_OPTIONS= pnpm validate` + `pnpm test:contract` — GREEN. Commit:
  `feat(domain,contracts,application,web): scoring distribution + index trend are a served metric, not web math`.

---

### Task 2: The scored game is complete — `describeGame` becomes pure formatting

The scored `GameState` from `scoreGame` already carries the match-play leaders (`describeGame` reads
`game.up`/`leader`/`outcome`/`dormie` for singles/fourball). It does NOT carry: relative-to-par, the
stroke-play/stableford leader, or skins holes-decided. Add them, so `describeGame` only formats.

**Files:** `packages/domain/src/scoring/*.ts` (the game engines + `GameState` union in `game.ts`),
`packages/client/src/session.ts` if a scored-line type is re-exported; `apps/web/src/games/describeGame.ts`
(+test); domain scoring tests.

- [ ] **Step 1:** Read `packages/domain/src/scoring/game.ts` (the `GameState` discriminated union)
  and the five engines (`strokePlay.ts`, `stableford.ts`, `singlesMatch.ts`, `fourballMatch.ts`,
  `skins.ts`) to see each kind's current scored shape. Confirm exactly which fields `describeGame`
  reads that the engine does NOT already provide: **stroke-play** — `relativeToPar` per line + the
  leader (lowest total); **stableford** — the leader (highest points); **skins** — `holesDecided`
  (the "every player recorded, stop at first gap" count `describeGame:112-121` replays). Report the
  exact current shapes before editing.
- [ ] **Step 2:** Add the missing fields to the scored output, TDD per kind:
  - **stroke-play line:** add `relativeToPar: number` (the line's total minus par-thru-holes-counted;
    the engine already knows `thru` and the tee) and a game-level `leader` (the golferId(s) at the
    lowest total, matching `describeGame`'s current `Math.min` + ties). Write a domain test pinning
    both against a fixture, THEN implement in `strokePlay.ts`.
  - **stableford:** add a game-level `leader` (golferId(s) at the highest points). Test then implement.
  - **skins:** add `holesDecided: number` to the scored skins state (the count `describeGame` replays).
    Test then implement.
  (Match-play kinds already expose leader/outcome — no change.)
- [ ] **Step 3:** `describeGame.ts` — delete the inline math (`:55-56` par-sum + relative-to-par,
  `:59-62` stroke-play leader, `:69-70` stableford leader, `:112-121` skins holes-decided). Each
  `describeX` now READS the new scored fields and only formats strings (`nameOf`, `vsPar`, the
  join). `describeGame` imports drop to types + `nameOf` helpers — no `findTeeSet`/`cellKey` needed
  for the deleted par-sum (confirm they're unused after and remove).
- [ ] **Step 4:** Update `describeGame`'s test to assert the formatted strings are unchanged for a
  fixture (byte-identical output — the whole point is the numbers don't move). Domain engine tests
  cover the new fields.
- [ ] **Step 5:** `NODE_OPTIONS= pnpm validate` — GREEN. Commit:
  `feat(domain): the scored game carries relative-to-par, leaders, and skins carry — describeGame only formats`.

---

### Task 3: Finalize-readiness is a domain function

`finalizeReadiness.ts:16-77` computes which games block finalize and which holes are unscored —
the comment admits it mirrors `settleRound`'s must-resolve set. Move that rule into `@swng/domain`.

**Files:** `packages/domain/src/scoring/` or `round/` (a new `unresolvedGames`/`finalizeReadiness`
export, shared with `settleRound`'s must-resolve logic) (+test); `apps/web/src/round/finalizeReadiness.ts`
(becomes a thin caller) (+test); `apps/web/src/routes/RoundPage.tsx` (call site).

- [ ] **Step 1:** Read `settleRound`'s must-resolve logic and the web `finalizeReadiness.ts`. Extract
  the shared rule — "which games are unresolved given state + scored games, and which holes are
  missing per player" — into a domain function `unresolvedGames(state, games)` (and whatever
  `settleRound` already uses internally; reuse, don't duplicate). TDD: a domain test pinning the
  unresolved set for a partial-round fixture, then implement.
- [ ] **Step 2:** `apps/web/src/round/finalizeReadiness.ts` — delete `missingHolesFor`/`unresolvedGames`/
  the readiness math; keep only the VIEW part (`formatHoleRanges`, "2–4, 7–8" string building) and
  call the domain `unresolvedGames`. `RoundPage.tsx:45` uses the domain result.
- [ ] **Step 3:** `NODE_OPTIONS= pnpm validate` — GREEN. Commit:
  `refactor(domain,web): finalize-readiness is a domain rule shared with settleRound, not web math`.

---

### Task 4: Net, totalDots, and the unrated estimate become domain functions

**Files:** `packages/domain/src/scoring/strokes.ts` (or `allocation.ts`) + `handicap/whs.ts` (+tests);
`apps/web/src/round/ScorecardGrid.tsx`, `apps/web/src/round/dots.ts`,
`apps/web/src/routes/CreateRoundPage.tsx`, `apps/web/src/routes/JoinRoundPage.tsx` (+tests).

- [ ] **Step 1:** `netStrokes` — a domain function for a cell's net (`gross − allocatedDots`). TDD in
  domain, then `ScorecardGrid.tsx:74` reads it instead of computing `cell.result.strokes - dots`
  inline. (The dots already come from the domain via `gameDots`; net now does too.)
- [ ] **Step 2:** `totalDots` — move `apps/web/src/round/dots.ts:31`'s sum into `@swng/domain`
  (beside `gameStrokeAllocation`), TDD there. `dots.ts` imports it (or `SetupPanel` calls the domain
  export). If `dots.ts` ends up with no golf math left, note it; `gamePlayers` (pure config read)
  may stay as a view helper.
- [ ] **Step 3:** `unratedCourseHandicap(index, holeCount)` — the estimate hand-duplicated at
  `CreateRoundPage.tsx:137` and `JoinRoundPage.tsx:137` (`holeCount === 9 ? round(index/2) :
  round(index)`) becomes ONE domain function in `handicap/whs.ts`, TDD there. Both pages call it (the
  rated path already calls `courseHandicapFor`/`courseHandicapFromRatingSlopePar`; now the unrated
  path is domain too, and the duplication is gone).
- [ ] **Step 4:** `NODE_OPTIONS= pnpm validate` — GREEN. Commit:
  `feat(domain,web): net, dots total, and the unrated handicap estimate are domain functions`.

---

### Task 5: Route the read-only screens through `@swng/client`, then lock the door

The live round already gets scored games from `@swng/client` (`session.games()`). `WatchPage`/
`ArchivedRoundPage` bypass it and call `@swng/domain`'s `reduceRound`/`scoreGame` directly. Give
`@swng/client` a read-only fold-and-score, route them through it, then ban `@swng/domain` compute
from `apps/web`.

**Files:** `packages/client/src/session.ts` (+ `index.ts` export) (+test);
`apps/web/src/watch/useWatchRound.ts`, `apps/web/src/round/ArchivedRoundPage.tsx` (+tests);
`eslint.config.mjs`.

- [ ] **Step 1:** Add a read-only fold to `@swng/client` — `foldAndScore(events: readonly
  RoundEvent[]): { state: RoundState; games: readonly GameState[] }` (reuses the SAME
  `reduceRound` + filter-to-known-kinds + `scoreGame` the live `RoundSession` already runs at
  session.ts:130-134/332). Also export `KNOWN_GAME_KINDS` from `@swng/client` (the web files
  currently re-declare it). TDD in the client package.
- [ ] **Step 2:** `useWatchRound.ts` + `ArchivedRoundPage.tsx` — replace the direct
  `reduceRound`/`scoreGame` imports from `@swng/domain` with `@swng/client`'s `foldAndScore` and its
  `KNOWN_GAME_KINDS`; delete the locally re-declared constant. Their tests assert the same rendered
  standings (numbers unchanged).
- [ ] **Step 3:** Verify the whole web tree is clean — no remaining `@swng/domain` **compute**
  import in `apps/web/src` (excluding tests):
  `grep -rnE "from \"@swng/domain\"" apps/web/src --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -vE "^import type|\{ *(deviceId|courseId|roundId|golferId|crewId|cardId|makeCrewId|makeCourseId|makeRoundId|cellKey|findTeeSet|formatHandicapIndex|formatCourseHandicap|strokeGrant|resolveIndex)[ ,}]"`
  must be empty. Anything left is a leak to move (back to the relevant task) — report it.
- [ ] **Step 4:** Add the ESLint rule to `eslint.config.mjs` — an `apps/web/**` override with
  `no-restricted-imports` for `@swng/domain` that ALLOWS only the presentation formatters, id
  constructors, `cellKey`/`findTeeSet`, and `import type`, and rejects every other value import
  (name the banned compute exports explicitly, or use an allow-list pattern). Add a fixture test: a
  throwaway `apps/web` file importing `scoreGame` fails `pnpm lint` (then delete it).
- [ ] **Step 5:** `NODE_OPTIONS= pnpm validate` — GREEN (lint now enforces the boundary). Commit:
  `refactor(client,web): read-only rounds fold through @swng/client; ESLint bans domain compute in the web`.

---

### Task 6: Write the boundary down

**Files:** `docs/architecture.md`, `docs/engineering-conventions.md`.

- [ ] **Step 1:** `architecture.md` — a short "Where golf logic lives" section: one domain package;
  the server runs it behind the API for reads/finalize; `@swng/client` runs the same code on-device
  for the live/offline round (`state()`/`games()`); the web renders only. The ESLint rule is the
  fence.
- [ ] **Step 2:** `engineering-conventions.md` — reference the section and name the lint rule as the
  enforced boundary (this repo's conventions are "enforced by ESLint where possible; a lint failure
  is the source of truth"). Commit: `docs: the domain boundary — golf logic in the domain, the web renders`.

---

### Task 7: E2E reconciliation

- [ ] **Step 1:** `grep -rn "Scoring distribution\|Index trend\|Your record\|Eagle or better\|thru\|leads\|net" apps/web/e2e e2e`
  and reconcile any assertion whose DOM/copy changed. The numbers are identical by design, and the
  DOM structure is unchanged, so this is likely a near-zero-diff — record it if so, no empty commit.
- [ ] **Step 2:** `NODE_OPTIONS= pnpm validate`. Commit only if a spec changed.

## Close-out (controller-run gate)
`deploy:beta` LAMBDA-FIRST (Task 1's `metrics` wire fields) → `publishWeb` → `e2e:beta` ×2 →
`e2e:field` → a browser walk on a golfer WITH history (trend + distribution visible) AND a live round
(standings, net, finalize-readiness) → docs sweep (CLAUDE.md).

## Self-Review (performed while writing)
- **Spec coverage:** §2 invariant (golf math in the domain, web renders) → every task moves a
  computation + Task 5's lint fence; §3 the 10 leaks → Task 1 (2 analytics), Task 2 (4 describeGame),
  Task 3 (readiness), Task 4 (net/totalDots/unrated) — 10 total; §4 close the door → Task 5
  (foldAndScore + ban); the "numbers don't move" invariant → each task's byte-identical assertion +
  the e2e decks.
- **Grounded, not aspirational:** `@swng/client` already exposes `state()`/`games()` and the live
  round already reads them (session.ts:32-35, useRoundSession.ts:73) — Task 5 extends that to
  read-only logs rather than inventing a role.
- **Ordering:** the ban (Task 5) comes AFTER the moves (1–4), because the web must stop needing
  domain compute before the fence can stand.
- **No placeholders in the mechanical steps;** Tasks 2/3 open with "read the current shape and report"
  because the exact scored-game fields are design-bearing and must be pinned to the real union, not
  guessed.
