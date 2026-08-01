# A round has one date: when you played it

> Status: **proposed** (2026-08-01, owner design session). Scope: `@swng/domain`,
> `@swng/contracts`, `@swng/application`, `@swng/client`, `apps/infra-cdk` (one route),
> `apps/web`, one prod migration script. Beta and prod both migrate — no tolerate arm.

## 1. The problem

Two people played nine holes on a Friday and kept score on paper. They want it in swng.

The path already exists and works: Start round → pick the course and tee → you are the only seat
→ type your scores → add no games → Finalize. It lands in your history, feeds your average,
contends for Best 9. (`unresolvedGames` returns nothing when a round has no games, so finalize is
unblocked.) The other player does the same from the same paper card.

**One thing is broken: the round is dated when you tapped the button**, and there is no way to
say otherwise.

## 2. The real defect underneath it

`createdAtMs` is doing two jobs — *when the record was created* and *when the round was played*.
Today those are the same instant, so one number does both and nothing surfaces the overload.

`sortLines` is the same bug in a second place: your history sorts by `finalizedAtMs`, which only
looks right because you finalize the round you just played. **Both are wrong today**, latently;
back-dating is what makes them visible.

The complete inventory of a round's time facts as they stand:

| Fact | Source | Read by |
|---|---|---|
| created at | `round-created`'s `hlc.wallMs`, via `createdAtMsOf` | `roundLabel`'s **day**, `roundDayKey` day-grouping, `roundLabel(withTime)`'s time on a same-course-same-day collision, the crew season `inWindow`, the profile chart's date anchors |
| finalized at | `round-finalized`'s `hlc.wallMs`, via `finalizedAtMsOf` | `sortLines` — history order, newest first |

Copied onto each participant's projection line at finalize as `createdAtMs` / `finalizedAtMs`,
and served as `createdAt` / `finalizedAt`. Time-of-day has exactly one consumer in the system:
the "· 7:58a" suffix on a collision.

## 3. The model

**A round has one date — when you played it. It is the only date the product uses.**

Three fields, each meaning exactly one thing. The simplification is not "fewer fields"; it is
that no field does two jobs.

| | means | set by | read by |
|---|---|---|---|
| `playedAt` | when the golf happened | the golfer | everything the product shows, groups, or sorts by |
| `createdAt` | when the record was made | the log | audit only — rendered nowhere |
| `finalizedAt` | when it was sealed | the log | audit, and "this round is finished" |

`createdAt` is not removed and it is not redundant. Today it is identical to `playedAt` on every
round in existence; the moment back-dating exists, **the gap between them is the signal** — played
July 24, record created August 1 means this was hand-entered from a paper card rather than
live-scored. That distinction has nowhere else to live. What it loses is the product surface.

The event log is untouched. Every event carries an HLC whose `wallMs` is load-bearing for
conflict resolution and is the audit trail by construction. Nothing here changes that layer; the
projection line — a derived read cache — is the only layer whose meaning shifts.

### 3a. Where `playedAt` lives

`round-created` gains **required** `playedAtMs: number`, server-stamped from the request.
`StartRoundRequest` gains optional `playedAtMs?: number`; absent means "now", which is exactly
today's behaviour.

Required, not optional-with-fallback: a fallback arm is a permanent read branch existing to serve
a handful of enumerable records, which is the reflex the 2026-07-31 prod migration spec rejected
on proportion. Every stored round is migrated (§6) and the branch never exists.

### 3b. Correctable while live

One narrow event, the `participant-strokes-set` template minus the subject:

```ts
| { readonly kind: "round-played-at-set"; readonly playedAtMs: number }
```

Latest-HLC-wins. `POST /rounds/{roundId}/played-at`, participant auth, any participant may set it
(the score-for-anyone trust model), server-minted envelope, `round-not-live` gated — `setStrokes`'s
shape exactly.

This exists because without it a wrong date costs you a re-entry of eighteen scores. This repo
already ruled that typed numbers are correctable; the whole mid-round strokes-correction arc
exists for that reason.

### 3c. One rule decides it

ONE domain function answers *when was this round played*, over a round's events:

> the latest `round-played-at-set` by HLC, else `round-created.playedAtMs`.

Two arms, no fallback. Both callers use that one function — `reduceRound` (so the live round page
shows and edits it) and the projector (so every participant's line is stamped with the same
instant). Two implementations would let a live round and its own archive disagree about what day
it was.

### 3d. Frozen at finalize

The snapshot is a sealed leaf. No editing after; this arc adds no reopen path.

## 4. What moves onto `playedAt`

| surface | today | after |
|---|---|---|
| `roundLabel` day + collision time | `createdAt` | `playedAt` |
| `roundDayKey` / `dayCollisionChecker` | `createdAt` | `playedAt` |
| history sort (`sortLines`) | `finalizedAtMs` | `playedAtMs` |
| crew season `inWindow` / `playedAtMs(line)` | `createdAtMs ?? finalizedAtMs` | `playedAtMs` (required — the `??` arm is deleted) |
| profile chart date anchors | `createdAt ?? finalizedAt` | `playedAt` |
| watch page's own client-side derivation | `round-created`'s `hlc.wallMs` | the §3c function, via `@swng/client` |
| home's live-round pointer | `createdAt?` on `LIVE#` | `playedAtMs`, written at join from the round's own state |

`createdAt` stays on the projection line and on the wire, untouched, now honestly meaning only
what its name says. Nothing renders it. Removing it would be a wire deletion with no benefit.

## 5. The form

`CreateRoundPage` gains one field: **"When did you play?"** — a `datetime-local` input defaulting
to now, always visible, no "past round" disclosure and no second mode. A retroactive round is not
a different kind of round; it is a round with a different date.

Date **and** time, and that is the point: the field shows the exact instant that will be stored,
so nothing is inferred behind the user's back. Back-date to Friday and it defaults to Friday at
the current time of day; if you teed off at 8am and care, you change it. Earlier drafts of this
design picked local noon, and then the entry time-of-day, by a hidden rule — both were the app
inventing a number where the user could not see it.

The round page shows the played date with an Edit affordance in the roster-strokes-editor idiom
(Edit swaps the static value for an input, Save is `btnSecondary`, api-then-`sync()`, no
optimistic write).

**Future dates are allowed.** Setting up Saturday's round on Thursday is the same round entered
early instead of late, and a ban costs a real use case to prevent nothing.

## 6. Bounds

On the **request schemas only**, never the stored event arm — Arc A's placement rule (a bound on
a stored/fold path rejects already-stored data on a read path). `2000-01-01` to two years ahead:
typo protection, not a product limit.

## 7. Crew seasons: a round counts where it was played

**No guard, no warning.** A back-dated round lands in the season whose window contains it, and
that season's standings move even if it already reads FINAL.

That is correct. Crew standings are a read fold over members' lines — nothing precomputed,
nothing stored — so a March round belonging to March is the whole point; the alternative is
dropping real golf out of the record to protect a board's appearance. FINAL therefore means *"no
more rounds can be played into this window,"* not *"these numbers will never move"* — already
true, since a member joining or leaving moves a finished season's standings.

## 8. Migration — no tolerate arm anywhere

Prod holds a handful of rounds (4 rounds / 3 snapshots as of 2026-07-31, plus any played since);
beta was wiped recently. That is enumerable, so it is migrated, on the 2026-07-31 precedent.

The transform is **lossless by definition**: write each `round-created` event's own `hlc.wallMs`
into its new `playedAtMs` — the exact number a fallback would have computed. Guarded on the field
being absent, so it is idempotent and an interrupted run is a shorter next run. Two targets, the
same two as the strokes migration: the rounds table's `round-created` events, and each snapshot's
archived copy of the same event.

**Order: migrate → deploy → `rebuildProjections`.**

- Migrating first is safe in a way the strokes arc's order was not: `round-created`'s schema is
  not `.strict()`, so the old deployed lambda silently strips the new key. There is no window in
  which anything is broken.
- Deploying first would be a real outage — the new lambda requires `playedAtMs` and every
  un-migrated round would fail to parse.
- `rebuildProjections` after the deploy is what puts `playedAtMs` onto the existing lines.
  Snapshot writes during the migration re-drive the stream under the *old* projector, which
  cannot stamp a field it does not know; the rebuild is the sanctioned re-drive and it runs the
  same `projectArchive` a finalize does.

Beta gets the same script, same order.

## 9. Testing

- **Domain**: the §3c rule — `round-created.playedAtMs` alone; a later `round-played-at-set`
  wins; an HLC-*earlier* set does not win; two sets resolve by HLC not arrival order.
- **Domain**: `reduceRound` and the projector's derivation return the same instant for the same
  log, asserted directly, so the one-rule invariant cannot silently fork.
- **Domain**: `sortLines` orders by `playedAtMs` — a round finalized last but played first sorts
  first (the pin that would fail under today's `finalizedAtMs` ordering).
- **Contracts**: `playedAtMs` round-trips; pre-2000 and >2-years-ahead are rejected; a
  `round-created` without it is rejected (the no-fallback pin).
- **Application**: `setPlayedAt` appends while live, refuses a finalized round, refuses a
  non-participant.
- **Projection**: a log carrying a `round-played-at-set` projects lines stamped with that instant.
- **Crew**: a back-dated round lands in the season window containing its `playedAt`, including a
  season already past its `endsAt`.
- **Web**: the create form submits the instant shown in the field; the round page's Edit posts
  once and re-syncs; `roundLabel` renders the played day.
- **Migration**: the transform is pure and I/O-free, idempotent, and writes exactly the genesis
  clock — same split as `prodStrokesMigration.mjs`, so the instrument that writes prod and the
  instrument that checks it cannot drift.
- **e2e**: create a round dated three days back, finalize, and assert both the history row's
  `playedAt` and the rendered `roundLabel` name that day — form to sealed snapshot to projection
  to screen.
