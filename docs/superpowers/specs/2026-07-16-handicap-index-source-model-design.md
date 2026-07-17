# The index a golfer is *on* — a source you choose, resolved live, never a stored copy

- **Date:** 2026-07-16
- **Status:** Owner-approved design session (this document is the record). It **supersedes §3
  and §8** of `2026-07-16-handicap-index-strokes-model-design.md` — the "one visible index" and
  "API legibility" sections that described the intent in prose but were implemented as a
  nullable primitive. Everything else in that spec (the two computed numbers §2, strokes §4,
  rated-vs-unrated §5, analytics §6) **stays** and is unchanged.
- **Why this exists:** the shipped model stores "the golfer's index" as `declared?: number`, so
  the system can represent only two states — *no override → swng*, or *a frozen number*. WHS was
  never something a golfer could *be on*; the profile's "Use this" button on WHS just wrote
  today's WHS value into that one primitive (`setDeclared(String(value))`). Consequence: a
  golfer who adopts their official handicap watches it **silently drift** from the WHS number one
  line below it as they post rounds, and their per-round strokes compute off the stale copy. The
  math was fine; **the index was modeled as a primitive when it is a system.** This document
  models it as a system.

## 1. The one-sentence model

**A golfer's index is a SOURCE they choose; the value is resolved from that source and the
golfer's rounds, live, on every read — swng and WHS are live sources you can *be on*, and the
only number ever stored is one the golfer deliberately asserts.**

## 2. The invariant (this is the whole design)

**Never store a computed number.** A computed index — swng or WHS — is a live view over the
golfer's rounds. The instant a copy of it is persisted, it is a lie waiting to happen (the
rounds move; the copy doesn't). So the profile stores a **choice of source**, plus at most one
number the golfer *asserts*. It never caches swng or WHS. Every consequence below follows from
this one rule; the shipped bug was exactly its violation (a computed WHS value copied into
storage).

## 3. The model — `IndexSource`

The golfer's index is a discriminated union, persisted on the profile (identity-level, stable —
not per-round):

```ts
type IndexSource =
  | { kind: "swng" }              // computed from ALL your rounds — the DEFAULT
  | { kind: "whs" }               // computed from your rated rounds, official rules
  | { kind: "declared"; value: number }   // a number you assert (your GHIN/club index)
```

- **Default** for every golfer is `{ kind: "swng" }` — a working handicap with no action, as they
  play.
- **`declared` is a PERMANENT peer** (owner decision, 2026-07-16): a golfer may assert their own
  number forever, not only as a brand-new bootstrap. Rationale: a system you *can't* correct is
  less trustworthy than one you can, and the assertion is never hidden — it renders as "your own"
  with the live computed numbers shown beside it. (The rejected alternative — declared as a
  bootstrap that auto-retires once swng/WHS can compute — is recorded in §9.)

## 4. Resolution — one pure function, live, `undefined` first-class

"Your index" is **never stored as a value.** It is resolved on every read by one pure domain
function over the source and the metrics read projection (`golferMetrics` — §2 of the strokes
spec, unchanged):

```ts
type ResolvedIndex = { value: number | undefined; kind: IndexSource["kind"] };

resolveIndex(source, metrics): ResolvedIndex
  swng     -> metrics.swngIndex?.value    // undefined until enough rounds
  whs      -> metrics.whsIndex?.value      // undefined until enough rated rounds
  declared -> source.value                 // always present
```

- **swng and WHS are live sources you can be on.** A golfer on WHS sees their WHS index as their
  index; as they post rated rounds it tracks — it **always equals the WHS row**, because it *is*
  the WHS row, resolved fresh. Drift is now unrepresentable.
- **`undefined` is a first-class outcome**, not `0` and not a crash. On a source with no data
  yet ("Use WHS" before three rated rounds exist), the resolved value is `undefined`; the UI
  shows the value as `—` with the source's reason, and any consumer needing a concrete number
  (strokes) falls back to "type your own."
- **This replaces `effectiveIndex({ declared, computed })`** and its hidden `declared ?? computed`
  precedence. There is no precedence — there is a chosen source, resolved.

## 5. Provenance is always on the screen

Every rendered index carries its source, so a golfer always knows *which* number they're looking
at and *why*:

- `swng` → "12.4 · from all your rounds"
- `whs` → "11.2 · your WHS index (official)"
- `declared` → "8.0 · your own"

This is the strokes-spec §3 intent — "it always says where it came from: computed / WHS / your
own" — realized in the **model**, so the label can never disagree with the stored state (there is
no separate stored value to disagree with).

## 6. UX rules (the choice is explicit and total)

- **Profile.** One "Your index" showing the active resolved value + its source. Beneath it, the
  two computed sources as data points with their live values — **swng index** ("from all your
  rounds") and **WHS index** ("rated rounds, official rules") — each with a one-tap **"Use this"**
  that sets the *source* (`{kind:"swng"}` / `{kind:"whs"}`), NOT a value copied into a box. A
  computed source with no value yet renders `—` and its "Use this" is disabled. The **override**
  is a "your own number" input; a saved non-empty value sets `{kind:"declared", value}`. The
  active source is visibly marked ("in use"). There is always a path between sources — adopting a
  computed source is one tap; asserting your own is typing + Save; leaving your own is tapping a
  computed source.
- **Round (create/join).** The strokes field derives from `resolveIndex(source, metrics).value`
  exactly as today (strokes spec §4 conversion is unchanged), shown WITH its derivation and
  editable. The derivation names the source it came from — e.g. "13 — from your WHS index (11.2)
  on this course" / "6 — from your index (12.4), adjusted for 9 holes; unrated course, adjust if
  it plays hard/easy." No effective value (source resolves to `undefined`) → the field is empty,
  no derivation line, you type your strokes.

## 7. What stays sealed

The round still **freezes the derived strokes number** at create/join — a correct immutable fact
("you took 13 strokes that day"), not the source. The source lives on the **mutable profile**;
the round is the **immutable leaf** and is not touched. Changing your source later never rewrites
a round you already played (strokes spec §4, unchanged).

## 8. System boundaries (blast radius) and migration

- **`@swng/domain`** (`golfer/golfer.ts`): `HandicapProfile.declared?: number` →
  `HandicapProfile.indexSource: IndexSource`; add `resolveIndex(source, metrics): ResolvedIndex`;
  delete `effectiveIndex`. `metrics.ts` (`golferMetrics`, `swngIndex`, `whsIndex`) is unchanged —
  resolution consumes it.
- **`@swng/contracts`** (`golfers.ts`): a Zod discriminated-union `indexSourceSchema`; the golfer
  view (`GET /me`) and update request (`PUT /me`) carry `indexSource` in place of `declared`.
- **`@swng/application`**: `updateMyGolfer` writes the chosen source; `golferView`/`toGolferView`
  maps `HandicapProfile.indexSource` to the wire. `getMyRecord` is unchanged (it already returns
  `metrics`; the client resolves).
- **`adapters-dynamodb`** (`createDynamoGolferStore.ts`): serialize/deserialize `indexSource`.
  Deserialization **tolerates the old shape** — a stored `declared: <number>` (or the legacy
  `official`) maps to `{kind:"declared", value}`; absent maps to `{kind:"swng"}`. Because beta is
  wiped and no prod pool exists, there is effectively no data to migrate; the tolerate path is
  defensive and drops on the next whole-document put (the established pattern), never a migration
  script.
- **`@swng/web`**: `ProfilePage` "Use this" sets the source, not a text copy; the override sets
  `declared`; the active source is marked. `CreateRoundPage`/`JoinRoundPage` call `resolveIndex`.
  The three surfaces call the ONE resolver — collapsing the Create↔Join "which number"
  duplication the review flagged into a single site.

## 9. Testing intent

- `resolveIndex` unit tests: each kind resolves to the right member; `swng`/`whs` return
  `undefined` when the metric is absent; `declared` always returns its value. A **no-drift**
  test: with a fixed source and two different metrics snapshots, the resolved `swng`/`whs` value
  follows the metrics (a stored value can't, by construction — there's nowhere to store one).
- Contract round-trip for the discriminated `indexSourceSchema`, including the legacy-`declared`
  tolerate path in the golfer store (and the **`getBySub`** production read path pinned, closing
  the review's open test gap — same fold, now covered end to end).
- Web: Profile "Use this" on WHS puts the golfer *on WHS* (active source = whs, value tracks the
  metric), not a frozen copy labeled "your own"; a golfer on WHS whose metrics change shows the
  new value with no further action; create/join strokes derive from the resolved source.

## 10. Out of scope / recorded, not designed here

- **`declared` as a bootstrap that auto-retires** — rejected in favor of the permanent peer
  (§3); a system you can't correct is less trustworthy than one you can.
- **A hidden default that auto-prefers WHS for heavily-rated golfers** — still rejected (strokes
  spec §10); the explicit, shown, one-tap "Use WHS" source is the legible answer, and a live
  source a golfer chose is the opposite of a hidden preference.
- **The strokes conversion itself** (rated exact / unrated hole-count estimate) — unchanged
  (strokes spec §4).
- **The other analytics** — each its own future projection over the sealed snapshots (papercut
  17), unchanged.
