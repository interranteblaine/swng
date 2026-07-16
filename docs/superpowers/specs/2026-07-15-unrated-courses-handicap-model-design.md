# Unrated courses & the three-number handicap model — for the golf you actually play

- **Date:** 2026-07-15
- **Status:** Approved in design session (owner); this document is the record.
- **Origin:** Owner field report — played a favorite 9-hole *unrated* course before work and
  the app was unusable, because course entry forces a rating and slope that don't exist, and
  any invented numbers silently poison the handicap index. Papercut 16, escalated to a design
  session by owner ruling.
- **Builds on:** the course-cards arc (immutable card lineages; the round freezes the card
  verbatim; sealed snapshots are the identity of record). This arc touches the card's tee
  *numbers*, the handicap engine, and the golfer record — never round identity or lineages.

## 1. Problem

`validateTeeSet` requires `rating` 30–90 and `slope` 55–155 on every tee. A course with no
published course rating (par-3 courses, executive tracks, many nine-holers, the muni you play
before work) can be entered only by **inventing** those numbers — and invented rating/slope
flow silently into WHS differentials and the golfer's index, which is worse than an honest
blank because nothing downstream can tell the fiction from a fact.

Two verified facts shape the fix:

1. **Rating and slope feed exactly two computations.** Posting
   (`scoreDifferential = (113/slope)(AGS − rating)`) and playing
   (`courseHandicapFor(index, tee) = index·slope/113 + (rating − par)`). Everything else —
   games, dots, adjusted gross score, the scorecard, the per-round distribution — needs only
   par, stroke index, and the golfer's **course handicap**, which swng has *always* taken as a
   number the golfer types at join. The system has never asserted a course handicap; it has
   only ever offered a blank field.
2. **The graceful-degradation machinery already exists.** `GolferRoundLine.ags/differential`
   are independently optional (the "incomplete" path), and the read-time index computation
   already filters on `differential !== undefined`. An unrated round that produces an AGS but
   no differential fits the existing shapes.

## 2. The core idea: three honest numbers, the golfer decides

This level of golf is genuinely hard to reason about, and swng's job is to *help the golfer
decide*, not to assert a number over them. Generalizing the course-cards trust model
("transcription, not authority") to the handicap: **swng surfaces data points and the golfer
declares.** Three kinds of numbers, never blended, each labeled for what it is:

- **WHS-standard computations** — the `computed` index (Rule 5.2a over *rated* differentials
  only) and `courseHandicapFor` on rated tees. Shown whenever the data supports them, always
  labeled WHS. The standard, not the authority.
- **Soft data points (metrics)** — descriptive numbers computed over the golfer's own rounds
  (a *read projection*, §6): the **suggested index**, scoring-versus-par, distribution, trend.
  They work across rated *and* unrated golf because they need only par + stroke index + the
  golfer's own course handicap. Shown as labeled data points beside every decision the golfer
  makes — above all beside the declared-index field; a metric with no data shows `—`.
- **The golfer's declaration** — the index they choose to play off, and the course handicap
  they accept or overtype per round. One-tap acceptance of a suggestion is always offered; so
  is ignoring it.

This delivers the owner's whole ask: **rated and unrated golfers on one card, head-to-head on
stats** (descriptive surfaces include unrated rounds; only differential/WHS-index surfaces
exclude them), with declared numbers and WHS standards both visible, and a suggestion engine
that makes declaring tractable.

## 3. Unrated tees

`rating` and `slope` become **optional, as a pair** on `TeeSet` (a rating without a slope, or
vice versa, is meaningless — present together or absent together, validated as such):

```ts
export interface TeeSet {
  readonly teeId?: TeeId;         // course-cards spec §3
  readonly name: string;
  readonly rating?: number;        // present ⇔ slope present; a tee is "rated" iff both are set
  readonly slope?: number;
  readonly holes: readonly Hole[];
}
export const isRated = (tee: TeeSet): boolean => tee.rating !== undefined && tee.slope !== undefined;
```

- **Validation** (`validateTeeSet`, now `validateCard`'s per-tee rule): rating/slope bounds are
  enforced **iff present**; a new `rating-slope-paired` error rejects exactly one of the two
  set. Par/yardage/stroke-index/hole-count rules are unchanged and always enforced — an
  unrated tee is still a fully valid scorecard in every other respect.
- **Entry** (AddCoursePage / the editor): rating and slope are optional fields — "No course
  rating on the card? Leave these blank." Blank ⇒ unrated tee.
- **Display** everywhere a tee's numbers render (course page, `CourseSummaryCard`, the create
  and join tee pickers, peek): a rated tee shows `white — rating 71.1, slope 129`; an unrated
  tee shows `white — unrated`.
- Purely additive to the value type: every existing card carries both numbers and is
  unaffected; fixtures and the frozen decks compile untouched.

## 4. Playing an unrated round: AGS yes, differential no

`handicappingFor` gains a third result — the round is fully scored and its adjusted gross
score is computable (AGS needs only par, stroke index, and the golfer's course handicap), but
there is no differential to post:

```ts
handicappingFor(participant, card, cells):
  | { golferId; kind: "complete";   ags; differential }   // rated, every hole decided
  | { golferId; kind: "unrated";    ags }                   // NEW: unrated tee, every hole decided
  | { golferId; kind: "incomplete" }                        // holes undecided (any tee)
```

- The `unrated` arm fires when `!isRated(teeSet)` **and** AGS computes (all holes decided). It
  is distinct from `incomplete`: an unrated round is complete, it simply cannot be posted.
- This is the **true-to-WHS rule** ("you cannot post a score from an unrated course") falling
  out of existing structure rather than being bolted on: the round carries an AGS, no
  differential, and the read-time index computation's existing `differential !== undefined`
  filter **structurally** excludes it from the WHS `computed` index. No new guard.
- `settleRound`, the archive's `handicapping[]` array, and `archiveGolferLine` carry the third
  kind through: a `complete` line gets `ags + differential`; an `unrated` line gets `ags` only;
  an `incomplete` line gets neither.

## 5. The golfer record carries what the soft data points need

`GolferRoundLine` gains two creation-time facts — recorded now because sealing makes them
unbackfillable (the same one-way-door rule as course-cards' `courseId`), and because the
course-cards scrap left **zero** stored round lines, so every line from here forward carries
them with no legacy tier:

```ts
export interface GolferRoundLine {
  readonly roundId; readonly courseName; readonly courseId?;
  readonly tee; readonly holes;
  readonly par: number;             // NEW — sum of the frozen tee's hole pars
  readonly courseHandicap: number;  // NEW — participant.courseHandicap, frozen at join
  readonly ags?; readonly differential?;
  readonly distribution;
}
```

Both are trivially available in `archiveGolferLine` (`par` from the frozen card's tee,
`courseHandicap` from the participant). `ags` is now present on unrated lines too (§4).
Everything a soft data point needs — AGS, par, course handicap, per-hole distribution — is on
the line, computable at read time, across rated and unrated rounds uniformly.

## 6. The metrics projection — one read over your rounds

The suggested index is not a bespoke field; it is the second member of a family. swng already
uses two projection kinds, and this arc names them:

- The **write projection** the projector already materializes: each finalized round's snapshot
  fact mapped to a `GolferRoundLine` and written to the projections store (§5).
- The **read projection**: a pure computation folded over those lines at read time,
  materialized nowhere — the shape the WHS index has had since pre-prod hardening D4a. This
  arc makes it first-class and extensible:

```
golferMetrics(lines): GolferMetrics             // domain, pure, read-time — the read projection
GolferMetrics = { whsIndex?, suggestedIndex? }  // one member per derived metric; grows to N
```

v1 has two members; both are `{ value, differentialsUsed }`:

- **`whsIndex`** — Rule 5.2a over *rated* differentials only (the existing `differential !==
  undefined` filter). The WHS standard, unchanged in math — this arc only *names* the
  read-time index computation that today sits inline in `getMyRecord` and moves it into
  `golferMetrics`.
- **`suggestedIndex`** — the declaration aid ("based on your rounds, a reasonable index is
  ~8.2"). The *exact* pinned WHS machinery applied to **neutral-course pseudo-differentials**
  so it works identically for rated and unrated rounds:

```
pseudo-differential(line) = line.ags − line.par     // = scoreDifferential at slope 113, rating = par
suggestedIndex(lines)     = computeIndexDetail( combineNineHoleDifferentials(
                              lines with an ags, mapped to { differential: ags − par, holes } ) )
```
  - Reuses `combineNineHoleDifferentials` (2020 nine-hole pairing) and `computeIndexDetail`
    (Rule 5.2a best-of-window) verbatim — the small-sample table is never re-derived; same
    best-8-of-20 shape as the WHS index, just on difficulty-neutral numbers.
  - **Every round with an AGS contributes**, rated or unrated. This is precisely why it "works
    for all" (owner): AGS always exists once holes are decided.
  - **Honest limitation, stated in the UI:** ignoring rating/slope, it over- or under-states
    difficulty on hard/easy rated courses. Where rated data exists, `whsIndex` is more
    accurate — and both are shown. Labeled *estimated / based on your rounds*.

- **Why a projection, not two special-case fields:** the numbers swng surfaces — the two
  indexes here, and scoring-versus-par / distribution / trend next — are all the same kind of
  thing: a read over the golfer's round lines. `golferMetrics` is their one home; adding a
  metric is adding a member, not carving a new pathway. The descriptive stats (§9) become
  members of `GolferMetrics` when a surface needs them (§12) — never built speculatively.
- **Read-time only, never stored** — same discipline as the WHS index (D4a). `getMyRecord`
  returns `metrics: GolferMetrics`; the application stamps `computedAtMs` onto `whsIndex` when
  it builds the response (the domain function stays a pure fold, no clock).

## 7. The three-number model in the record: declare wins, official collapses

The golfer owns the number they play off. Two changes to `effectiveIndex`:

**(a) Declared overrides computed.** Declaring is an explicit act; the system's computation is
advice. Precedence becomes **`declared ?? computed`** (was `official > computed > declared`,
where a computed index silenced the golfer's declaration — the opposite of golfer-owned).

**(b) `official` collapses into `declared`.** Under "the golfer declares; the system suggests,"
the M7 distinction between `official` (authoritative) and `declared` (a guess) no longer holds
— a golfer with a real GHIN index simply *declares* it. Two numbers tell the whole story:
**what you play off** (`declared`, yours) and **what WHS computes from your swng rounds**
(`computed`, ours, read-time). `HandicapProfile` becomes `{ declared? }`; the stored `computed`
field (never populated — it was always read-time) and `official` are removed.

```ts
export interface HandicapProfile { readonly declared?: number }
// effectiveIndex composes the stored declared with the read-time computed — `computed` is
// sourced at the call site from `metrics.whsIndex.value` (§6), as the web already composes it:
export const effectiveIndex = (input: { declared?: number; computed?: number }):
  | { value: number; source: "declared" | "computed" } | undefined =>
  input.declared !== undefined ? { value: input.declared, source: "declared" }
  : input.computed !== undefined ? { value: input.computed, source: "computed" }
  : undefined;
```

- **Data points beside the declaration — never a nudge.** ProfilePage renders the
  declared-index field alongside the metrics (§6) as plain labeled values — `Suggested · 8.2`,
  `WHS index (computed) · 15.2` — each with a one-tap **Use this** that copies the value into
  the declared field. A metric with no data renders `—` (nothing to suggest). No prose
  sentence, no divergence threshold, no auto-write: just the numbers, and the golfer decides.
- **Old stored golfers fold on read:** a golfer row carrying a legacy `official` (and no
  `declared`) deserializes as `declared` — the value is preserved under the new semantics,
  contract-tested, no migration script. A stored `computed` is dropped (it was never
  authoritative). Beta golfers are largely test data; this fold loses nothing real.
- Wire: `GolferView` and `updateMeRequestSchema` drop `official`; `declared` stays. `PUT /me`
  with `declared` is how any index — estimate or real GHIN — is set.

## 8. Suggested course handicap at join and create

The course-handicap field — hand-typed since M3 — gains an **editable pre-fill** whenever the
golfer has an effective index (§7). One affordance, two formulas (owner: "it actually works
for all rated and not rated"):

- **Rated tee:** `courseHandicapFor(effectiveIndex, tee)` (Rule 6.1a — the function that has
  existed since M7 with no caller finally earns its keep). Labeled *suggested (WHS)*.
- **Unrated tee:** slope 113 and rating ≈ par collapse the formula to **`round(effectiveIndex)`**.
  Labeled *estimated — unrated course*.
- **Typed stays king:** the field is always editable; the suggestion is a starting point, never
  a lock. A golfer with no effective index sees the current blank field.

Data needed client-side: the tee's rating/slope/par and the golfer's effective index.
`PeekRoundResponse.teeSets` gains `par` (always known from the frozen card) and makes
`rating`/`slope` optional, so JoinRoundPage can compute the suggestion; CreateRoundPage already
holds the full card. Effective index is composed from `declared` (GET /me) + `computed`
(GET /me/record), as the web already composes it on ProfilePage.

## 9. Head-to-head across rated and unrated — the display rule

The owner's "go head to head on stats" across mixed rated/unrated play is a **display
discipline**, not a new store: once the line carries `ags`, `par`, and `courseHandicap`,

- **Descriptive stats include every round** — scoring-versus-par (`total − par`),
  net-versus-par (`total − courseHandicap − par`), the per-hole distribution, trend, and the
  suggested index. Two golfers, one on a rated card and one unrated, compare directly.
- **Differential/WHS-index surfaces exclude unrated rounds** — the `computed` index, any
  "handicap differential" column. These are labeled WHS and are honest about what they can
  include.

This spec surfaces the metrics projection (§6) and the declaration data points (§7) and
specifies the rule; a broad cross-player stats/leaderboard page is **out of scope** here (§12)
— the point is that the *data* now supports it uniformly.

## 10. Rollout

Additive and mostly forward-only; **no migration scripts**.

- Domain, contracts, application, web land as an SDD arc, `pnpm validate` green per commit.
- The course-cards scrap already emptied rounds/snapshots/projections, so **every stored round
  line is post-arc** — `par`/`courseHandicap` are present on all of them, no legacy line tier.
  (This arc depends on that completed scrap; it does not re-run it.)
- Golfers were **not** wiped: the `official`→`declared` fold (§7) is tolerate-on-read,
  contract-tested, no script.
- One beta deploy (lambda + web); `publishWeb.mjs` ships the web (a separate step — the
  course-cards stale-bundle lesson).
- Gates: `pnpm validate` + `pnpm test:contract`; a new `unratedCourse.spec.ts` field test (enter
  an unrated 9-hole course, play it, assert games/dots work, the round shows AGS-not-posted,
  the WHS index is untouched, and the suggested index reflects the round); `pnpm e2e:beta` ×2;
  the full field suite (the frozen crewSeason/fieldTest decks are all rated — numbers
  unchanged); a controller browser walk entering and playing a real unrated course.

## 11. Invariants (pinned for review)

1. **Rating and slope are present together or absent together** — never one alone
   (`rating-slope-paired`); a tee is rated iff both are set (`isRated`).
2. **An unrated round produces an AGS and no differential** — it is `complete`-shaped for
   scoring and games, `unrated`-shaped for posting; it can never reach the WHS `computed`
   index.
3. **The WHS index (`metrics.whsIndex`) is rated-differentials-only** — structurally, via the
   existing `differential !== undefined` filter; unrated rounds cannot move it.
4. **Derived indexes are a read projection (`golferMetrics`), never materialized** — `getMyRecord`
   folds `metrics` over the round lines at read time and stores nothing (D4a discipline). The
   suggested index reuses the pinned WHS engine on neutral pseudo-differentials (`ags − par`)
   and includes every round with an AGS.
5. **The golfer's `declared` index overrides `computed`** — `effectiveIndex = declared ??
   computed` (`computed` = `metrics.whsIndex.value`); the system never overwrites a
   declaration. Metrics are shown as data points (`—` when absent), never asserted or nudged.
6. **`official` is gone; a legacy stored `official` folds to `declared` on read** — no
   migration, value preserved.
7. **Every scoring path is unchanged on rated tees** — games, dots, AGS, differentials, the
   frozen decks: byte-identical. Unrated is strictly additive.
8. **The suggested course handicap is editable everywhere** — a pre-fill, never a lock; a
   golfer with no effective index sees today's blank field.
9. **`par` and `courseHandicap` are recorded on every new round line** — creation-time facts,
   present because the scrap left no legacy line tier.

## 12. Out of scope (recorded)

- **SI-less cards.** Stroke index is load-bearing for AGS itself (net-double-bogey caps need
  per-hole dots), not just games — a course with no stroke index is a genuinely different
  feature (a gross-only mode), not a blank-field variant. Recorded, not designed here.
  *Trigger:* a real course with no SI on the card.
- **A parallel "estimated index" that feeds `effectiveIndex`.** Explicitly rejected: the
  suggested index *informs the golfer's declaration*; it never becomes an index the system
  plays off. Manufacturing a second authoritative index is the failure mode the verify badge
  taught us to avoid.
- **A broad cross-player stats / leaderboard surface.** The data now supports rated-vs-unrated
  head-to-head (§9); the surface itself is a later arc. The descriptive metrics it needs
  (scoring-versus-par, distribution, trend) are further members of `GolferMetrics` (§6), added
  when that surface exists — not built ahead of it.
- **Materializing metrics into the projection store.** `golferMetrics` is a read projection;
  the handicap metrics are window-based reads (best-8-of-20), cheap, and rebuild-free by
  construction. A future per-round, expensive-to-compute metric could be materialized as a
  write projection instead — that is a deliberate later call, not this arc's.
- **PCC, the 2024 nine-hole expected-differential ingestion.** Unchanged; unrated nine-hole
  rounds simply never enter `combineNineHoleDifferentials` (they carry no differential).
- **Prod-stack work.** Separate arc.
