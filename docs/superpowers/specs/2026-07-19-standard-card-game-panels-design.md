# The Standard Card & Game Panels — the card never changes, games open in one tap

**Date:** 2026-07-19
**Status:** Approved (owner: "write the spec and plan. make judgements on anything open.")
**Owner problem statement (verbatim themes):** gross and net stroke play looked the same when
tested; it's not clear from what we afford users how handicap is being used; you cannot clear
a score for someone; the card changing for different games is worse UX than a standard card;
the game sheet is clunky, double-tap, and hidden.

## 1. Diagnosis

Four findings, two of them structural:

1. **The per-game card is the root mistake (M5-era, this spec reverses it).** Chip selection
   swaps the grid's dots and nets to the "active" game. A card that changes under your thumb
   costs more comprehension than game-exact dots earn — and it consumed the chip's first tap,
   which is why viewing a game needed a hidden second gesture.
2. **The sheet interaction was wrong.** A bottom modal behind a double tap on the active chip
   is undiscoverable and clunky. (The sheet's *content* — full standings, trails, the story —
   was right and survives.)
3. **Nothing states the handicap treatment in force.** The engines are correct (gross
   allocates zero dots; net = gross − dots), but with course handicap 0 the two are
   numerically identical everywhere and the UI never says so. A player cannot see how — or
   whether — handicap is being used in any game.
4. **A score cannot be cleared.** `HoleResult` is `strokes | picked-up | conceded` down to
   the wire; a mis-tap can only be overwritten, never removed.

## 2. The design

### 2a. One standard card, always

The grid renders the same thing regardless of games: **gross scores, and each player's own
course-handicap dots** — `dotsByHole(courseHandicap, teeSet)`, no allowance, no game context
— with net-vs-those-dots small under the gross where dots apply (the existing Cell, including
the plus-player hollow `○` give-back). This is the paper card golf already trained everyone
on: your dots are printed once and never move. Games apply their own allowances *internally*
(engines unchanged) and state them *in words* in their panels (§2c). Chip taps no longer
touch the grid.

New domain compute: `courseHandicapAllocation(participants, card) →
ReadonlyMap<GolferId, ReadonlyMap<number, number>>` (full CH dots per player), barrel-exported,
**added to the compute-fence banlist**, re-exported through `@swng/client` (the sanctioned
on-device path) for the grid.

Consequence accepted and documented: a net game's panel totals use the game's *playing*
handicap (allowance-adjusted), which can differ by a stroke from the card's CH dots — that is
real golf (playing handicap ≠ course handicap), and the panel states its allowance.

The SetupPanel roster simplifies to `name — tee — CH X` (+ the departed marker). The
per-game dot badges and "Not yet in a game" are deleted — game membership and game strokes
now live in the game's own panel.

### 2b. One tap opens a game panel, inline

Chips remain the glance layer (title + one-line standing, unchanged). **A single tap on a
chip expands that game's panel inline directly below the chip row**; tapping another chip
switches; tapping the open chip closes. No modal, no second gesture, no `›`. Chips become
disclosure buttons (`aria-expanded`, a trailing `▾`/`▴` glyph aria-hidden); the tablist/tab
semantics die with the active-game concept. Default state: all collapsed — the card leads.

`GameSheet` becomes **`GamePanel`** (`apps/web/src/games/GamePanel.tsx`): the same per-kind
bodies (full-table standings, match trail grid, skins story list), rendered as an inline
`role="region"` (aria-label `{title} standings`), no ✕. The **"End game…" trigger moves into
the panel footer** (the existing confirm sheet is kept for the destructive act; the per-chip
`⋯` button is deleted) — omitted exactly as before when no `onTerminate` is passed
(results/watch/archived reuse unchanged). The stroke-play panel sorts by
**vs-par ascending, then thru descending** (`a.relativeToPar - b.relativeToPar || b.thru -
a.thru`) — closing the queued sort ruling; stableford stays points-descending.

Because the panel lives inside `StandingsHeader`, live, results, archived, and watch views
all change through the one integration point. RoundPage/ResultsView/WatchPage/
ArchivedRoundPage lose the `activeGameId` state and props entirely.

### 2c. Every game states its handicap treatment, in words, up front

Panel header, in order — deliberately WITHOUT the rules blurb (owner slop-check, 2026-07-19:
teaching copy belongs where you *choose* a game — the picker — not repeated on every
mid-round standings check; the panel leads with only what changes decisions):
1. Title (chip title verbatim) + "Ended" badge when terminated.
2. **The treatment line:** stroke-play net → `Net — {allowancePhrase}` (e.g. `Net — 95%
   handicap (standard)`); stroke-play gross → `Gross — raw scores, no strokes`; all other
   kinds → `allowancePhrase(kind, allowance)` as today.
3. **The strokes line for every kind except gross stroke play** (which has none by
   definition): the shared `strokesSummary` — with its all-zero copy changed to
   **`No strokes — everyone plays off 0.`** (the exact sentence that answers the CH-0
   gross-vs-net confusion; one copy, shared with the add-game preview).
4. For match kinds, a per-kind note from a new `strokesNote(kind)` in
   `scoring/present.ts`: singles → `Match play uses the difference — only the higher
   handicap gets strokes.` (moved from AddGameForm's literal — one copy, both sites);
   fourball → `Four-ball plays everyone off the lowest handicap.` (AddGameForm gains it
   too); other kinds → `undefined`.

### 2d. Scores can be cleared

- **Domain:** `HoleResult` gains `{ kind: "cleared" }` (`round/holeResult.ts`). The fold
  **retains** cleared cells in `state.cells` under normal HLC-latest resolution — deleting
  them would let a late-arriving older write resurrect the score, breaking commutativity.
  Readers hide them: one accessor
  `cellAt(cells: Readonly<Record<string, ScoreCell>>, golferId, hole): ScoreCell | undefined`
  (returns `undefined` for absent OR cleared) replaces **every** raw cell read — the eleven
  sites: strokePlay, stableford, skins, singlesMatch (×2), fourballMatch (×2),
  `allPlayersComplete` (players.ts), the departure any-cell check (archive.ts:95), the
  unresolved-holes walk (archive.ts:129), `handicappingFor` (allocation.ts), and
  `archiveGolferLine`'s AGS walk (golfer/record.ts). A cleared hole is unscored everywhere:
  engines re-open their walks, finalize blocks on it, AGS reads incomplete. `cellAt` is an
  accessor (cellKey's class) — importable directly by the web, NOT added to the banlist.
- **Wire:** `holeResultSchema` gains the `cleared` arm — purely additive. Old snapshots never
  contain it; new snapshots may (a finalizable round can carry a cleared cell only for a
  golfer whose games all terminated or who departed — renderers read it as unscored via
  `cellAt`). **Deploy is lambda-first, web published immediately after:** an old bundle
  *receiving* a cleared event via pull/WS fails its parse until refresh — a stale-bundle
  window of the accepted class (beta).
- **UI:** the ScorePad shows a **`Clear score`** button only when the cell currently holds a
  result; it submits `{ kind: "cleared" }` through the same session path (offline outbox,
  optimistic fold — free, it's just an event). The grid renders a cleared cell as empty
  (routing its cell read through `cellAt`).

## 3. What this deliberately keeps

The chips' glance lines and `describeGame` (unchanged); the panel bodies from the previous
arc (trails, story list, decoder ring, dormie gloss); `strokesSummary`/`allowancePhrase`/
`gameKindLabel` (one-copy formatters, now front and center); `gameKindBlurb` stays
picker-only (the panel drops it — §2c); the add-game picker and strokes preview; two-tap
score entry.

## 4. Out of scope

New games; any change to scoring engines' math; the crew/season surfaces; junk/tags; presses.

## 5. Invariants and gates

1. **Scoring math is untouched.** No engine computes differently; golden decks green
   unchanged. The settled wire changes ONLY by the additive `cleared` arm.
2. **Cleared-cell semantics are commutative:** a clear beats an older concurrent write in
   every arrival order (HLC-pinned test); a cleared cell reads as unscored in every engine,
   in finalize-readiness, in settle, and in the AGS walk (one accessor, grep-gated: no raw
   `\.cells\[` read AND no `in cells`/`in state.cells` membership check survives outside the
   fold, `cellKey`/`cellAt` themselves, and tests — the membership form was hardened into this
   gate at final review, after a raw `cellKey(...) in cells` check in `ScorecardGrid`'s
   `currentHoleNumber` slipped past the original `\.cells\[`-only pattern and stranded the
   current-hole highlight past a hole whose mis-tapped cell had been cleared).
3. **One copy of treatment copy:** `strokesSummary` (with the new off-0 line),
   `allowancePhrase`, `strokesNote` — shared by panels and the add-game form; no literal
   duplicates (review-gate grep).
4. **The card is stable by construction:** `ScorecardGrid` has no game-typed prop after this
   arc; nothing under `apps/web/src` passes a game into the grid (typecheck enforces — the
   prop is gone).
5. **e2e reconciliation is a real task:** `courseEntry`'s hand-verified dots table is
   re-derived against CH allocation (the singles-difference arithmetic moves to panel
   assertions — the rigor is kept, relocated); `fieldTest` gains a clear-score beat inside
   its existing mid-round-correction step (clear → chip reverts → re-enter → refold);
   `unratedCourse`'s grid-dot assertions re-derived; helpers open panels with one tap.
6. **Close-out is controller-run with an adversarial USE pass** (the lesson this arc is
   partly for): on deployed beta, with real handicaps (e.g. CH 9 vs CH 0) — add a gross AND
   a net stroke play side by side and watch the numbers differ live; set both players to CH
   0 and see `No strokes — everyone plays off 0.`; mis-tap a score on the wrong player and
   CLEAR it live, then re-enter; open every game's panel with one tap; confirm the card
   never changes as panels open. Order: `deploy:beta` lambda-first → `publish:web:beta`
   immediately → `e2e:beta` ×2 → full `e2e:field` → the walk → docs sweep. No data wipe.
