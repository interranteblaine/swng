# The index you pick sticks — one tap commits; a plus handicap is golf-truth the domain owns

- **Date:** 2026-07-17
- **Status:** Owner-approved design session (this document is the record). It **supersedes §6**
  ("UX rules") of `2026-07-16-handicap-index-source-model-design.md` — the two-step "Use this
  stages, Save commits" interaction. Everything else in that spec (the `IndexSource` model §3, the
  live `resolveIndex` §4, "never store a computed number" §2, the sealed round §7) **stays**.
- **Why this exists:** two defects the owner caught on the live surface.
  1. **The index picker's interaction is backwards.** "Use this" only mutates browser state — it
     persists nothing — so it looks committed but **reverts to the last saved value on reload**;
     the only thing that saves is a separate Save button, and that Save fires **three network
     requests** for one action. The stored data is correct (the wire round-trips the right
     `indexSource`), so nothing is corrupted — but a control that stages silently and reverts does
     not inspire trust, the whole bar of the index-source arc.
  2. **A plus handicap has no home in the model.** An index below 0 (better than scratch) renders
     as a bare `-1.2` instead of golf's `+1.2`; the strokes it produces are "given," not received;
     and on the scorecard a plus player's given strokes silently **don't draw at all**. Three
     surfaces, three improvisations, one missing concept — because the `+`/give-vs-receive
     *convention* was treated as view styling instead of the golf **rule** it is.

## 1. The one-sentence model

**Picking a source IS the save (one tap, one request, no revert), and a plus handicap is golf-truth
the DOMAIN owns — the `+` convention and give-vs-receive live in one tested place and every surface,
the scorecard included, renders through it thinly, so no view decides a sign's meaning and no
surface can silently drop a true thing.**

## 2. Part 1 — one tap commits (kills the revert and the three-request save)

### The model
The "Your index" section stops carrying a staged, unsaved selection. The active source is
**`auth.golfer.indexSource`** — the persisted truth — and each choice writes it:

- **"Use this" on the swng row** → commits `{kind:"swng"}`.
- **"Use this" on the WHS row** → commits `{kind:"whs"}`.
- **The override** ("your own number"): type a number, then **"Use this number"** → commits
  `{kind:"declared", value}`. A text field needs its own explicit commit tap (consistent with the
  rows — every "Use this" is a commit).

There is **no staged `pendingSource`, no separate Save for the index, and no revert** — the moment
you tap, it is saved and the active number + "in use" marker move to reflect it.

### One request per commit
`commit(source)` is:
1. `await withAuth((token) => updateMe(token, { indexSource: source }))` — one **PUT /me**.
   `updateMe` already returns the updated `GolferView` (`GolferResponse`).
2. `auth.applyGolfer(response.golfer)` — feed that view straight into auth state. **No GET /me
   refetch.** The header chrome and this page both read `auth.golfer`; this updates it in place.

That is the fix for the three-request save. `applyGolfer(view: GolferView): void` is a new
`AuthContextValue` method (a thin `setGolfer(view)` wrapper — the internal setter already exists;
only `refetch` was exposed). `refetch` stays for its other callers (the join funnel's name prompt).

### Error handling (no optimism to roll back)
`auth.golfer` is updated **only from a successful PUT response**, so a failed commit leaves the
prior source active — no rollback logic. During a commit the source buttons show a brief disabled
state; on failure an inline "Couldn't save your index — try again" sits by the section.

### Name and home course are unchanged
They keep their own **Save** button (a PUT /me with `{ name, homeCourseId }`, `indexSource`
dropped — it commits on its own now). That Save also switches from `refetch` to
`applyGolfer(response.golfer)`, so the whole page makes exactly one request per user action.
Instant-commit for the source *selections* alongside a Save for the *text* fields is a coherent,
familiar split (toggles commit, text saves).

### The override draft
The override input is a local text buffer (`declaredDraft`), initialized once from the current
source (the declared value if the golfer is on a declared source, else empty). Editing it stages
nothing; "Use this number" commits it. Tapping a computed "Use this" clears the draft. The buffer is
text-entry state, not a staged source — the distinction the old model blurred.

## 3. Part 2 — a plus handicap is golf-truth, owned by the domain, rendered thin

The `+` convention and give-vs-receive are golf **rules**, not view styling — so they live once in
`@swng/domain`, and every surface renders through them. **No view file decides what a sign means.**
The stored/wire number stays the true signed value (`-1.2` is the standard encoding of a plus
handicap; the WHS/USGA store better-than-scratch as negative too) — the API is not changed; only the
place the *convention* lives is corrected, out of the UI and into the domain.

Two pure, tested domain functions — new `packages/domain/src/handicap/present.ts`, exported from the
barrel:

```ts
// A Handicap Index below 0 is a "plus" handicap (better than scratch): golf writes it "+2.4".
// 0.0 is scratch. This is the ONE place the + convention lives — never a `value < 0` in a view.
export const formatHandicapIndex = (value: number): string =>
  value < 0 ? `+${(-value).toFixed(1)}` : value.toFixed(1);

// A signed stroke count (a course handicap, or a hole's dots) is strokes RECEIVED when positive,
// GIVEN when negative (a plus handicap gives strokes back), none at 0. The ONE place a sign becomes
// give/receive — every surface (the strokes note, the scorecard) reads this, never re-decides it.
export type StrokeGrant = { readonly kind: "receives" | "gives" | "none"; readonly count: number };
export const strokeGrant = (signed: number): StrokeGrant =>
  signed > 0
    ? { kind: "receives", count: signed }
    : signed < 0
      ? { kind: "gives", count: -signed }
      : { kind: "none", count: 0 };
```

Every surface renders through them, thin:
- **ProfilePage** — the active index number and each source row's value: `formatHandicapIndex`.
- **Create/Join** — the index named in the derivation note: `formatHandicapIndex`; the strokes lead:
  from `strokeGrant(courseHandicap)` — "You give 2 — …" when it gives, the plain number otherwise.
  The editable strokes field keeps the signed numeric value the round freezes and the engine
  consumes.
- **Scorecard (RoundPage `ScorecardGrid` Cell)** — the per-hole dots render through `strokeGrant`:
  received dots draw filled `●`, GIVEN dots draw hollow `○` (a plus player's given strokes, finally
  on the screen), none draws nothing; the net shows whenever dots ≠ 0 (`gross − dots`, already
  correct for both signs — a given stroke makes net = gross + 1). **This is the hole designed out:**
  give-back renders through the same source as everything else, so "visible here, invisible there"
  is not representable.

**Raw differentials stay signed** — a differential is a per-round number, not a handicap, so a
negative differential in the history line is left as-is (no `formatHandicapIndex`).

The **engine is already correct** and is not touched: `allocateStrokes` has a give-back branch,
`courseHandicapFor(-2.0) → -2`, both tested. Part 2 changes only where the *presentation convention*
lives and adds the scorecard's give-back render — never the math.

## 4. What stays (verified correct, do not touch)

- **The `IndexSource` model and `resolveIndex`** (index-source spec §2–§4). The active number is
  still `resolveIndex(golfer.indexSource, metrics)`; the only change is that the source it resolves
  is the committed one, not a pending one.
- **Persistence and the wire** — verified correct on the live stack. No storage, contract, or
  application/lambda change: `updateMe` already returns the golfer and already accepts an
  `indexSource`-only body (the request schema's keys are all optional). The new domain functions are
  consumed **only by the web**, so there is no backend change to deploy.
- **The handicap engine** — correct and tested; Part 2 is presentation only.
- **The sealed round** — untouched.

## 5. System boundaries (blast radius)

- **`@swng/domain`:** new `handicap/present.ts` (`formatHandicapIndex`, `strokeGrant`, `StrokeGrant`)
  + barrel export + tests. Pure functions, no dependency on anything but numbers.
- **`@swng/web`:**
  - `auth/useAuth.ts`: add `applyGolfer(view: GolferView)` (a `setGolfer` wrapper).
  - `routes/ProfilePage.tsx`: instant `commit(source)` per row + the override's "Use this number";
    drop `indexSource` from the name/home Save; both use `applyGolfer`, not `refetch`; the active
    number and rows render through `formatHandicapIndex`.
  - `routes/CreateRoundPage.tsx` / `routes/JoinRoundPage.tsx`: `formatHandicapIndex` in the note +
    the `strokeGrant`-driven give-strokes lead.
  - `round/ScorecardGrid.tsx`: the Cell renders dots through `strokeGrant` (● received / ○ given /
    none) and shows net whenever dots ≠ 0.
- **No wire/schema/storage change → no `deploy:beta`, no migration, no deploy-order sensitivity.**
  The close-out is `publishWeb` (which rebuilds domain + web topologically) + gates + a **real
  walk** — a golfer driven to an actual computed index, a plus one included.

## 6. Testing intent

- **Domain (`present.test.ts`):** `formatHandicapIndex` — `12.4→"12.4"`, `0→"0.0"`, `-1.2→"+1.2"`,
  `-0.4→"+0.4"`. `strokeGrant` — `2→{receives,2}`, `-2→{gives,2}`, `0→{none,0}`.
- **ProfilePage (unit):** tapping "Use this" on WHS issues ONE PUT /me with `{indexSource:{kind:
  "whs"}}`, updates the active number from the response with **no second request**, and a
  reload-equivalent re-render **keeps WHS** (the anti-revert test — the old anti-drift test is
  rewritten to this). Typing an override + "Use this number" commits `{kind:"declared", value}`. A
  rejected PUT leaves the prior source active + shows the inline error. The name/home Save posts
  `{name, homeCourseId}` with no `indexSource`. A plus resolved value renders `+1.2`.
- **Create/Join (unit):** a plus-handicap golfer's note shows `+1.2` and, when the course handicap
  is negative, the "You give N" lead; a normal golfer's note is unchanged (`13 — from your index
  (12.4) on this course`).
- **Scorecard (unit):** a cell with negative dots renders hollow `○` (count = |dots|) and net =
  gross + |dots|; a positive-dots cell is unchanged (`●`); zero draws nothing.
- **The no-improvisation invariant:** a grep gate — no index/stroke sign logic (`< 0`, a literal
  `"+"` prefix on an index, a bare `.toFixed(1)` on an index/course-handicap) survives in any view
  file; every such site goes through `formatHandicapIndex`/`strokeGrant`. (The history-line
  differential is the one carved-out signed number.)
- **Live walk (close-out — the lesson from the shipped miss):** drive a golfer to a REAL computed
  index, a negative one included; confirm "Use this" persists across a reload (no revert), each
  commit is a single request in the network panel, `+1.2` renders, and a plus player's scorecard
  shows `○` give-back.

## 7. Out of scope / deferred

- **Papercut 17 — fold trend + distribution into `golferMetrics`** (move the ad-hoc
  `DistributionBars` reduce and `IndexTrend` point-extraction out of the web into the read
  projection). Owner-sequenced AFTER this correction; its own spec + plan.
- **Any change to the index MODEL, the wire, or the handicap engine** — this arc is presentation +
  interaction only.
- **Dated / index-over-time trend** — the trend stays the existing differential series (a #17
  concern at most).
