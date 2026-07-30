# swng Field-Test Kit

> Status: **shelf-ready, unscheduled.** Written 2026-07-11 as part of M9's close-out
> (`implementation-plan.md` M9 Task 7). This document gates nothing — M9 closes without
> anyone running it. It exists so that when the owner decides the app has stopped being a
> toy and triggers **M10** (`implementation-plan.md`), there is a real, printable checklist
> ready on day one instead of an improvised one. It's equally usable earlier, informally, for
> casual dogfooding on the hosted beta URL — nothing here requires waiting for M10.

## What this is

A checklist for a real round (or, per the v1 bar below, a real month of rounds) played by a
real crew on the hosted beta app — not an automated gate, not a pass/fail script. Its job is
to catch what `pnpm e2e:field` structurally cannot: whether the app actually feels like golf
in someone's hand, on a real tee box, in real sun, with a real group waiting on the guy who's
still fumbling with his phone.

Print it, or pull it up on a phone before you leave the house — either works.

## Before you go

- **A crew.** The v1 bar (below) is written against a crew of 8 running its standing game for
  a month; any real group is worth testing with, but bigger and more repeated is more honest.
  Include at least one first-timer who plays the role of `product.md`'s "the holdout" —
  someone who has never used swng and signs up on the first tee through the round's join link
  (owner call, 2026-07-13: everyone on a card is a real account — there are no ghosts). Time
  that: tap the link, create the account, answer the one name prompt, land on the card. After
  that a teammate can keep their whole card (anyone scores for anyone), so the holdout never
  has to touch their phone again all round if they don't want to.
- **Phones, not laptops.** The hosted beta URL is **https://d5qqgppnyb7y1.cloudfront.net/** —
  no dev server, no `pnpm -F @swng/web dev`, no laptop on the cart. Everyone brings their own
  phone, or one person keeps the whole card — both are supported; test both if the crew is
  big enough to split across two rounds.
- **A real course.** Search for it first. If it's not in swng yet, budget the add-and-verify
  flow before you tee off — `roadmap.md`'s own M6 gate is "enter a real course from its paper
  scorecard in under 10 minutes," so bring the paper card (or a phone photo of it) and time
  yourself. Doing this the night before is fine; doing it live on the first tee is the harder,
  more honest test.
- **A crew already exists, or create one.** If this is the first real Saturday, create the
  crew, add its members (accounts only), and set up a season for the round to count into. A
  crew has no saved standing game (owner call, 2026-07-13: a crew is a grouping, not a preset)
  — each round's games are chosen fresh at setup.
- **Charge phones.** Obvious, but a dead phone mid-round is the one failure mode this kit
  can't distinguish from an app problem.

## Pre-round checklist

- [ ] Course found by search (or added + verified from the paper card — note the time it took)
- [ ] Crew exists with the right roster (accounts only — the holdout signs up on the first tee)
- [ ] Games are set up fresh at the card without a fight (there is no "play the usual" preset)
- [ ] Every player has a tee, and has stated what they normally shoot relative to par (or been
      given strokes directly), before the first tee shot
- [ ] Dots are visible on the card before anyone swings — the first-tee negotiation should
      already be over

## On-course checklist

Watch for these across the round, not just on one hole — the point is whether they hold up
for 18 holes with a group standing around, not whether they work once in a demo.

- [ ] Every score, for anyone in the group, is two taps — time it if it starts to feel like
      more
- [ ] Picked-up and conceded work naturally, not as an error state or a workaround
- [ ] The app never makes the group wait — `roadmap.md`'s bar is **≤ 20 seconds per hole**;
      if any hole blows past that because of the app (not the golf), write it down
- [ ] Game state is legible at a glance — everyone can answer "where do things stand right
      now?" without asking a teammate or opening a menu
- [ ] Each game's standing is one tap away on its own chip on the card — pulled up when
      someone wants it, never pushed as a popup (there is no between-holes digest)
- [ ] **Offline stretch:** deliberately go offline for a hole or two (a real dead cell zone
      counts double) — scoring keeps working, and it converges cleanly once signal returns,
      with nothing lost or duplicated
- [ ] The holdout's scores, entered by a teammate the whole round, post and look right — once
      they've signed up on the first tee they're a real account like everyone else on the card

## After the round

- [ ] Finalize completes without a fight — every game resolves, or an unresolved one
      terminates cleanly with an honest reason shown, not a raw error
- [ ] The archived card reads like a scorecard — dots, results, and standings all correct
      against what actually happened
- [ ] Each player's round shows up on their own record — the score, its figure vs par, and the
      average on their profile moving to include it (a round with a pickup has no score and
      correctly moves nothing)
- [ ] The crew's season ledger (standings, head-to-head) updates correctly for this round
- [ ] **Share link:** copy it and send it to someone who was NOT in the round, on a device
      that has never signed in — confirm they can watch (or, after finalize, see the archived
      card) with zero setup on their end

## The v1 bar — what "passed" actually means

Pulled straight from `roadmap.md`'s v1 scope — this kit exists to test these four claims, not
to substitute for them. A single Saturday can surface problems; only a real month proves the
bar is met:

1. **A crew of 8 runs its standing game for a month with zero paper and zero spreadsheet.**
2. **The app earns ≤ 20 seconds per hole and never makes the group wait.**
3. **Strokes are trusted enough that the first-tee negotiation actually ends.**
4. **The member who'd never installed the app signs up once on the first tee and is fully present in every card and ledger from that round on.**

If a Saturday (or a month of them) doesn't clear these, that's the finding — not a reason to
call the app done anyway.

## Findings ledger

Log everything, including small stuff — nits compound, and a papercut nobody wrote down is a
papercut that gets rediscovered from scratch next time. Severity guide:

- **Blocker** — stopped play, corrupted a score, or lost data. Fix before the next round.
- **Rough** — worked, but broke the 20-second rule, needed a workaround, or confused someone.
- **Nit** — cosmetic or trivial; no functional impact.

| # | Date | Round / hole | What happened | Severity | Follow-up | Status |
| - | ---- | ------------- | -------------- | -------- | --------- | ------ |
| 1 |      |               |                |          |           | open   |
| 2 |      |               |                |          |           | open   |
| 3 |      |               |                |          |           | open   |

Add rows as needed. Copy the finished table into the follow-up write-up when a field test
wraps — UX and product-shape findings belong in `docs/papercuts.md`; correctness defects get
fixed directly, not parked here; anything that blocks the v1 bar becomes M10's own fix list
before the bar is re-run (`implementation-plan.md` M10).

## What this kit does not do

It does not gate M9 — M9 closes on `pnpm validate`, `pnpm e2e:beta`, `pnpm e2e:field`, and a
controller flow-walk, none of which need a real course or a real crew. It does not gate M10
either, except in the sense that M10's own goal (`implementation-plan.md`) *is* running this
kit for real and clearing the v1 bar. Running it earlier and informally — one round, whenever
the owner feels like it — is encouraged and welcome; it just doesn't have to happen for
anything else in this project to proceed.
