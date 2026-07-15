# Course Cards — the stored unit is the frozen unit

- **Date:** 2026-07-15
- **Status:** Approved in design session (owner); this document is the record.
- **Supersedes:** M6's course aggregate design (per-tee `TeeSetVersion`s, name-keyed tees,
  client-authored round cards, "Verify this card"). This spec deletes it; nothing here
  migrates it.

## 1. Problem

Facts from the current code, each independently verified:

1. **The client authors the authoritative scorecard.** `StartRoundRequest` is
   `{ card, host }` — a full client-built `CourseCard`. `startRound` freezes it verbatim;
   the server never consults the course store on any round path, not even at creation.
   The stored course record and all its provenance can be bypassed entirely.
2. **Finished rounds record no course identity.** The archive holds the frozen card and a
   course *name string*. Renames and duplicate entries splinter any future course-based
   analytics ("my rounds at Casa Verde") irreparably — identity at creation time is the
   one thing that cannot be backfilled into sealed rounds.
3. **Tee sets have no identity** — the display name is the key everywhere. Rename is
   structurally impossible; re-entering an existing name silently becomes a revision.
4. **Nothing prevents one course holding a 9-hole and an 18-hole tee.** A frozen card
   with disagreeing hole counts would corrupt games. Latent landmine.
5. **Course writes are unauthenticated** (`auth: "none"`, a deliberate M6 placeholder —
   identity landed M7 and the routes were never revisited). `enteredBy` and
   `verifierName` are client-typed strings.
6. **"Verify this card" is a `window.prompt` asking you to type your own name into an
   unauthenticated counter.** The "✓ N verified" badge implies trust the mechanism does
   not provide.
7. **The UI cannot add a tee.** `addTeeSet` has existed on the wire since M6;
   `EditCoursePage` only ever re-submits the same tee name as a revision. There is no
   standalone course page at all — course maintenance exists only as a detour inside
   round creation.

## 2. The core idea

The round consumes exactly one value — the card:

```
CourseCard: courseName + teeSets[] (name, rating, slope, holes[par, strokeIndex, yardage])
```

M6 stored a *different* shape (a mutable aggregate of per-tee versions) and translated it
to a card at freeze time. That translation seam is where course-model changes could leak
into rounds, and it made "what is a course?" unanswerable.

This design eliminates the seam: **the course system stores exactly what the round
freezes — immutable cards, in lineages.**

- A **card** is a complete, immutable, write-once scorecard with identity.
- A **course** is a lineage of cards (`courseId`); its current card is the course.
- Every maintenance operation — add a tee, fix numbers, rename anything — is one
  operation: submit a new card that supersedes the current one.
- Round creation references the current card by id; the server freezes it **verbatim**.

Any future course mechanism (facility groupings, per-nine routings, GHIN-style import) is
a *card factory* — upstream machinery whose output is a card in a lineage. The round's
interface is the card; the card is the stored unit; course-model evolution structurally
cannot reach the round.

**The trust model is transcription, not authority.** The authoritative scorecard is the
printed one in the cart; swng's course record is the crew's *shared transcription* of it,
entered once instead of re-typed every Saturday — "for the golf you actually play." That
is why community editing is the right model at this scale (fixing a transcription typo is
not an act of authority), why the trust surface is attribution and retained history
rather than a verification badge (§8 — the badge claimed an authority the mechanism never
had), and why the stakes are self-limiting: a wrong number is visible on the very card
you're scoring against, and every round archives the exact transcription it was played
against, right or wrong — which is the honest record of what happened. If real authority
is ever wanted (competition across strangers, official posting), it arrives as *imported*
cards — `provenance` already keeps the two kinds distinct and never conflates them.

## 3. Domain model

`packages/domain/src/course/` is rewritten around one record type:

```ts
// ids.ts — CardId and TeeId join the existing brand family beside CourseId
export type CardId = Brand<string, "CardId">;
export type TeeId = Brand<string, "TeeId">;

export interface CardSource {
  readonly cardId: CardId;     // identity of this exact card
  readonly courseId: CourseId; // the lineage
}

// card.ts — CourseCard and TeeSet each gain one optional identity field; Hole unchanged
export interface CourseCard {
  readonly courseName: string;
  readonly source?: CardSource; // optional on the value type (fixtures/decks); present on every stored & frozen card post-scrap (§9)
  readonly teeSets: readonly TeeSet[];
}

export interface TeeSet {
  readonly teeId?: TeeId; // optional on the value type (fixtures/decks); present on every stored & frozen card post-scrap (§9)
  readonly name: string;
  readonly rating: number;
  readonly slope: number;
  readonly holes: readonly Hole[];
}

export interface CardRecord {
  readonly cardId: CardId;
  readonly courseId: CourseId;
  readonly card: CourseCard; // card.source === { cardId, courseId } — set at mint, invariant
  readonly enteredBy: { readonly golferId: GolferId; readonly name: string };
  readonly enteredAtMs: number;
  readonly supersedes?: CardId; // the card this one replaced; absent on lineage roots
}
```

Ids are branded in the domain, plain `z.string()` on the wire — the standing pattern
(`RoundId`, `GolferId`, `CrewId` all work this way).

**Tee identity is recorded at the only moment it is certain — write time.** The editor
edits the loaded card in place, so column identity through an edit is knowledge, not
inference: a tee submitted *with* its `teeId` is the same tee (renames and number
corrections included); a tee submitted *without* one is new and the server mints its id;
an id absent from the submission is a removed tee. Supersede validation: every submitted
`teeId` must exist in the superseded card (400 `unknown-tee-id`), no duplicates. On
stored `CardRecord`s every tee carries its id — the optional-on-the-value-type /
required-on-stored-records split is the same one `card.source` uses. The governing
principle (also why facility grouping is deferred, §11): record facts at the moment they
are known with certainty; defer relations that are not knowable at write time.

Deleted from the domain: `Course`, `TeeSetVersion`, `verifications`, `addTeeSet`,
`verifyTeeSet`, `courseCardOf` (no translation exists — `record.card` IS the card).
`courseNameKey` (search normalization) survives unchanged.

**Card validity** (one `validateCard`, replacing `validateTeeSet` — identical numeric
bounds, moved not rewritten):

- ≥ 1 tee set; tee names unique case-insensitively.
- Every tee set has the **same** hole count, and it is 9 or 18. (Closes fact #4. The
  hole count is a property of each card, derived from its tees — nothing is "pinned
  forever"; a correction card may change it, and sealed rounds keep the card they froze.)
- Per tee: stroke indexes are a permutation of 1..N; holes numbered 1..N in play order;
  rating/slope/par/yardage bounds exactly as M6's `validateTeeSet`.

**Attribution:** `enteredBy` is derived from the authenticated account at write time and
frozen into the record — golfer renames never rewrite attribution, the same rule as
roster names on rounds.

## 4. Wire contracts

### Round creation (the correction this spec exists for)

```ts
// packages/contracts/src/commands.ts
export const startRoundRequestSchema = z.object({
  course: z.object({ courseId: z.string().min(1), cardId: z.string().min(1) }),
  host: z.object({ tee: z.string().min(1), courseHandicap: z.number().int() }),
});
```

The `card:` field is **gone** — no tolerate path, no dual shape. An old client posting a
card gets 400 `invalid-request`. `host` is unchanged (tee selection is by name, as it is
at join; names are stable within an immutable card by construction).

`startRound` gains a `courseStore` dependency and does:

1. Load the lineage's current pointer and the referenced card (one `BatchGet`).
2. If the referenced card is not the current card → **409 `card-superseded`**.
3. Resolve `host.tee` against the card (existing `findTeeSet`, existing
   `unknown-tee-set` error).
4. Freeze `record.card` verbatim into `round-created` — byte-identical to the stored
   value, `source` included.

`joinRound`, `peekRound`, the fold, scoring, settle, and the archive shape are
**untouched**. The only change the round side sees is the pair of optional identity
fields (`CourseCard.source`, `TeeSet.teeId`) on types it already imports.

### Course routes (37 → 36 HTTP; 38 total with WS)

| Route | Auth | Body | Notes |
|---|---|---|---|
| `POST /courses` | golfer | `{ name, teeSets }` | New lineage; mints `courseId` + `cardId`. 201 → `CourseView`. |
| `PUT /courses/{courseId}` | golfer | `{ name, teeSets, supersedes }` | THE maintenance operation — add tee, fix numbers, rename course or tee are all this. 200 → `CourseView`. |
| `GET /courses/{courseId}` | none | — | Current card of the lineage. |
| `GET /courses?query=` | none | — | Prefix search over current cards. |
| ~~`POST /courses/{id}/tees`~~ | — | — | **Deleted** (subsumed by PUT). |
| ~~`POST /courses/{id}/verify`~~ | — | — | **Deleted** (see §8). |

Write schemas are `.strict()`; `enteredBy` no longer exists on any wire body. Tee ids on
the wire follow the continuity rule (§3): `POST /courses` tees carry no ids (all minted);
`PUT /courses/{courseId}` tees carry `teeId` iff they continue an existing tee — two
distinct input tee schemas, so a client can never supply an id the server didn't mint.
The two writes leave the anonymous-reachable throttle set (they are golfer-auth now); the
two GETs stay in it.

```ts
export const courseViewSchema = z.object({
  courseId: z.string(),
  cardId: z.string(),
  card: courseCardSchema,   // the exact frozen-able value, source included
  enteredBy: z.string(),    // display name only; golferId stays server-side
  updatedAtMs: z.number(),
});

export const courseSearchResultSchema = z.object({
  courseId: z.string(),
  name: z.string(),
  holeCount: z.union([z.literal(9), z.literal(18)]), // "Casa Verde GC · 18 holes" — distinguishes routings entered as separate lineages
});
```

`courseCardSchema` gains optional `source`; because the archive and peek responses embed
the card schema, sealed-round reads expose `source` automatically with no further wire
changes. Old snapshots simply lack it.

### Golfer history line

`GolferRoundLine` (and its projection item and the `/me/rounds` response) gain
`courseId?: string`, populated by the projector from `archive.card.source?.courseId`.
Nothing renders it yet — it is recorded from day one because it cannot be backfilled.
No course-book feature, projection, or query is built in this arc.

## 5. Storage

`createDynamoCourseStore` is rewritten (contract tests rewritten with it). Core table,
existing `COURSE#` namespace:

```
pk=COURSE#<courseId>  sk=CURRENT              ← pointer: { cardId, name, holeCount,
                                                 gsi1pk="COURSE", gsi1sk=courseNameKey(name) }
pk=COURSE#<courseId>  sk=CARD#<cardId>        ← one immutable item per card (full CardRecord)
```

- **Create** — `TransactWriteItems`: Put card (`attribute_not_exists(pk)`) + Put pointer
  (`attribute_not_exists(pk)`).
- **Supersede** — `TransactWriteItems`: Put card (`attribute_not_exists`) + Update
  pointer with `ConditionExpression: cardId = :supersedes`. Conditional failure → 409
  `card-superseded`. No server-side retry loops: every write is authored against a card
  a human just reviewed; a race means a second look, never a blind merge.
- **Read** — pointer + card are `BatchGet` by exact key; cards are immutable, so a torn
  read is unrepresentable regardless of concurrent writes.
- **Search** — unchanged mechanics: single-partition `gsi1` prefix query, now over
  pointer items only (one search row per course, not per card). Legacy course items use
  `sk=COURSE` and the same GSI partition — they are wiped at rollout (§9), not tolerated.
- The store-only `revision` counter and `retryOnConflict` usage for courses are deleted;
  card identity does that work now.

History (the lineage's superseded cards) stays server-side, exactly like M6's audit
trail — no wire surface reads it yet.

## 6. Concurrency: one rule, one error

> Every course write and every round creation names the exact immutable card the caller
> reviewed. If that card is no longer current → **409 `card-superseded`** → the client
> re-fetches, the human re-reviews, and re-submits.

This is M6's `tee-set-revised` anti-transplant insight ("never act on numbers you didn't
see") promoted to the whole system with less machinery: identity replaces the version
pin, the revision counter, and the retry loop. `tee-set-revised` and `course-conflict`
error codes are deleted with their mechanisms.

## 7. Web surfaces

Courses become their own product area, consuming and maintaining cards:

- **`/courses/:courseId` — new CoursePage, the hub.** Renders the current card (every
  tee, per-hole grid), honest attribution ("entered by Blaine · updated Jul 14"), and
  three actions: **Edit this card** (→ edit page), **Start a round here** (→ `/create`
  preseeded), and search entry. Deep-linkable; no round required to look at a course.
- **AddCoursePage** — unchanged entry grid, now lands on the new CoursePage (not
  `/create`), where "Edit this card" makes adding the second tee a natural next step.
- **EditCoursePage** — becomes the whole-card editor: course name, every tee as a
  column, an "add tee" affordance that appends a column. Columns loaded from the current
  card carry their `teeId` through rename and correction; appended columns carry none —
  identity threading falls out of editing in place, no extra affordance. Submits
  `PUT /courses/{courseId}` with `supersedes` = the `cardId` it loaded. On 409:
  "This card was just updated — review the new numbers." and re-fetch. (Same idiom as
  M6's verify-race alert.)
- **CreateRoundPage** — search → `CourseSummaryCard` preview → Start sends
  `{ course: { courseId, cardId }, host }` from the fetched view. On 409
  `card-superseded`: re-fetch and show the review notice. The verify button is deleted
  from `CourseSummaryCard`; attribution line replaces the badge.
- **JoinRoundPage** — untouched (it already selects from the frozen card via peek; live
  rounds spanning the deploy keep working).

## 8. Verification is removed, not replaced

Deleted whole: the `verifyTeeSet` domain arm, use case, route, request schema, the
`verifications` field, the `window.prompt` flow, and the "✓ N verified" badge.

Kept, because they are the real substance: immutable cards, authenticated attribution,
timestamps, and provenance (`community` | `imported` — still server-assigned, still
constant `community` until an importer exists).

Verification returns only when it has defined semantics (distinct authenticated actor,
evidence reviewed, a threshold, a stated product consequence). Recorded as a future
decision (§12), not designed here. Until then, "entered by Blaine · updated Jul 14" is
more honest than "✓ verified".

## 9. Rollout

No migration code anywhere.

1. Land the arc (domain → contracts/application → adapters (+contract tests) → lambda
   routes → web), `pnpm validate` green throughout.
2. One beta deploy (route table change: −2 +1; nothing stateful in the stack).
3. Scrap beta's course AND round data (owner amendment, 2026-07-15): one script deletes
   legacy course items (`pk begins_with COURSE#`, both shapes and their GSI rows), the
   rounds journal, every snapshot, and the derived golfer projections/presence. This
   knowingly includes the 752 POC-migrated archives and all beta handicap history —
   profiles restart clean. The payoff: **no legacy snapshot tier ever exists** — every
   snapshot in the system carries full identity (`source` + tee ids), so future
   analytics are single-shape with no name-grouped fallback.
4. Re-enter Casa Verde GC by hand from the paper card through the new AddCoursePage —
   this doubles as the controller's live walk of the new surface.
5. Gates: `pnpm validate`; `pnpm test:contract` (course store rewritten); rewritten
   `courseEntry.spec.ts` (add course → course page → add tee → start round → dots
   hole-by-hole against the same hand-verified arithmetic); `fieldTest.spec.ts` seeding
   its course through the authenticated API; `pnpm e2e:beta` ×2; `pnpm e2e:field`;
   controller browser walk on the deployed app.

"Sealed rounds are never rewritten" remains the standing rule — the scrap deletes; it
never mutates. The identity fields stay optional on the *value types* (test fixtures and
the frozen decks construct cards directly; defensive parsing costs nothing) while being
present on every stored card and every snapshot that exists after the scrap — required
by construction at the write path, not by the type.

## 10. Invariants (pinned for review)

1. **Cards are immutable, write-once, and never deleted** — enforced by
   `attribute_not_exists`, not convention. A `cardId`'s numbers can never change, and
   lineages are append-only: the retained chain is the audit trail and the safety net
   for any future archaeology.
2. **Tee identity is recorded at write time, never inferred later** — `TeeId`s are
   server-minted; a supersession's submitted ids must exist in the superseded card;
   every tee on a stored card carries its id.
3. **The stored unit is the frozen unit** — `startRound` freezes `CardRecord.card`
   verbatim; no translation function exists anywhere.
4. **Rounds are created only from a lineage's current card**; staleness is 409
   `card-superseded` — the same code and semantics as a maintenance race.
5. **The client can never author a card on the round wire.** The old shape is gone, not
   tolerated.
6. **Every tee in a card has the same hole count (9 or 18)** — a frozen card cannot be
   internally contradictory.
7. **All course writes are authenticated; `enteredBy` is derived, frozen at write time,
   and never wire-supplied.**
8. **Frozen cards are never re-read from the course store; renames never rewrite cards**
   — the lineage id (`courseId`) is what keeps analytics whole across renames.
9. **The round domain is unchanged** except the optional identity fields
   (`CourseCard.source`, `TeeSet.teeId`) — events, fold, scoring, settle, archive,
   join, peek all as before.

## 11. How analytics stand on this model

Not built in this arc — but the model is shaped so they hold, and this section is the
proof-by-walkthrough. Every course analytic is a downstream reader of snapshots,
referencing rounds inbound and computing on read — the same architecture as crew
standings and the handicap index today:

- **"My history at Casa Verde"** — the golfer's history lines filtered by `courseId`.
- **Scoring average / best round, by tee** — group lines by `courseId`, then by
  `teeId`, resolved from the snapshot's own card (each participant's frozen tee name is
  unique within it).
- **Hole insights ("which holes eat you alive")** — fold per-hole cells across a
  golfer's snapshots for one `courseId`; hole numbers are stable within a lineage, and
  each snapshot carries its own full card (par, SI, yardage), so every derived stat is
  recomputable from snapshots alone, forever, with no course-store read.
- **Venue head-to-head / course records across golfers** — `aggregateSeason`-style folds
  over snapshots grouped by `courseId`, computed on read or projected to stable keys —
  either works, because the inputs are sealed and identified.

The structural point: the only thing analytics can never recover is what rounds failed
to *record* — and the snapshot now records the complete card plus its identity facts
(`cardId`, `courseId`, and each tee's `teeId`). There is nothing course-shaped known at
creation time that a future analytic could want and we discard.

Identity is sorted by one rule — **record facts at the moment they are known with
certainty; defer relations that are not knowable at write time** (§3):

- **Tee identity is recorded, not derived** (§3). The editor knows column identity with
  certainty while the write happens (it edits the loaded card in place), so continuity
  through renames and corrections is captured then — never reconstructed later by
  walking history or matching numbers, which composite edits (a rename plus a
  correction in one supersede) would routinely defeat. Every snapshot pins
  `(courseId, cardId, teeId per tee)`; tee series group by id with no inference — and
  after the beta scrap (§9) that is *every snapshot in existence*: no legacy tier, no
  name-grouped fallback, anywhere.
- **Facility identity is the deferred one** — an 18-hole card and its front-nine card
  are separate lineages, so their stats are separate groups (for most stats that is
  semantically *correct*: a nine-hole round is not comparable to an eighteen). It
  defers because facility membership is *nobody's* write-time knowledge — no one
  declares it while entering a card, and a grouping claim needs an authority (import)
  or a moderation story (both future). It is a pure read-time relation over recorded
  `courseId`s: creatable years later and instantly covering every old round — the
  crews-over-rounds shape, never a parent tier inside card identity.

## 12. Future scenarios, recorded (2026-07-15)

Decisions made with eyes open, each with its revisit trigger:

- **Partial routings (front nine of an 18) and 27-hole combos** are separate lineages
  entered as their own printed cards, including the ~2 minutes of re-typed par/yardage
  (their ratings/slopes are genuinely distinct published data, not derivable). *Trigger:*
  a real crew regularly playing partial routings, or import. *Escape path:* a facility
  grouping OVER courseIds — inbound references, computed on read, the crews-over-rounds
  shape — never a parent tier inside card identity.
- **Import (GHIN-style course data)** — an importer is a card factory: it emits cards
  with `provenance: "imported"`. The imported ontology reshapes the course store then;
  rounds don't care. *Trigger:* the decision to scale beyond community entry.
- **Verification with real semantics** — see §8. *Trigger:* a trust problem community
  attribution can't absorb.
- **Steward moderation of course edits** — v1 is immediate-with-audit. *Trigger:* scale
  beyond crews who know each other, or the first bad-faith edit.

## 13. Out of scope

Course book / course-based analytics surfaces (only the `source` ids and the history
line's `courseId?` are recorded); facility grouping; import; any prod-stack work; any
change to join, peek, share, watch, or the round fold.
