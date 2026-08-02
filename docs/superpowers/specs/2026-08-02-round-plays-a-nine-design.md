# A round plays a nine

> Status: **proposed** (2026-08-02, owner design session). Scope: `@swng/domain`,
> `@swng/contracts`, `@swng/application`, `@swng/client`, `apps/infra-cdk` (one route),
> `apps/web`. No migration, no wipe — every stored round folds unchanged.
>
> **BETA ONLY — no prod deploy in this arc** (owner call, 2026-08-02). `swng-prod` keeps
> serving its current build and is not touched. That is clean rather than merely deferred:
> the arc adds no required field and no migration, so prod's rounds are already correct under
> its own build, and a later prod deploy needs nothing from this arc but the deploy itself.

## 1. The problem

Two people play the back nine at Casa Verde on league night. Casa Verde is an 18-hole course.

There is no way to say so. A round's holes come from the card it froze, and a card is the whole
course. The round is enterable — you type nine scores and finalize — but it is wrong in two
different registers, and the quieter one is the serious one.

**Dots are silently mis-allocated.** `allocateStrokes` puts a dot wherever `strokeIndex <=
strokes`, counted across the whole card. Type 5 strokes on an 18-hole card and the dots land on
stroke index 1–5 *of eighteen*. Play only the back nine and you receive whichever of those five
happen to live there — and since cards conventionally run odd stroke indexes on the front, the
back nine gets the short end. You typed 5 and you play with about 2. Nothing says so. The dots
render, they look authoritative, and net skins and the match settle on them.

**The record is hollow.** `archiveGolferLine` reports `holes: 18`, `par: 72`, and nine hole
results. `hasCompleteScore` wants eighteen, so there is no gross, no Best 9, and no contribution
to your average. The round happened and counts nowhere.

And with games added, it cannot be finalized normally at all: stroke play, Stableford and skins
require every hole on the card, so the group must reach for "End unfinished games & finalize" —
throwing the games away — to seal a round they actually completed.

## 2. Why the workaround loses

The alternative that exists today is to enter the front nine as its own course. It works, with no
code, and it fixes the dots correctly. Two things are wrong with it.

**It cannot be a card — it is a second course.** Stroke index must be a permutation of `1..N`
(`course.ts`) and every tee in a card must share a hole count, so a nine-hole version of Casa
Verde cannot live in Casa Verde's lineage. It is a separate course record, and its stroke indexes
must be re-ranked 1–9 by hand, because the paper card says 1, 3, 5 … 17. The course model's claim
is *transcription, not authority* (course-cards spec §2); this is the one place a person authors
numbers that are printed nowhere.

**It fragments a real course, permanently.** Which holes you played is a fact about the *round*,
not about the course. Casa Verde is one place. Split it into three and your record there, your
per-hole insights, "courses you've played", and the crew board divide by an artifact of data
entry — for everyone who ever picks the wrong Casa Verde out of search. That is the same class of
error this repo has ruled on before: the round is a sealed leaf, and a crew is a grouping, not a
preset. Round facts do not get welded into the identity of another noun.

## 3. The model

**A round records the holes it set out to play.** One fact, stored on the round.

It is a *plan*, not an outcome, and that is forced rather than chosen: stroke allocation depends
on the hole set, so the set has to be fixed before the first score, or the dots shift under the
players while they enter them.

What actually got scored is the other half, and it needs nothing new — the golfer's decided cells
already are it, and `hasCompleteScore` already compares the two. Splitting these was the design's
turning point: the card was standing in for both.

```ts
export type HoleSelection = "all" | "front" | "back";
```

`front` is the first nine holes in card order, `back` the second nine. On a card with one nine
**every selection resolves to that nine** — there is no error case, because "we played nine holes
at a nine-hole course" is a true statement, not a contradiction.

So nothing on a read path ever validates this, and that is the load-bearing part: a guard there
would make a stored round permanently unreadable, which Arc A's placement rule already forbids.
The control is never offered at a nine-hole course, and `startRound` rejects a nine selection
against a one-nine card — not because the value is dangerous, but so no round can be stored
carrying a "Back 9" label its course cannot have. That check lives at the one door where the card
is already in hand, and it happens once.

### 3a. Where it lives

- `round-created` gains `holes?: HoleSelection`. **Absent means the whole card.**
- `RoundState.holes: HoleSelection`, always defined, defaulting to `"all"`.
- `RoundArchive.holes?: HoleSelection`, written only when it is not `"all"`.

Optional, unlike `playedAtMs`, and the distinction is real rather than convenient: an absent
`playedAtMs` meant a *missing fact* that had to be invented, so it was made required and every
round migrated. Here absence is a *true statement* — every round ever played played its whole
card. This is the `departed?: true` rule (absence IS the default), so every stored round, every
snapshot and every golden fixture folds byte-identically and **there is no migration**.

### 3b. Changeable while live

```ts
| { readonly kind: "round-holes-set"; readonly holes: HoleSelection }
```

Latest-HLC-wins. `POST /rounds/{roundId}/holes`, participant auth, any participant may set it,
server-minted envelope, `round-not-live` gated — `setPlayedAt`'s shape exactly.

This is not a nicety. Going out for nine and playing on is the normal case, not the error case,
and the alternative is scrapping a live round and re-entering it. **Nothing scored is ever lost**:
cells are keyed by hole number and the hole set is a filter over them, so front → all restores
holes 10–18 exactly as they were typed.

### 3c. One function

```ts
intendedHoles(teeSet, selection) -> readonly Hole[]
```

Total. Every walk that today reads `teeSet.holes` for a round reads this instead. Two things
actually ask the question — **how dots are allocated** and **whether the round is complete** — and
everything else in §4 is downstream of those two.

### 3d. Allocation must rank, not read raw

`allocateStrokes` assumes stroke index is a permutation of `1..N`, which is false for a nine
drawn out of an eighteen (the back nine carries 2, 4, … 18). It must **rank the holes being
played by stroke index** and allocate hardest-first over that ranking.

On a full card rank ≡ stroke index, so this is **byte-identical for every round that exists** —
pinned as a test, because it is the one change in this arc that touches numbers on rounds that
have nothing to do with nines.

## 4. What derives

| | today | after |
|---|---|---|
| card grid rows | all 18 | the nine, holes 10–18 |
| OUT / IN / TOT | three rows | one TOT row (existing 9-hole behaviour, free) |
| dots | ~half your strokes, scattered | all of them, on the hardest of the nine played |
| stroke play / Stableford / skins `complete` | needs 18 | needs the nine |
| match `holeCount`, dormie, closing ("3&2") | counts 18 | counts 9 |
| finalize readiness | lists holes 10–18 as unscored | lists only what is genuinely open |
| `line.holes` / `line.par` | 18 / 72 | 9 / 36 |
| `line.score`, Best 9, the average | absent, nothing, nothing | real gross, contends, counts doubled |

The record wire does not change. `holes` and `par` were always derived — from the wrong hole set.

## 5. The 13-hole round: already correct, and untouched

You set out to play 18 and stop after 13. Intended is 18; scored is 13. **That is exactly today's
behaviour and this arc changes nothing about it** — which is the right outcome:

- Your **hole results are real**: birdies, your per-hole record at that course, all of it counts.
- You get **no round score**, because 13 holes is not one. No Best, no average contribution.
- The round **finalizes**: matches resolve on their own if mathematically decided (6 up with 5 to
  play is over), and anything genuinely unfinished goes out through the existing "End unfinished
  games & finalize".

One correction to something said earlier in the design session: skins and Stableford do **not**
settle "as they stood" over a short round — they require every intended hole, so they are ended,
not settled. Making a short round settle its games as they stood is a real improvement and it is
**not in this arc**; matches already behave that way, the others would need engine work with its
own design.

There is deliberately no 13-hole record class. A 13-hole gross contends with nothing, and
`line.holes` staying `9 | 18` is what keeps a nine out of Best 18 and doubles it into the average
correctly.

## 6. The surfaces

**Create a round.** One control after the tee: **18 · Front 9 · Back 9**, defaulting to 18. Shown
only when the selected card has 18 holes; at a nine-hole course there is nothing to ask.

**The live round.** The choice is shown with an Edit affordance in the roster-strokes idiom (Edit
swaps the value for the control, Save is `btnSecondary`, api-then-`sync()`, no optimistic write).

**Joining.** `PeekRoundResponse` gains `holes?`, so the join screen can say which nine it is before
you commit a tee.

**Everywhere else is free.** The 9-hole treatments already exist — the grid's single TOT row, the
history row's nine-hole rendering, Best 9, the doubled average — because after this the line
genuinely says nine.

## 7. Out of scope, named

- **Shotgun starts** (you begin on hole 7 and play all 18). The same class of fact and it extends
  cleanly — order matters only to the skins carry and match closing — but it is a later arc, not
  a problem yet.
- **A nine-hole course played twice for 18.** This is a hard wall, not a scoping choice: a score
  is stored per golfer per *hole number*, so hole 3 played twice needs two slots and there is one.
  Fixing it means changing cell identity across the fold, the events and offline sync. Here the
  duplicate-course workaround is genuinely the right tool — an 18-hole course record with the
  nine written out twice.
- **Games settling as they stood over a short round** (§5).

## 8. Deploy

**Lambda-first, required.** `startRoundRequestSchema` is not `.strict()`, so a new bundle sending
`holes` to an old lambda has it silently stripped — the golfer picks Front 9 and gets an
eighteen-hole round with no error anywhere. The reverse (old bundle, new lambda) is inert: it
never sends the field and every round it creates is `"all"`, which is what it means today.

No migration, no wipe, no rebuild: absence already means the whole card.

**Beta only.** `deploy:prod` and `publish:web:prod` are not run in this arc. Nothing about that is
load-bearing on prod's side — no stored prod round changes meaning, and no prod read path starts
requiring a field — so the two stages simply diverge by one feature until prod is deployed on its
own schedule.

## 9. Testing

- **Domain, the resolver**: `all`/`front`/`back` over an 18-hole tee; every selection over a
  9-hole tee returns that nine (the case that must never throw).
- **Domain, allocation**: dots land on the hardest of the holes played, by rank — a back-nine
  fixture whose stroke indexes are 2, 4 … 18 gets all its dots, on the right holes. And a
  **byte-identical pin** on a full card against today's output.
- **Domain, the fold**: genesis default; a later `round-holes-set` wins; an HLC-earlier one does
  not; two resolve by HLC, not arrival order.
- **Domain, cells survive**: front → all restores holes 10–18 scores untouched.
- **Domain, settle**: the archive carries `holes` only when it is not `"all"`; an archive without
  it settles and reads as the whole card.
- **Domain, the record**: a completed front nine yields `holes: 9`, `par: 36`, a real gross, Best
  9, and a doubled average contribution.
- **Domain, no regression**: intent 18 with 13 scored produces exactly today's line (§5).
- **Domain, games**: stroke play / Stableford / skins complete over the nine; a match's closing
  arithmetic counts nine holes remaining, not eighteen.
- **Application**: `setHoles` appends while live, refuses a finalized round, refuses a
  non-participant; `startRound` rejects a nine selection against a one-nine card.
- **Contracts**: `holes` round-trips on `round-created`, the correction request and the peek; a
  `round-created` without it parses as the whole card (the no-migration pin).
- **Web**: the control is absent at a nine-hole course; the grid draws the intended holes; Edit
  posts once and re-syncs.
- **e2e**: play a back nine at an 18-hole course end to end — dots on the hardest of those nine,
  finalize with a real game settled, and a history row reading nine holes with its gross.
