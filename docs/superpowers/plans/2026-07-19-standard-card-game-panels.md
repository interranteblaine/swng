# Standard Card & Game Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The card never changes (gross + course-handicap dots, always); games open in ONE tap as inline panels that state their handicap treatment in words; scores can be cleared — per `docs/superpowers/specs/2026-07-19-standard-card-game-panels-design.md`.

**Architecture:** A new additive `cleared` HoleResult with ONE reader accessor (`cellAt`) hiding cleared cells from every engine/walk; a new `courseHandicapAllocation` domain compute (fence-banned, client-re-exported) driving a game-agnostic grid; `StandingsHeader` becomes a disclosure list over inline `GamePanel`s (the former GameSheet, de-modaled); treatment copy stays one-copy formatters.

**Tech Stack:** TypeScript ESM monorepo; Vitest; React 19 + Tailwind 4; Playwright e2e.

## Global Constraints

- Work on local `main`. **NEVER push.**
- Per-task gate: the touched package's focused tests AND its `typecheck`, then `pnpm validate` before each commit.
- **Scoring math untouched; the settled wire changes ONLY by the additive `cleared` arm** of `holeResultSchema`. Golden decks pass unchanged.
- **Fold retention rule:** cleared cells STAY in `state.cells` under HLC-latest (deleting breaks commutativity); readers hide them via `cellAt` only.
- Verbatim copy (binding): `Clear score`; `Net — {allowancePhrase}`; `Gross — raw scores, no strokes`; `No strokes — everyone plays off 0.`; `Match play uses the difference — only the higher handicap gets strokes.`; `Four-ball plays everyone off the lowest handicap.`; panel region aria-label `{title} standings`.
- Fence: banlist grows exactly one name (`courseHandicapAllocation`); `cellAt` is an accessor (cellKey's class), importable directly — NOT banned.
- Stroke-play panel sort: `a.relativeToPar - b.relativeToPar || b.thru - a.thru`. Stableford stays points-descending.
- Deploy order at close-out is LAMBDA-FIRST, web published immediately after (old bundles parse-fail on receiving a `cleared` event — accepted stale-bundle window, beta).
- Review-gate greps (Task 1 close + final review): `grep -rn "\.cells\[" packages/domain/src packages/client/src apps/web/src --include="*.ts" --include="*.tsx" | grep -v test` returns only the fold's own writes (round/state.ts) and `cellAt`/`cellKey` definition sites; no game-typed prop on ScorecardGrid.

---

### Task 1: Domain + contracts — the `cleared` result and the one cell accessor

**Files:**
- Modify: `packages/domain/src/round/holeResult.ts` (add the arm)
- Modify: `packages/domain/src/round/state.ts` (add `cellAt` beside `cellKey`)
- Modify (reader sweep, all through `cellAt`): `packages/domain/src/scoring/strokePlay.ts:25`, `stableford.ts:21`, `skins.ts:28`, `singlesMatch.ts:41-42`, `fourballMatch.ts:32,48`, `players.ts:29`, `allocation.ts:96` (handicappingFor), `packages/domain/src/round/archive.ts:95,129`, `packages/domain/src/golfer/record.ts:42`
- Modify: `packages/contracts/src/round.ts` (`holeResultSchema` + cleared arm)
- Test: `packages/domain/src/round/reduce.test.ts` (or the file holding the fold's HLC tests — find it: `grep -rln "score-recorded" packages/domain/src --include="*.test.ts"`), `packages/domain/src/scoring/skins.test.ts`, `packages/domain/src/scoring/strokePlay.test.ts`, `packages/domain/src/scoring/players.test.ts` (if present; else the file testing allPlayersComplete), `packages/contracts/src/round.test.ts`

**Interfaces:**
- Produces: `HoleResult` gains `| { readonly kind: "cleared" }`; `export const cellAt = (cells: Readonly<Record<string, ScoreCell>>, golferId: GolferId, hole: number): ScoreCell | undefined` in `round/state.ts`, barrel-exported. Every consumer listed above reads through it.
- Invariant: fold unchanged (a cleared result is a normal cell write, HLC-latest); a cleared cell is unscored to every reader.

- [ ] **Step 1: Write the failing tests**

```ts
// In the fold's HLC test file — commutativity of clear vs older concurrent write:
it("a clear beats an older concurrent score in every arrival order", () => {
  // Build two score-recorded events for the same (golfer, hole): strokes 5 at hlc t1,
  // cleared at hlc t2 > t1 (different devices). Fold [a, b] and [b, a]; both folds'
  // cells[cellKey(g, h)] must carry result.kind === "cleared"; and cellAt(cells, g, h)
  // must be undefined in both. Use the file's existing event-builder helpers verbatim.
});

// skins.test.ts — the chain stops at a cleared hole exactly as at a gap:
it("a cleared cell re-opens the hole: settlement stops there like a gap", () => {
  // Reuse the existing mid-round fixture (h1 Ann takes 1, h2 tie carries), then append a
  // cleared score-recorded for Ann's h2 (later hlc). Expect holesDecided: 1,
  // lines Ann 1 / Bo 0 / Cal 0, carrying 0 — h2 undecided again, nothing after settles.
});

// strokePlay.test.ts — thru drops when a hole is cleared:
it("clearing a scored hole rewinds thru and totals", () => {
  // Score 3 holes, clear hole 2 → thru 1 for that player (sequential walk stops at
  // the gap the clear re-opened)... NOTE: stroke play's walk `continue`s over absent
  // cells (thru counts scored holes, gaps allowed) — assert thru 2 and the total
  // excluding the cleared hole, matching the walk's real gap semantics.
});

// players.ts / allPlayersComplete — cleared blocks completeness (and thus finalize):
it("a cleared cell makes the card incomplete", () => { /* complete false */ });

// contracts round.test.ts — the wire arm:
it("score-recorded parses a cleared result", () => {
  // roundEventSchema parses { ...envelope, kind: "score-recorded", golferId, hole: 3,
  // result: { kind: "cleared" } }
});
```

Run: `pnpm -F @swng/domain vitest run src/round src/scoring && pnpm -F @swng/contracts vitest run` — Expected: FAIL (no `cleared`, no `cellAt`).

- [ ] **Step 2: Implement**

`holeResult.ts` — add the arm with its why:

```ts
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  | { readonly kind: "picked-up" }
  | { readonly kind: "conceded" }
  // A mis-tap undone: the cell reads as unscored everywhere (engines, finalize, AGS).
  // The fold RETAINS cleared cells under HLC-latest — deleting would let a late-arriving
  // older write resurrect the score — and cellAt (round/state.ts) hides them from readers.
  | { readonly kind: "cleared" };
```

`state.ts` — beside `cellKey`:

```ts
// The ONE way to read a scored cell: absent and cleared are both "unscored". Every
// engine/walk reads through this — a raw state.cells[...] read would silently treat a
// cleared cell as a score. Takes the bare cells record so archive.cells readers
// (golfer/record.ts) share it.
export const cellAt = (cells: Readonly<Record<string, ScoreCell>>, golferId: GolferId, hole: number): ScoreCell | undefined => {
  const cell = cells[cellKey(golferId, hole)];
  return cell && cell.result.kind !== "cleared" ? cell : undefined;
};
```

Sweep every listed reader to `cellAt(state.cells, golferId, hole.number)` (or `cellAt(archive.cells, …)` / `cellAt(cells, …)` in record.ts/allocation.ts), including the two existence checks (`!== undefined` at fourballMatch.ts:48 and archive.ts:95 become `cellAt(...) !== undefined`; archive.ts:129's `in state.cells` becomes `cellAt(state.cells, golfer, hole.number) === undefined` filter). Barrel-export `cellAt` if `cellKey` is barrel-exported (match its export path). `contracts/round.ts`: add `z.object({ kind: z.literal("cleared") })` to `holeResultSchema`.

- [ ] **Step 3: Run tests + gates**

Run: `pnpm -F @swng/domain vitest run` (golden decks must pass UNCHANGED), `pnpm -F @swng/contracts vitest run`, both packages' `typecheck`, the Global Constraints cells-grep (only fold writes + definition sites remain — web's ScorecardGrid read is Task 4's), `pnpm validate`.
NOTE: the web grid still reads raw cells until Task 4 — the grep gate at THIS task's close applies to `packages/` only; the full-tree grep runs at final review.

- [ ] **Step 4: Commit**

```bash
git add packages/domain packages/contracts
git commit -m "feat(domain,contracts): scores can be cleared — additive cleared result, one cellAt accessor, cleared reads as unscored everywhere"
```

---

### Task 2: Domain + client + fence — `courseHandicapAllocation`

**Files:**
- Modify: `packages/domain/src/scoring/allocation.ts` (new export)
- Modify: `packages/client/src/scoring.ts` (re-export)
- Modify: `eslint.config.mjs` (banlist += `courseHandicapAllocation`)
- Test: `packages/domain/src/scoring/allocation.test.ts`

**Interfaces:**
- Produces: `courseHandicapAllocation(participants: readonly Participant[], card: CourseCard): ReadonlyMap<GolferId, ReadonlyMap<number, number>>` — each player's FULL course-handicap dots (no allowance, no game), the standard card's truth. Task 3's grid consumes it via `@swng/client`.

- [ ] **Step 1: Failing test** (in allocation.test.ts, reusing its fixtures): a CH-8 player gets 8 dots on the 8 hardest SI holes of their tee; a CH-0 player gets an empty/zero map; a plus player (CH −2) gets give-backs on the 2 easiest (mirror how `dotsByHole` reports negatives — assert consistently with the existing plus-handicap tests in this file). Run — FAIL.

- [ ] **Step 2: Implement** in allocation.ts beside `gameStrokeAllocation`:

```ts
// The STANDARD CARD's dots: each player's own course handicap allocated by stroke index —
// no allowance, no game (spec 2026-07-19 §2a: the card never changes; games apply their
// allowances internally and state them in words in their panels).
export const courseHandicapAllocation = (
  participants: readonly Participant[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  new Map(participants.map((p) => [p.golferId, dotsByHole(p.courseHandicap, findTeeSet(card, p.tee))]));
```

`packages/client/src/scoring.ts`: add `courseHandicapAllocation` to the existing domain re-export list (beside `gameStrokeAllocation`). `eslint.config.mjs`: add `"courseHandicapAllocation",` to the banlist's stroke-allocation group (comment block "stroke allocation + net arithmetic").

- [ ] **Step 3: Gates** — `pnpm -F @swng/domain vitest run src/scoring/allocation.test.ts`, `pnpm -F @swng/domain typecheck`, `pnpm lint`, `pnpm validate`.

- [ ] **Step 4: Commit**

```bash
git add packages/domain packages/client eslint.config.mjs
git commit -m "feat(domain,client): courseHandicapAllocation — the standard card's own dots, fence-banned and client-re-exported"
```

---

### Task 3: Web — the standard card

**Files:**
- Modify: `apps/web/src/round/ScorecardGrid.tsx` (drop `activeGame`; CH dots; `cellAt`)
- Modify: `apps/web/src/routes/RoundPage.tsx`, `apps/web/src/round/ResultsView.tsx`, `apps/web/src/watch/WatchPage.tsx`, `apps/web/src/round/ArchivedRoundPage.tsx` (grid call sites drop the game arg; keep `activeGameId` plumbing for StandingsHeader until Task 5)
- Modify: `apps/web/src/round/SetupPanel.tsx` (roster = `name — tee — CH X` + left marker; per-game badges and "Not yet in a game" deleted; drop now-unused `gameDots`/`gamePlayers`/`totalDots`/`strokeGrant`/`gameKindLabel` imports as applicable)
- Test: `ScorecardGrid.test.tsx`, `SetupPanel.test.tsx`, plus grid-consumer tests that passed `activeGame`

**Interfaces:**
- Consumes: `courseHandicapAllocation` from `@swng/client`; `cellAt` from `@swng/domain` (accessor, fence-legal).
- Produces: `ScorecardGridProps` without any game-typed prop — `{ state, recordScore, readOnly? }`. Task 5 relies on the grid being chip-independent.

- [ ] **Step 1: Failing tests** — ScorecardGrid.test.tsx: (a) dots are CH dots (a CH-5 player shows ● on their 5 hardest SI holes and net = gross − dot under scored cells) with NO game passed; (b) a second render with different games in state produces identical cells (the card is game-agnostic — assert same innerText); (c) a cleared cell renders empty (fixture cell with `result: { kind: "cleared" }`); SetupPanel.test.tsx: roster rows read `Pat — white — CH 5` with no game badges. Run — FAIL.

- [ ] **Step 2: Implement.** Grid: delete the `activeGame` prop and its `gameDots` derivation; compute once per render `const dots = courseHandicapAllocation(state.participants, state.card);`; per-cell dot lookup `dots.get(p.golferId)?.get(hole.number) ?? 0`; cell read becomes `cellAt(state.cells, p.golferId, hole.number)` (a cleared cell thus renders as unscored with no extra branch). Call sites drop the game argument. SetupPanel: delete the `perGameDots` block and badge row.

- [ ] **Step 3: Gates** — `pnpm -F @swng/web exec vitest run src/round`, `pnpm -F @swng/web typecheck`, `pnpm validate`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): the standard card — course-handicap dots always, game-agnostic grid, cleared cells render empty"
```

---

### Task 4: Web — Clear score

**Files:**
- Modify: `apps/web/src/round/ScorePad.tsx` + `ScorePad.test.tsx`
- Modify (only if the pad doesn't already receive the current cell): `apps/web/src/routes/RoundPage.tsx` (thread the tapped cell's current result into the pad)

**Interfaces:** the pad's `onSubmit` already takes a `HoleResult` — `{ kind: "cleared" }` flows through the session/outbox/fold with zero client changes.

- [ ] **Step 1: Failing tests** — pad shows a `Clear score` button ONLY when the cell currently holds a result (read the pad's props to see whether the current cell is already passed; if not, add an optional `current?: HoleResult` prop and thread it from the grid's tapped cell at the RoundPage call site); tapping it calls `onSubmit({ kind: "cleared" })`; an unscored cell's pad has no such button. Run — FAIL.

- [ ] **Step 2: Implement** — one button in the pad's action row, styled like `picked-up`/`conceded` (secondary, not destructive-red):

```tsx
{current !== undefined && (
  <button type="button" className={`${buttonClass} min-w-20 text-base`} onClick={() => onSubmit({ kind: "cleared" })}>
    Clear score
  </button>
)}
```

- [ ] **Step 3: Gates** — `pnpm -F @swng/web exec vitest run src/round/ScorePad.test.tsx src/routes/RoundPage.test.tsx`, `pnpm -F @swng/web typecheck`, `pnpm validate`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): Clear score — a mis-tap is removable, the cell reads unscored again"
```

---

### Task 5: Web — chips become one-tap inline game panels

**Files:**
- Rename+rework: `apps/web/src/games/GameSheet.tsx` → `apps/web/src/games/GamePanel.tsx` (+ test file rename)
- Modify: `apps/web/src/round/StandingsHeader.tsx` + test (disclosure chips, inline panel, End-into-panel, delete `⋯` and `›`)
- Modify: `apps/web/src/round/dots.ts` + `dots.test.ts` (all-zero copy → `No strokes — everyone plays off 0.`)
- Modify: `packages/domain/src/scoring/present.ts` + `present.test.ts` (add `strokesNote`)
- Modify: `apps/web/src/round/AddGameForm.tsx` + test (use `strokesNote`; fourball gains its note)
- Modify: `apps/web/src/routes/RoundPage.tsx`, `ResultsView.tsx`, `WatchPage.tsx` (drop `activeGameId` state/props — StandingsHeader now takes `{ state, games, onTerminate? }` only)

**Interfaces:**
- Consumes: Task 3's game-agnostic grid (chips no longer select anything for it).
- Produces: `StandingsHeaderProps = { state, games, onTerminate? }`; `GamePanel({ game, state, onTerminate? })` rendered inline; `strokesNote(kind): string | undefined` in domain present.

- [ ] **Step 1: domain `strokesNote` (test-first, exact strings):** singles → `Match play uses the difference — only the higher handicap gets strokes.`; fourball → `Four-ball plays everyone off the lowest handicap.`; other three kinds → `undefined`. Implement in present.ts. Run domain tests.

- [ ] **Step 2: Failing web tests:**
  - StandingsHeader: one tap on a chip expands its panel inline (a `region` named `{title} standings` appears below the chip row); tapping another chip switches panels; tapping the open chip closes it; chips carry `aria-expanded`; no `dialog` role anywhere; no `⋯` button; with `onTerminate` passed, the PANEL contains the `End game…` trigger and the existing confirm flow still works; without it (results/watch), no End affordance.
  - GamePanel: header order title → treatment line → strokes line → note, and the rules blurb is GONE from the panel (assert `gameKindBlurb(kind)`'s text is NOT rendered — teaching copy is picker-only, spec §2c); stroke-play NET treatment line `Net — 95% handicap (standard)`; GROSS `Gross — raw scores, no strokes` and NO strokes line; stableford/skins strokes line present; singles note verbatim; stroke-play rows sorted by vs-par then thru (fixture: −2 thru 17 ranks ABOVE E thru 0 — the leader is no longer buried behind a thru-0 total; at equal vs-par, greater thru ranks first. NOTE corrected at execution time: this line originally read "+2 thru 17 ranks ABOVE E thru 0", which the spec's own comparator does not and should not produce — vs-par is the golf-standard board, E outranks +2); all-zero strokes fixture reads `No strokes — everyone plays off 0.`
  - AddGameForm: fourball selection shows its note; singles note now comes from the shared source (string unchanged).
  Run — FAIL.

- [ ] **Step 3: Implement.** GamePanel = GameSheet's bodies unchanged; wrapper becomes `<section role="region" aria-label={`${title} standings`} className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4">` (no fixed positioning, no ✕); header per spec §2c — DELETE the existing `gameKindBlurb` line and its import (picker-only now); treatment line logic: `game.kind === "stroke-play" ? (game.scoring === "net" ? `Net — ${allowancePhrase("stroke-play", config?.allowance)}` : "Gross — raw scores, no strokes") : config && allowancePhrase(config.kind, config.allowance)`; `strokesSummary` for every kind except gross stroke play; `strokesNote(game.kind)` line when defined; End footer:

```tsx
{onTerminate && state.status === "live" && !terminated && (
  <button type="button" onClick={onOpenConfirm} className="self-start rounded-lg bg-slate-800 px-4 py-3 text-sm font-medium text-red-400">
    End game…
  </button>
)}
```

StandingsHeader: `expandedGameId` state; chip onClick toggles; `aria-expanded={expanded}`; trailing glyph `{expanded ? "▴" : "▾"}` aria-hidden; render `<GamePanel …/>` after the chip row when expanded; keep the confirm bottom-sheet exactly as-is, triggered from the panel; delete the tablist/tab roles (chips are plain buttons), the `⋯` button, the `›`, and the sheet-on-second-tap logic. Stroke-play sort in `StrokePlayBody`: `[...game.lines].sort((a, b) => a.relativeToPar - b.relativeToPar || b.thru - a.thru)`. dots.ts all-zero string swap. Call sites drop `activeGameId`/`onSelect`.

- [ ] **Step 4: Gates** — `pnpm -F @swng/web exec vitest run src/games src/round src/routes src/watch`, `pnpm -F @swng/web typecheck`, `pnpm validate`. Grep gate: `git grep -n "plays scratch" -- apps/web/src` → empty.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src packages/domain
git commit -m "feat(web,domain): one tap opens a game panel inline — treatment in words up front, End moves into the panel, vs-par sort"
```

---

### Task 6: E2E reconciliation

**Files:** `apps/web/e2e/support.ts`, `courseEntry.spec.ts`, `fieldTest.spec.ts`, `unratedCourse.spec.ts`, `killNetwork.spec.ts`/`primaryPath.spec.ts` (only if they touch chips/grid dots — grep first)

- [ ] **Step 1: Inventory** — grep the e2e tree for: chip-tap-then-assert-grid patterns, dot/net cell assertions, `role: "tab"`, `dialog`, `standings`, `⋯`/`End `, `Not yet in a game`. List every hit in the report before editing.

- [ ] **Step 2: Reconcile:**
  - **courseEntry**: the grid-dots gate is RE-DERIVED against CH allocation — each player's own CH dots by SI, hand-verified in a comment exactly as the original singles-difference table was; the singles-difference arithmetic moves to a panel assertion (open the Match play panel with ONE tap; assert its strokes line `X N dots` equals the hand-computed difference). The rigor is kept, relocated — do NOT simply delete dot assertions.
  - **fieldTest**: chip taps no longer change the grid — cell dot/net assertions re-derived to CH dots (holding constant across chip taps); standings assertions move to chip lines (unchanged) or one-tap panels; ADD the clear-score beat inside the existing mid-round correction step: clear the mis-tapped cell (pad → `Clear score`), assert the skins chip refolds to the pre-score line on BOTH browsers, then enter the corrected score and continue the deck unchanged.
  - **unratedCourse** test 2: grid dots re-derived to CH; the "singles-match dots" claim re-anchored to the Match play panel's strokes line.
  - Update helpers: any `getByRole("tab", …)` → `getByRole("button", …)`; panel access = one chip tap + `getByRole("region", { name: /standings/ })`.

- [ ] **Step 3: Gate** — `pnpm validate` (typechecks the specs; live runs at close-out).

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e
git commit -m "test(e2e): standard-card dots re-derived, one-tap panel assertions, a live clear-score beat in the field deck"
```

---

## Close-out (controller-run, after the whole-branch review)

1. `pnpm validate` at HEAD.
2. `pnpm deploy:beta` **lambda-first — REQUIRED order** (the `cleared` wire arm) → `pnpm publish:web:beta` **immediately** (old bundles parse-fail on receiving a cleared event until refresh — accepted window, note the bundle name).
3. `pnpm e2e:beta` ×2 → full `pnpm e2e:field` (includes the new live clear-score beat).
4. **The adversarial USE pass on deployed beta.swng.golf** (spec §5.6, non-negotiable): seeded 2-player round with CH 9 vs CH 0 → add gross AND net stroke play → the chips/panels show DIFFERENT numbers live; re-seed both at CH 0 → `No strokes — everyone plays off 0.` renders in the net panel; mis-tap a score on the wrong player → `Clear score` → cell empty on both surfaces → re-enter; open all panels one-tap; confirm the card's dots never change while doing all of it; console clean.
5. Docs sweep (CLAUDE.md arc paragraph) + ledger close.

## Self-Review (performed at write time)

- **Spec coverage:** §2d→Tasks 1+4; §2a→Tasks 2+3; §2b+2c→Task 5; §5.5→Task 6; §5.6→Close-out.
- **Ordering:** Task 3 leaves `activeGameId` plumbed to StandingsHeader so every commit stays green; Task 5 removes it. Task 1's cells-grep is packages-only until Task 4 moves the grid to `cellAt`; the full grep runs at final review.
- **Type consistency:** `cellAt(cells, golferId, hole)` record-first everywhere (state.cells and archive.cells callers); `StandingsHeaderProps` final shape `{ state, games, onTerminate? }` consistent across Tasks 3/5 call-site notes; `strokesNote` name matches between Tasks 5's domain and web steps.
- **Judgment calls baked in:** End-game trigger moves into the panel (chips declutter; destructive confirm sheet kept); roster badges deleted outright; gross panels carry no strokes line; the sort ruling closed as vs-par-then-thru; `cellAt` accessor not banned; cleared button styled secondary, not red.
