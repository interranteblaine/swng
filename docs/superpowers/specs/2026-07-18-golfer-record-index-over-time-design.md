# The golfer's record, redesigned: your index over time, not a differential sparkline

- **Date:** 2026-07-18
- **Status:** Owner-approved design session (this document is the record).
- **What this is:** a **design correction** to the profile's "Your record" section. It was never
  designed — it's the sum of what each component happened to render (an index, a career
  distribution, an *unlabeled differential sparkline*, a history list). The differential sparkline
  is the worst of it: it plots score differentials (handicap-system plumbing no golfer thinks in),
  and through a handful of rounds it draws a confident line through noise — the opposite of trust.

## 1. What the record is for

A golfer opens it to answer two questions, in the language they actually trust:
1. **"What's my handicap, and can I trust it?"** — the headline index + its source. Already good;
   unchanged here.
2. **"Am I getting better?"** — what the sparkline botched. This spec answers it honestly.

## 2. The design

### 2a. "Your index over time" — a rolling, dual-index chart (replaces the differential trend)

Delete the differential `trend` entirely. In its place: a chart of **your index over your rounds**,
where each point is *your index as of that round* — recomputed from the rounds you'd played up to
then (rounds `0..k` folded through the same WHS/swng engine, at each `k`). The line is literally
your handicap's own history: down = getting better, in the one number you own.

**Two lines, always — it just shows data, no choice, no source-following:**
- **swng index** — a value at *every* round (it extends to unrated play).
- **WHS index** — a value at every round *once the prefix contains at least one rated round*; it
  simply **holds flat** across unrated rounds (they post no differential, so the rated set — and the
  WHS index — is unchanged), and is **absent only** for the early rounds before any rated round
  exists.

The two diverge exactly when you play unrated golf: swng moves, WHS holds. That gap is not hidden —
it *shows you* what unrated play does to your number. A rated-only golfer sees the two lines
coincide.

**This is a real domain metric, not plumbing reshaped.** Computing an index (WHS Rule 5.2a window +
adjustments; the swng extension) is golf math — so the rolling series is computed in `@swng/domain`
and served, exactly like the current indices. This is the distinction that was wrong before: the
old `trend` was a *rendering* of differentials (a view's job) frozen onto the wire; the rolling
index is a *computed fact*, self-describing, that earns its place.

**Gated on data — refusing to draw noise is the trust.** Under **8 finalized rounds** the chart is
not drawn; the area reads *"Your index history shows up at 8 rounds — you've played N. Keep going."*
(8 is the product call: below it the small-sample index still lurches and a line would imply a
pattern that isn't there. Tunable, one constant.)

### 2b. Headline index + source picker — unchanged

The "Your index" headline (`resolveIndex(source, metrics)` → swng / WHS / your declared number) and
its source picker stay exactly as shipped. That number is a **claim** — the one you play *strokes*
off at a course, and `declared` exists so a golfer can override the computation with a number they
trust. The chart (2a) is **data**, not a claim: it shows both computed indices regardless of what
you declared. So a declared golfer is never shown "nothing" — their headline reads their own number,
and the chart still honestly shows what their rounds compute to, both ways.

### 2c. Scoring shape — "your typical 18," not career totals

"41 pars, 16 doubles" is meaningless without knowing it's over N rounds. Replace the career-total
distribution with a **per-18-hole rate**: *"In a typical 18: 2 birdies · 8 pars · 5 bogeys · 3
double+"* — normalized (`bucket / holes-decided × 18`), so it reads the same at 5 rounds or 500.
Computed in the domain (it's a derived stat over the same lines); served; rendered.

### 2d. History leads with what you shot

Each round row leads with the **score** — `Casa Verde GC · white · 81 (+9)` — the thing you lived
and trust; course difficulty is implicit in the course name. The **score differential**, if shown at
all, is a quiet secondary detail and **rounded to its real 0.1** (a posted differential is a 0.1
value — `23.6`, never the raw `23.563565891472873`). The raw float is rounded at the record/wire
boundary; the index's internal full-precision path is left untouched (a deliberate, tested decision —
premature rounding would compound through the average, and no WHS source consulted mandates
round-then-average).

## 3. Where the computation lives (boundary-consistent)

All of it is `@swng/domain` golf math, computed in `getMyRecord` on read and served — never in a
view:
- `golferMetrics` grows `indexHistory` (the rolling swng/WHS series) and `typicalEighteen`, and
  **loses `distribution` (career totals) and `trend` (differential array)**.
- The served `history[].differential` is rounded to 0.1.
- `@swng/web` renders the two-line chart, the gate message, the typical-18 line, and score-first
  history — computing no golf result (the ESLint fence from the boundary arc still holds; a chart
  library plotting served numbers is presentation).

**Proposed wire shape (pinned so the plan is concrete):**
```ts
metrics: {
  whsIndex?:  { value; computedAtMs; differentialsUsed };   // unchanged
  swngIndex?: { value; differentialsUsed };                 // unchanged
  typicalEighteen: { eagles; birdies; pars; bogeys; doublePlus };  // per-18, required
  indexHistory: readonly {                                   // oldest→newest (round sequence IS the x-axis; no calendar date), required ([] if none)
    readonly roundId: RoundId;
    readonly swngIndex?: number;   // swng index as of this round (rounded 0.1); absent only if no ags-bearing round in the prefix
    readonly whsIndex?: number;    // WHS index as of this round (rounded 0.1); holds flat across unrated rounds; absent only before any rated round exists
  }[];
  // trend: DELETED. distribution: DELETED.
}
```

## 4. Deploy & data

- **Wire change**, no data migration (everything is compute-on-read from existing lines).
- The change both **removes** required fields (`trend`, `distribution`) and **adds** required ones
  (`indexHistory`, `typicalEighteen`), so no single deploy order is clean (add → lambda-first;
  remove → web-first). On beta (disposable, effectively single-user) the accepted play is: deploy
  lambda, then `publish:web:beta` + CloudFront invalidate **immediately** — the only exposed window
  is a stale cached bundle hitting the new response, which throws on `GET /me/record` and self-heals
  on the invalidation, exactly as prior arcs accepted. No wipe.

## 5. Testing intent

- **Domain owns the numbers.** `indexHistory` gets unit tests: the index at round `k` equals
  `golferMetrics(prefix)`'s index; the WHS line skips unrated rounds; the swng line covers all;
  values are 0.1-rounded. `typicalEighteen` gets tests (normalization; mixed 9/18; zero rounds → all
  zero). The 0.1 differential rounding gets a test. These are the point — the core vouches for the
  numbers a chart merely draws.
- **The gate is asserted:** under 8 rounds → no series drawn / the "keep going" copy; at 8 → drawn.
- **Web tests shrink to "renders what it was given"** — the chart plots `indexHistory`, the typical
  line renders `typicalEighteen`, history rows lead with score.
- Existing gates (`e2e:beta`, `e2e:field`) stay green; the profile-metrics assertions update to the
  new shape (no `trend`, no career `distribution`).

## 6. Out of scope

- Removing or changing the source picker / `resolveIndex` (2b is explicit: it stays — it's the
  stroke claim, a different job from the data chart).
- Any change to how a differential or index is *computed* — this redesigns what the record *shows*
  and adds a rolling projection of the existing engines; the engines themselves are untouched (the
  differential's internal full precision is deliberately preserved; only its *displayed* value is
  canonicalized to 0.1).
