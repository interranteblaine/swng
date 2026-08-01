# A round records when it was played

> Status: **proposed** (2026-08-01, owner design session). Scope: `@swng/domain`,
> `@swng/contracts`, `@swng/application`, `apps/infra-cdk` (one route), `apps/web`.
> No projection change, no wire change downstream of the round, no data migration.

## 1. The problem

Two people played nine holes on a Friday and kept score on paper. They want it in swng.

The path already exists and mostly works: Start round → pick the course and tee → you are the
only seat → type your scores → add no games → Finalize. It lands in your history, feeds your
average, contends for Best 9. (`unresolvedGames` returns nothing when a round has no games, so
finalize is unblocked.) The friend does the same from the same paper card.

**One thing is broken: the round is dated when you tapped the button.** `round-created` carries
only the round id and the frozen card, and `createdAtMsOf` reads the genesis event's wall clock.
Every date downstream comes from that one number — the `roundLabel` designation ("Casa Verde GC
· Sat, Jul 12"), the history row's sort, the crew season window (`playedAtMs(line) =
createdAtMs ?? finalizedAtMs`). Enter Friday's round on Sunday and it says Sunday, forever,
because the snapshot is sealed at finalize.

Same-day that number is right, which is why this has never come up.

## 2. What this deliberately does not build

**No way to put someone else on a card.** The owner's first framing was "let me add him
retroactively, and let him remove the round from his own history if he doesn't want it." The
escape hatch is the tell that the primitive is wrong: this repo already ruled on exactly this
shape when `addCrewMember` was deleted whole and replaced with invite links — *nobody is
conscripted, one path in*. A round writes to a permanent scoring record, so the argument is
stronger here, not weaker.

**No removal path either.** A history line is derived from a sealed snapshot by the projector,
so "removed" would have to become durable suppression state or a rebuild resurrects it — and a
hidden round makes your average lie, on a number whose entire claim is *what you shoot*. With
consent at entry there is nothing to remove.

**No invite mechanism, and it is not deferred — it is dropped.** Its only job was preserving the
games between two people entering the same paper round. Those games were settled in person, on
Friday; re-litigating them in the app produces nothing.

**So a retroactive round is a solo round.** Each player enters their own card. What is lost is
one linkage: two solo rounds are two roundIds, so the crew's "Played together" list and the
head-to-head sentences miss it (`sharedRoundIds` requires ≥2 current members' lines to share a
`roundId`). What is **not** lost is the crew board — Rounds · Average · Spread · Best fold each
member's own lines over the season window, so both rounds still land.

**Out of scope, recorded here so it is not rediscovered as a surprise: nine holes played on an
18-hole card.** `GolferRoundLine.holes` comes from the frozen card, and `hasCompleteScore`
requires a scored result for every one of them, so a front nine at an 18-hole course records as
half-finished and counts nowhere. That is a separate design question about a round declaring a
subset of its card's holes. It is not part of this arc.

## 3. The model

**A round's played instant is a fact the round records, defaulting to when it was created, and
correctable while the round is live.**

The pivotal implementation fact, found by reading rather than assuming: **everything downstream
already routes through one number.** `createdAtMsOf(archive)` feeds the projection line's
`createdAtMs`, which feeds `roundLabel`, `roundDayKey`, `dayCollisionChecker`, the history sort,
and the crew scoreboard's own `playedAtMs`. Override that one number at its source and the entire
downstream is byte-unchanged — no projection field, no wire field, no `roundLabel` signature
change, no season-fold change.

So the played date is **an instant**, not a `YYYY-MM-DD` string. That is not a modelling
compromise: `createdAtMs` was never the tee time — it is when someone tapped Start round in the
parking lot at 7:40 for a 7:58 tee, and the label already calls that the round's time. Extending
the same field to *"roughly when this round happened, as stated by whoever entered it"* widens its
accuracy without changing its meaning. Introducing a parallel date-string concept beside it would
put two time facts on every round with no rule for which one a given surface reads.

### 3a. Set at creation

`StartRoundRequest` gains optional `playedAtMs?: number`. `round-created` gains the same field,
server-stamped from the validated request. Absent means exactly today's behaviour: the genesis
event's own wall clock.

Old stored logs carry no such key and parse unchanged — the arm is additive and
`roundEventSchema`'s `round-created` object is not `.strict()`.

### 3b. Correctable while live

One narrow event, the `participant-strokes-set` template minus the subject:

```ts
| { readonly kind: "round-date-set"; readonly playedAtMs: number }
```

Latest-HLC-wins, accepted only while `state.status === "live"` — the `recordScore` precedent.
`POST /rounds/{roundId}/date`, participant auth, any participant may set it (the
score-for-anyone trust model), server-minted envelope, `leaveRound`'s shape.

This exists because the create-only version has a bad failure mode: you type eighteen scores,
notice the date is wrong, and your only recourse is scrapping and re-entering. This repo already
ruled that typed numbers are correctable — the whole mid-round strokes-correction arc exists
because a wrong number could not be fixed.

### 3c. One rule decides a round's played instant

A single domain function reads the log and answers *when was this round played*: the latest
`round-date-set` by HLC, else `round-created.playedAtMs`, else the genesis event's `hlc.wallMs`.

Both callers use that one function — `reduceRound` (so the live round page can show and edit it)
and `createdAtMsOf` (so the projector stamps the same instant onto every participant's line).
Two implementations of this rule would let a live round and its own archive disagree about what
day it was.

### 3d. Frozen at finalize

The snapshot is a sealed leaf. There is no editing the date afterward, and this arc adds no
reopen path.

## 4. The form

`CreateRoundPage` gains one **Date played** field, defaulting to today. Always visible — no
"was this a past round?" disclosure, no second mode. A retroactive round is not a different kind
of round; it is a round with a different date, which is the whole simplification this design
rests on.

Two cases, and the distinction matters:

- **The chosen date is today** (in the browser's local zone): send **nothing**. The server stamps
  the genesis clock exactly as it does now, so a live round keeps its real instant — and with it
  the real tee time that `roundLabel`'s collision disambiguation appends ("· 7:58a").
- **The chosen date is earlier**: send **local noon** on that day. A date is not an instant, and
  noon is the value that stays inside the intended day under every reading — no DST edge, no
  UTC rollover putting a Friday round on Thursday.

Accepted consequence, stated rather than hidden: two back-dated rounds at the same course on the
same day both render "· 12:00p" and do not disambiguate. That is the same tolerated class as
today's `createdAt === undefined` rounds, which render a bare course name.

The round page shows the date with an Edit affordance in the roster-strokes-editor idiom (Edit
swaps the static value for an input, Save is `btnSecondary`, api-then-`sync()`, no optimistic
write).

## 5. Bounds

On the **request schemas only**, never the stored event arm — Arc A's placement rule (a bound
on a stored/fold path rejects already-stored data on a read).

- Not more than one day ahead of the server's current time. You cannot have played tomorrow; the
  day of slack tolerates every timezone offset without the server needing to know the client's.
- A floor of 2000-01-01, which is a sanity bound on a typo, not a product limit.

## 6. Crew seasons: a back-dated round counts where it was played

**No guard, no warning.** A crew season is a name and two chosen dates, reading FINAL once today
is past `endsAt`. A round entered in August but played in March lands in the spring season, and
that season's standings move after it read as settled.

That is correct. The crew's standings are a read fold over its members' lines — nothing is
precomputed, nothing is stored — so a March round genuinely belonging to March is the whole
point. The alternative is dropping real golf out of the record to protect a board's appearance.

What FINAL means is therefore *"no more rounds can be played into this window,"* not *"these
numbers will never move."* That was already true — a member joining or leaving a crew moves a
closed season's standings, because membership is aggregation scope.

## 7. Testing

- **Domain**: the one played-instant rule — absent everything falls back to the genesis wall
  clock; `round-created.playedAtMs` wins over it; the latest `round-date-set` by HLC wins over
  both; an out-of-order (HLC-earlier) set does not win. A round-created log with no `playedAtMs`
  key folds exactly as before (the no-migration pin).
- **Domain**: `createdAtMsOf` and `reduceRound` return the same instant for the same log —
  asserted directly, so the one-rule invariant cannot silently fork.
- **Contracts**: `playedAtMs` round-trips; a future date and a pre-2000 date are both rejected;
  a `round-created` event stored without the key parses.
- **Application**: `setRoundDate` appends while live and refuses a finalized round; a
  non-participant is refused.
- **Projection**: an archive whose log carries a `round-date-set` projects lines stamped with
  that instant, not the genesis clock.
- **Web**: choosing today sends no `playedAtMs`; choosing an earlier day sends local noon on that
  day; the round page's Edit posts once and re-syncs.
- **e2e**: create a round dated three days back, finalize it, and assert the history row's
  `createdAt` and the rendered `roundLabel` both name that day — the full path from form to
  sealed snapshot to projection to screen.

## 8. Deploy

Lambda-first. `playedAtMs` is optional on the request, so an old bundle omitting it is exactly
today's behaviour; a new bundle posting to `POST /rounds/{roundId}/date` against an old lambda
would 404. No wipe — every change is additive and old logs fold unchanged.
