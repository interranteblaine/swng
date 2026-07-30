# Strokes are typed, not derived

> Status: **approved** (2026-07-30, owner design session). Supersedes
> `2026-07-29-relative-to-par-strokes-model-design.md` **on the strokes mechanism only** — that
> spec's record, card, games-treatment and WHS-deletion work stands. Beta only; no prod deploy.

## 1. The problem

The 2026-07-29 arc replaced the WHS handicap pipeline with a derivation: each player states what
they normally shoot relative to par, and the fold computes strokes as the difference from the
lowest in the field.

The owner's own field report is the evidence against it. A group settled strokes by asking each
other *"for an average round, how do you shoot relative to par?"* — `+30` and `+10` — and **did the
subtraction in their heads, then typed 20 and 0.** The conversation about averages is how people
*arrive* at a number. It is not work the app needs to do. Two-integer subtraction is not the hard
part of golf.

For that subtraction, the arc bought:

- a two-armed `StrokeBasis` union, so a player could state either kind of thing
- an anchor rule, and a second rule for which players are in the field
- present-field scoping, so a departed player cannot anchor everyone
- a nine-hole halving rule, and a clamp so strokes cannot go negative
- a join-form question, a pre-fill from the golfer's average, and a mid-round correction event
- a per-game re-anchoring rule, which makes a subset game disagree with the card

It also put a **golfer-level fact** — what you typically shoot — into a **per-round input**. That is
the handicap-index shape wearing new clothes: a number attached to you, carried into rounds,
editable per round, able to drift from the number the system computes.

## 2. The model

**A player's strokes are one integer on the roster. Default 0. Anyone can edit them, any time.**

```ts
export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;
  readonly strokes: number; // ASSERTED, never derived. Non-negative. 0 unless someone sets it.
}
```

Nothing computes it. There is no anchor, no field, no halving, no relative rule, and no second
constructor. The number on the roster is the number a human agreed to and typed.

**One event.** `participant-strokes-set { golferId, strokes }`, author/subject split like
`score-recorded`. It applies iff HLC-later than that golfer's latest join — the same rule the
prior arc's correction event used, unchanged. Any participant may set any participant's strokes,
matching the score-for-anyone trust model.

**Playing alone** is not a special case: strokes default to 0, and you type a number if you want
one. Playing a game against nobody needs no strokes; playing net against par needs whatever you
say.

**Where the number comes from** is the group's business, not the app's. Usually it comes from
comparing what people shoot — which is why §5's record exists and is worth reading. Sometimes it is
"give him one a side." Sometimes it is zeros, because nobody is playing anything. All three are the
same integer.

## 3. Games

**A game uses each player's roster strokes. There is no re-anchoring and there are no allowances.**

The card and every game therefore always show the same dots, and a panel can honestly say the
strokes come from the card.

- **Gross/net stays a real choice on stroke play and skins.** Gross ignores strokes entirely; net
  uses the roster number, spread by stroke index.
- **Stableford** is net by construction.
- **Match play and four-ball** use the roster numbers as-is.

**Traditional match play is off the difference** — a 20 against a 10 plays 10-and-scratch, and that
allocates differently hole-by-hole than 20-and-10. Under this model you get it by typing it: put 10
and 0 on the roster for that match. The app records what was agreed; it does not hold an opinion
about what should have been.

## 4. The card and the finished round

Unchanged from the prior arc. The card carries each player's own strokes as dots by stroke index,
gross over net per cell, and `OUT`/`IN`/`TOT` totals — dashing any segment where a hole has no
score. The finished round reads gross · strokes · net, with no fourth column.

## 5. The record

Unchanged from the prior arc, with one rule made absolute:

**Your average lives on your profile, is computed from your finished rounds, and is never an
input.** `What you shoot: +33`, folded from the last 10 rounds where every hole has a score, a
nine-hole round counting doubled. There is nothing to declare, no bootstrap, no setting, and no
control anywhere that writes it. You read it to decide what to ask for on the first tee.

## 6. The crew board

`Rounds · Average · Spread · Best 18` over the season window, as built.

**The "If you played tomorrow, X gets N" line is deleted.** Both averages are already on the board,
so it only performs a subtraction the reader can see; it names one pair by a rule that is not
visible; and it asserts a hypothetical about a round that is not being played, which the round
itself would override anyway.

## 7. A gimme is a score — `conceded` is deleted

Your opponent says "that's good." Formally they concede your **next stroke**, so your score is
where you were plus one: lying 3 a foot out on a par 4 means you made 4. **The score is never in
doubt, so there is nothing to ask the player.** You tap 4.

The prior arc gave `conceded` a required number so that match rounds could feed the average. But
once it carries a number it *is* a score, and that arc's own tests pin it behaving identically to a
`strokes` cell in every engine, in the card's totals, in the record's distribution and in the
course record. Two variants that must behave identically everywhere are one variant.

The single surviving difference was `fullyHoledOut`, which refused a conceded round the `Best 18`
title and the first-birdie milestone. That gate is also wrong: a 79 with two gimmes is your best
round, and nobody discounts it because the ball did not rattle in from a foot.

So: the `conceded` arm, its pad disclosure, its `what would you have made?` prompt, the `Nc` glyph,
and `fullyHoledOut` are all deleted. **`Best 18` becomes lowest gross.** `picked-up` stays as the
only state meaning "there is no number," and remains the only thing that keeps a round out of the
average.

## 8. The roster row

```
blaine                    Edit
white · 20 strokes
```

Name and one control on the first line, the facts on the second. One `Edit` per player, because
there is now one thing to edit. No "normally +30", no anchor language, no "gets N", and no second
button — the prior arc had two because the *type* had two arms, which let the model's shape leak
into the UI as a choice the user had to make.

## 9. Deleted, whole

- `StrokeBasis` and both its constructors; `resolveStrokes`; `anchorOf`
- the anchor rule, present-field scoping, the nine-hole halving rule, the negative clamp
- `participant-basis-set` → `participant-strokes-set`; `POST /rounds/{roundId}/basis` →
  `POST /rounds/{roundId}/strokes`; `setBasis.ts` → `setStrokes.ts`
- the join form's `What do you normally shoot, relative to par?` question, and the pre-fill from
  the golfer's average — `JoinRoundRequest` becomes `{ code, tee }`, `StartRoundRequest`'s host
  becomes `{ tee }`
- per-game re-anchoring in `gameStrokeAllocation`; the panel copy
  `Net — everyone plays off the lowest in this game` reverts to naming the card
- `HoleResult`'s `conceded` arm; `fullyHoledOut`; the ScorePad conceded disclosure; the `Nc` glyph
- the crew board's head-to-head line
- the roster's `Give strokes directly` control and the `normally +N · gets N` composition

## 10. Boundary and types

Two corrections carried from the prior arc's review, which this arc closes rather than defers:

- **All remaining golf logic moves into `@swng/domain`**, and the ESLint fence is extended to catch
  **re-derivation**, not only imports. The fence previously checked that `apps/web/src` did not
  *import* golf compute; it never noticed the web recomputing a rule inline, which is how
  `SeasonPanel`'s difference rule and `RecordSections`' nine-hole doubling ended up outside the
  core.
- **The stored-data cast is made honest.** `createDynamoEventJournal` asserts stored items into the
  domain type without parsing, so a field the type requires can be absent at runtime. The type must
  not assert what the read path cannot guarantee.

## 11. Wire, storage, beta

- `Participant.basis: StrokeBasis` → `Participant.strokes: number`. `RosterEntry` no longer carries
  a separate derived value.
- Request schemas bound `strokes` (`int`, `min(0)`, `max(54)`); the stored event arm does not —
  Arc A's placement rule, which a bound on a shared stored schema would violate.
- `GolferRoundLine` keeps `strokes`; `normallyShoots` is dropped.
- **Beta round data is wiped again** (rounds, snapshots, projections; courses, golfers and crews
  kept). Stored `participant-joined` events carry a `basis` object that no longer exists in the
  model, and there is nothing honest to translate a two-armed assertion into. No migration, no
  tolerate-old-data machinery.
- No prod deploy in this arc.

## 12. What this is not

It is not a return to handicaps. Nothing computes a number about a player and applies it to a
round. The one number attached to a golfer — their average — is computed from rounds they actually
played, is read-only, and touches nothing. Strokes are a fact about a round that a human typed.
