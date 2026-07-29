# Strokes from what you shoot relative to par

> Status: **approved** (2026-07-29, owner design session; revised 2026-07-29 after an
> adversarial review — see §11). Supersedes the handicap model in
> `2026-07-15-unrated-courses-handicap-model-design.md`,
> `2026-07-16-handicap-index-strokes-model-design.md`,
> `2026-07-16-handicap-index-source-model-design.md`, and
> `2026-07-17-index-source-one-tap-commit-plus-handicap-design.md` on the model and every
> surface those specs touched. Beta only — no prod deploy in this arc.

## 1. The problem

Today a score becomes strokes through seven numbers, six of them invisible:

```
gross → AGS (net-double-bogey cap) → differential (×113/slope, −rating)
      → index (best 8 of last 20, to 0.1) → course handicap (×slope/113, +rating−par)
      → playing handicap (×95% / 90% / 100%) → dots by stroke index
```

Only the last is in a unit a golfer speaks. Owner field report: a group played by asking each
other *"for an average round, how do you shoot relative to par?"* — `+30` and `+10` — and took
the difference, 20 and 0. That is one conversion in the unit everyone already uses on the first
tee, and it is what swng should do.

Two supporting facts, checked before deleting the machinery:

- **Rating and slope mostly cancel in relative play.** Strokes are a difference. A course that
  plays 4 harder raises both players' numbers by ~4 and leaves the difference unchanged. The
  residual is slope's spread-amplification — a 20 vs a 5 at slope 130 gives 17 instead of 15.
- **Potential vs. typical also mostly cancels.** WHS's best-8-of-20 measures potential; "what I
  usually shoot" measures typical. Both players shift by roughly the same amount. Where it
  doesn't cancel it favours typical: high handicappers have a bigger potential gap, which is the
  "I need a career day to beat him" complaint. Typical makes casual matches closer to a coin flip.

## 2. The model

**One number per golfer: what you normally shoot relative to par, as a plain integer over 18
holes.** `+30`. `+10`. `E`. `−2`.

It is not converted. The number a player states is the number the strokes come from.

### 2a. What a player asserts is an object, not an integer

```ts
export type StrokeBasis =
  | { readonly kind: "normally-shoots"; readonly overPar: number }
  | { readonly kind: "strokes"; readonly strokes: number };
```

Two constructors, one object. A group saying *"just give him 18"* is the second kind of
statement, not a fudge of the first — so nobody ever has to distort a true fact about themselves
to get the strokes they want. This is the shape that dissolves the false choice between "edit
your +30" and "edit your 20".

### 2b. Strokes are derived, never asserted

Strokes fall out of the fold across the roster, the way scores fold into standings. One rule:

> **Strokes are the difference from the lowest in the field.** The anchor is the lowest stated
> `normally-shoots` among **present** players. A player who stated a normal score gets
> `theirs − anchor`. A player who stated strokes gets exactly what they said, and never enters
> the anchor.

**The field is whatever you are looking at.** The card's field is the round's present roster; a
game's field is that game's players. Same rule, no exceptions, no percentages.

**A departed player is not in the field.** `reduceRound` keeps departed seats on the roster
(their scored holes still settle), but they are excluded from the anchor. Without this, someone
who joins the wrong round at `+2` and leaves permanently anchors everyone else's card. Their own
strokes still resolve against the surviving anchor, so their played holes stay netted.

**Nine holes: halve the difference, once, at the end.** Blaine `+30`, his mate `+10`, difference
20, so on nine holes Blaine gets 10. Never halve each player's number first — that rounds twice
for no reason. A literal `strokes` assertion is never halved: it is already a statement about
this round.

The cases this must produce:

| roster | result |
|---|---|
| `+30` and `+10` | anchor 10 → **20 and 0** |
| Blaine flips to `strokes: 18` | **18 and 0**; his `+30` is untouched and still true |
| `+30` and `strokes: 0` | no stated normal score to anchor against but his own → **0 and 0**. Correct, not a failure: strokes cannot be allocated when only one person's level is known, and the fix is visible on screen |
| `+30`, `+10`, and `+2` who has departed | anchor 10 → **20 and 0**; the departed player is not in the field |

A fifth player joining just re-runs the fold. No correction event, no stale number.

**What is stored, precisely:** the *assertion* (`basis`) is what any event carries and any client
sends. The derived `strokes` is fold output — no client ever asserts it and no request body
accepts it. The sealed archive **does** freeze the derived value, because a snapshot must be
self-contained (the sealed-leaf law); that is a record of what was played, not a source of truth
a later fold could contradict.

### 2c. Where the number comes from

- **You state it when you join a round.** Never on the profile. The profile is a reporting
  artifact with no inputs.
- The join field is **pre-filled from your average** (§5) when you have one. No average yet — a
  brand-new golfer, or one whose rounds all contain a pickup — and the field is blank and you
  type it. There is no floor and no fallback chain: one finished round is better evidence than a
  guess, and you can always type over the pre-fill.
- Whatever you state is a fact about **that round**. Changing it changes that round only.

### 2d. Which rounds feed the average

**A round feeds the average only if every hole has a score.** Not a cap, not an allocation, not
an invented number — a card either has a score or it doesn't.

This would kill the model on its own, because concessions are constant in match play and match
play is swng's core case. It doesn't, because `picked-up` and `conceded` are not the same event
and the code already keeps them apart:

- **Conceded** — the hole was decided but you would have finished it. A score exists; the group
  says it out loud. `HoleResult`'s `conceded` arm gains it:
  `{ kind: "conceded"; strokes: number }`. **Scoring engines still ignore the number** (the
  concession already decided the hole, so recording a 5 cannot change a match); the record reads
  it, and so do the card's totals.
- **Picked up** — you stopped. There is no number and nobody pretends otherwise. A round
  containing one does not feed the average, and it cannot set a `Best` either (`fullyHoledOut`
  requires every hole be a stroke count, and always has). It still appears in your history.

Nine-hole rounds count, doubled: 52 on a par 36 is +16 and contributes +32. Imperfect (nines
differ in difficulty, fatigue isn't linear) and accepted, because `product.md` §2 names the
Tuesday-night nine-hole league as a target audience and a model that cannot hold a league
golfer's rounds is broken in a way a two-stroke conversion error is not.

## 3. Games

**No game re-derives strokes from a percentage.** The allowance table is deleted; each game
applies §2b's one rule to its own field and states the result in words in its panel.

**Gross/net is a real choice on stroke play and skins only.**

- **Skins** earns it: gross skins is the most-played skins variant in casual money golf, and a
  group routinely runs gross and net skins as two pots in the same round. `skins` gains
  `scoring: "gross" | "net"`.
- **Match and four-ball** don't: a straight-up match is a match where both sides state the same
  number and the difference comes out zero. It falls out of the model.
- **Stableford** doesn't: it is a handicap format by construction.

Four-ball loses its 90% allowance. That discount exists because a best-ball partner who birdies
one hole is worth more than his handicap suggests; deleting it means four-ball plays off the full
difference. Accepted for a Saturday match, and named here rather than buried.

**Panel copy.** `allowancePhrase` is deleted and replaced by one `gameTreatment(config)` in
`scoring/present.ts` covering every kind, gross included:

| config | line |
|---|---|
| stroke-play / skins, `gross` | `Gross — raw scores, no strokes` |
| stroke-play / skins, `net` | `Net — uses the strokes on the card` |
| stableford | `Net — uses the strokes on the card` |
| singles-match | `Strokes are the difference between you two` |
| fourball-match | `Everyone plays off the lowest of the four` |

A gross game must not render a strokes summary at all — the existing all-zero copy ("No strokes —
everyone plays off 0") is false for a game that has no strokes by definition.

## 4. The card and the finished round

**The card's structure does not change.** Dots still come from each player's strokes, spread by
the card's stroke index (`courseHandicapAllocation`, renamed `roundStrokeAllocation`). Chips
still never touch the grid.

**It gains a totals row**, live and finalized: `OUT` after 9, `IN` after 18, `TOT` — gross and
net per player, par totalled in the hole column. It reads like a scorecard, which today it does
not. **Conceded holes count toward the totals** at their recorded score; a segment containing a
pickup or an unscored hole shows `–` rather than a partial total. Any other rule would make the
finalized card disagree with the same round's line in the golfer's own record.

**The finished round stops speaking WHS.** `— adjusted score 82 · posts 12.3` is replaced by the
card's own totals:

```
Par 72

Blaine    96    −20    76
Ravi      74      0    74
```

Gross, strokes, net. **No fourth column.** Net already ranks players against their own level:
strokes are `stated − anchor`, so `net = gross − stated + anchor`, and par and the anchor are
constants within a round — ranking by net is identically ranking by how far each player beat
their own stated number. A "vs your number" column would repeat it.

**Sign conventions do not mix.** Two live in the product and they are opposites:

- A **handicap** number renders through `handicap/present.ts` — negative means *plus*, better
  than scratch, shown `+2`. This governs the strokes column and the scorecard's dots.
- A **vs-par** number renders through a new domain `formatOverPar` — positive means over par,
  shown `+26`; `E` at zero; `−2` under. This governs the average, history rows, and the crew
  board.

`formatCourseHandicap` must never be handed a vs-par number and `formatOverPar` must never be
handed a handicap: each would invert the other's sign. `formatOverPar` replaces the web's own
`apps/web/src/ui/vsPar.ts` so there is one copy, in the domain, and the plus-handicap grep gate
gains it as a sanctioned renderer.

**The ScorePad** posts a plain score in two taps, unchanged (`product.md` §9). Conceding is a
deliberate, rarer act and costs three: cell → `Conceded` → the number you would have made. Stated
here as a considered deviation rather than an oversight.

## 5. The record

**The profile is a reporting artifact only** — no number to set, no source to pick, no edit box:

```
What you shoot                    +26
                                  your last 10 finished rounds, score minus par

Casa Verde GC · white   Jul 22     100    +28
Casa Verde GC · white   Jul 15      97    +25
Sandy Hollow · blue     Jul 8       52    +16   (9 holes, counts +32)
...
```

Ten rows and one number, and you can add them up yourself. No extra column: the headline states
the average and every row shows vs par, so the subtraction is already on screen.

**The trend chart plots your average over time** — one line, the average as of each round,
replacing the two-line index chart. `+31` in April, `+26` in July. Only rounds that contribute
get a point; a round with a pickup is not a data point.

Another golfer's page is identical.

## 6. The crew board

```
              Rounds   Average   Spread   Best
Blaine          12      +26       ±4.2    88 (+16)
Ravi             9      +10       ±2.1    76  (+4)
```

Once every round collapses to one number in one unit, **a golfer's record is a distribution, not
a figure** — which the old index could never be, being a filtered, weighted, slope-scaled point
estimate. So the board describes it:

- **Average** — level. Over **every** finished round in the season window, not a last-10 slice.
  `Rounds 12` and an average of 10 of them would be a lie on the same row. This is the one place
  the window is the season rather than the rolling 10, and the difference is deliberate: the
  profile answers *"what do you shoot"*, the board answers *"what did you shoot this season."*
- **Spread** — standard deviation over the same set, gated at 5 rounds. Not a stat for its own
  sake: it is the most useful competitive fact about an opponent. `±4.2` beats better players
  more often than the averages suggest and loses to worse ones; `±2.1` shoots his number.
- **Best** — ceiling, gated on `fullyHoledOut` as today.

**No adjustment for course difficulty, and no per-course board.** Within a crew, course mix is
shared — a crew plays the same handful of tracks — so an adjustment corrects noise that isn't
there, at the cost of a second unit on screen and a formula nobody can verify. A per-course board
is worse still: for a real crew it collapses to the same numbers as the overall average.

**Comparing two members who never played together is the difference of their averages:**

> **If you played tomorrow, Blaine gets 16.**

It is the same *rule* the round applies at join, over the board's own season numbers. It is not
a promise that the round will produce that exact figure — the round resolves from what each
player states that day, against their career average, and one of them may state something else
entirely. The copy says "if you played tomorrow" for exactly that reason.

This replaces today's board column-for-column: `index` → `Average`, `netPer18` → `Spread`,
`indexDelta` dropped (the trend lives on the profile chart). `netPer18` was also wrong — it
subtracts whatever integer was typed at join, so a player who typed a difference reads several
strokes better than the truth.

## 7. Deleted

Whole, not demoted, with no dormant fields:

- `handicap/whs.ts` in its entirety — `adjustedGrossScore`, `scoreDifferential`,
  `postedDifferential`, `computeIndex`/`computeIndexDetail`, the Rule 5.2a small-sample table,
  `swngIndex`, `courseHandicapFor`, `courseHandicapFromRatingSlopePar`, `unratedCourseHandicap`,
  the 9-hole pairing state and `combineNineHoleDifferentials`.
- `golfer/golfer.ts`'s `IndexSource`, `HandicapProfile`, and `Golfer.handicap`; `resolveIndex`;
  and `handicap/present.ts`'s `indexSourcePhrase`, which takes an `IndexSource["kind"]` and
  cannot outlive it.
- `scoring/allowances.ts` (`defaultAllowance`, `playingHandicap`), `allowancePhrase`, and the
  `allowance` field on all five `GameConfig` arms.
- `scoring/allocation.ts`'s `handicappingFor`; `RoundArchive.handicapping` and
  `FinalizeRoundResponse.handicapping` with it. The results view computes totals from the cells
  it already renders; `archiveGolferLine` computes from `holeResults`.
- `GolferRoundLine.ags` and `.differential`; the "Posted to handicaps" section.
- `metrics.ts`'s `whsIndex`, `swngIndex`, `IndexPoint`'s two-line shape, `indexHistory`'s two
  streams.
- `apps/web/src/ui/vsPar.ts`, absorbed by the domain's `formatOverPar`.
- Rating and slope from every calculation. They stay recorded on the course card — they are
  printed on the real scorecard — and nothing computes from them.
- `product.md` §5's "The swng Index" pillar and §6's "Crew handicaps" bullet, rewritten.

**`handicap/present.ts` survives in part.** `formatCourseHandicap` and `strokeGrant` still apply
— a player can shoot under par, and the whole-tree grep gate forbidding a bare signed render
still holds. `formatHandicapIndex` (a one-decimal index formatter) loses its last consumer with
the index itself and is deleted; `formatOverPar` is added in its place, with the opposite sign
convention (§4).

## 8. Wire, storage, and beta

- `Participant.courseHandicap: number` → `Participant.basis: StrokeBasis`, plus a
  fold-derived `strokes: number` on `RosterEntry`. Every reader that used `courseHandicap` reads
  `strokes`.
- `participant-handicap-set` carries a `StrokeBasis` instead of an integer. Fold rule unchanged:
  a set applies iff HLC-later than that golfer's latest join.
- `JoinRoundRequest.courseHandicap` → `basis`, and the same on `StartRoundRequest`'s host and the
  set-handicap body. Request schemas bound the value; the stored event arm does not (Arc A's
  placement rule: a bound that rejects stored data bricks a legitimate user).
- `HoleResult`'s `conceded` arm gains required `strokes`, bounded at the request ingress
  alongside the existing `strokes` arm.
- `GolferRoundLine`: `courseHandicap` → `strokes`; add `normallyShoots?: number` (absent when the
  player stated raw strokes); drop `ags`/`differential`.
- `GolferMetrics`: `{ average?, spread?, typicalEighteen, averageHistory, bests, milestones }`.
- `GameConfig.skins` gains `scoring: "gross" | "net"`.

**Beta data is wiped** (rounds, snapshots, projections; golfers and crews kept), per the
2026-07-16 precedent. Every stored round's `courseHandicap` is semantically ambiguous under the
new model — some are absolute, some are differences — so there is nothing honest to migrate. No
tolerate-old-data machinery, no migration script beyond the existing
`scrapCourseAndRoundData.mjs`. **No prod deploy in this arc.**

## 9. Language

No coined term. The question at join is *"What do you normally shoot, relative to par?"*; the
measured value is your **average**. "Index", "your number", "your usual", "what you shoot", and
"Form" were each tried in the design session and rejected — the first four for being jargon or
failing as a column header, the last for being opaque and for measuring form rather than the
ability the board exists to compare.

`scoring/present.ts` gains `gameTreatment` (§3) and keeps `strokesNote`, rewritten to name the
field instead of a percentage. `strokesSummary` lives in `apps/web/src/round/dots.ts`, not the
domain, and must render nothing at all for a gross game.

## 10. Out of scope

Official-network posting, any conversion from a GHIN index, per-course comparison boards,
course-difficulty adjustment in any form, and prod deployment.

## 11. Revision record (2026-07-29)

An adversarial review of the first draft found four defects in this document, all fixed above:

1. §2c specified a "fewer than 3 rounds, fall back to the last number you stated" rule that
   nothing stored and no task implemented. **Struck** — there is no floor and no fallback.
2. §2d claimed a round containing a pickup "still counts for `Best`". False:
   `fullyHoledOut` requires every hole be a stroke count. **Corrected.**
3. The sign-convention collision between handicap numbers and vs-par numbers was unstated, and
   the first draft's own mocks used both. **Now §4**, with `formatOverPar` as the one vs-par
   renderer.
4. §6's average was to be folded by the same last-10 helper the profile uses, which would have
   shown "Rounds 12 · Average" over 10 of them, and the "same subtraction" claim overstated what
   the round guarantees. **Both corrected.**

Also added: the departed-anchor rule (§2b), the conceded-holes-count-in-totals rule (§4), the
`gameTreatment` replacement for `allowancePhrase` (§3), and precise wording on what is stored
(§2b) — the first draft's "stored nowhere" was wrong, since the sealed archive freezes the
derived value by design.
