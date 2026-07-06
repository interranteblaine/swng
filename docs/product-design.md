# swng.golf — Product Design & Quintessence

> The product north star. Where [`backend-design.md`](./backend-design.md) says *how the system is
> built*, this says *what swng is and why it deserves to exist*. Every technical decision should be
> traceable to a promise made here.

---

## The quintessence

**swng is the group's living scorecard — instant, shared, and self-scoring.**

Four golfers walk to the first tee. In the time it takes to pull a driver, one of them starts a round
and reads out a four-character code. The others tap it in. From that moment there is one scorecard, and
it is alive on every phone in the group. Anyone can enter a score; everyone sees it instantly. It works
on the back nine where there's no signal. And it quietly does the golf math nobody wants to do in their
head — par, strokes, handicaps, net, the skins, the match — so the players just play.

That's the whole thing. Everything else is in service of it.

The paper scorecard has survived a century of "golf apps" because it is instant, shared, and demands
nothing. It also can't add, can't sync, gets wet, and gets lost. swng is the paper scorecard with those
four flaws removed — and *only* those four. It keeps the paper card's virtues (start in seconds, no
account, the whole group trusts one card) and adds the three things a phone is actually good for: it
does the arithmetic, it's live on every device, and it remembers.

---

## Who it's for

**The foursome, first.** The primary user is not a lone golfer — it's a *group*, and the product's job
is to be the shared surface between them. One person starts it; the value only exists because the others
join. swng is multiplayer by nature, which is exactly why the join has to be frictionless enough that the
least tech-inclined member of the group succeeds on the first tee, one-handed, without an account.

Three roles, one product:

- **The marker** — whoever is entering scores (often one phone for the group, sometimes each for
  themselves). Needs entry so fast and thumb-friendly it beats a pencil.
- **The group** — everyone else, watching the card update, checking the match, seeing where they stand.
  Needs it to be *live* and *legible* at a glance in bright sun.
- **The organizer** — the person running a weekend Nassau, a league night, or a club tournament. Needs
  to gather many cards under one competition and see a leaderboard that's correct without a spreadsheet.

**Casual and tournament are not two products or two markets — they're the same scorecard at different
magnifications, for the same golfers.** The foursome in a Saturday Nassau is the league on Wednesday and
the field at the member-guest; seriousness even shifts within a single day ("back nine for $5"). So swng
never makes the user *declare* seriousness up front: every round starts frictionless and anonymous, and
identity, handicaps, formats, and full tournament structure are added **progressively — even mid-round —
without restarting.** "Casual-first" is a statement about *sequence and acquisition* (win the foursome,
and their league and club follow bottom-up), not about who the product is for.

The one genuinely open question is *monetization*, and it's additive, not a fork: casual play is likely
free forever — the acquisition engine and the network's oxygen — with revenue coming from
organizers/clubs/leagues and premium individual features (deep stats, official handicap sync). Who pays
is not who's served.

---

## The core loop — the one thing we must nail

```
   start (seconds, no account)  →  share a code  →  they join  →  enter scores (fast)
        ↑                                                              │
        └──────────────  it's live on every phone, and it scores itself ───────┘
```

If this loop is not *effortless* and *trustworthy*, nothing else matters. A tournament module on top of a
scorecard that's annoying to enter or that people don't believe is a mansion on sand. So the product's
non-negotiable core is: **fast entry, live sync, correct math, zero setup.** We earn the right to build
everything else by making this loop better than a pencil.

---

## Product principles

The opinionated stances. These are the tie-breakers when two features compete.

1. **Frictionless beats featureful.** The default path — start a round, score it, share it — must never
   require an account, a tutorial, or a setting. Signup is a reward we offer for wanting *more* (history,
   handicap, tournaments), never a toll we charge to play. Anonymous play is a first-class, permanent
   citizen, not a demo mode.

2. **Live by default.** There is one card and it is shared. A score entered on one phone is on all of
   them before the player has re-holstered it. "Refresh to see" is a failure. The group's shared reality
   is the product.

3. **On-course reality wins over the demo.** Golf happens where the signal doesn't. The product must feel
   identical with no bars as with five: you enter scores, they persist, they sync when the world comes
   back. An app that only works on the clubhouse wifi is not a golf app.

4. **The card does the math, silently.** Players should never compute a net score, count Stableford
   points, or argue about who won the skin. The moment strokes go in, the standing is right — gross, net,
   match, skins, whatever the round is playing. The arithmetic is the app's job, not the golfer's.

5. **One phone or four — both are the shared card.** A group passing one phone and a group each on their
   own must produce the same single, trusted scorecard. We design for the messy social reality (someone's
   battery dies, someone joins on the 4th) rather than a clean one-device-per-player fiction.

6. **Grows with you, same core — never declared up front.** A throwaway Saturday round, a season-long
   league with handicaps, and a club championship are the *same scorecard* with widening rings around it.
   We do not fork the product by seriousness and we never ask the user to choose a mode at the first tee;
   structure is applied *progressively — even mid-round — without restarting*, so the casual round can
   quietly become a competitive one.

7. **Legible at arm's length, in the sun, one-handed.** Every screen is judged by whether a 55-year-old
   can read it at a glance on the 12th tee without reading glasses. Big, calm, high-contrast, thumb-
   reachable. The scorecard is a glanceable instrument, not a dashboard.

8. **Trust is the feature.** It's the group's official record and often their money. Scores don't
   silently disappear, get overwritten without a trace, or disagree between phones. Correctness and
   durability aren't polish — they're the product.

---

## Experience pillars

Five surfaces, each earning its place by serving the core loop or a natural expansion of it.

- **On-course entry** — the beating heart. One hole at a time, huge tap targets, the whole group's
  strokes enterable in seconds. This is where the product is won or lost, and it gets the most design
  attention by far.

- **The living scorecard** — the classic golf grid (players × holes, out/in/total), live, with par and
  net rendered so the state of the round is readable at a glance. The shared source of truth the group
  gathers around.

- **The competition view** — who's winning, by how much, in the format being played. Relative-to-par for
  the casual round; the match status, the skins ledger, the net leaderboard when there's a game on.
  Casual golfers bet — skins, Nassau, match — and settling it automatically is a genuine reason to open
  the app over a pencil.

- **Identity & history** — for those who opt in: a profile, a handicap index that improves as you post
  rounds, and a record of every round you've played. This is the payoff that converts a guest into a
  member: the app remembers, so your golf accumulates into something.

- **Events** — the organizer's surface: group many rounds under one competition with a shared format and
  a leaderboard that's correct on its own. The league night and the club tournament, without the
  spreadsheet.

---

## What swng is *not*

Quintessence is as much refusal as intention. swng is deliberately **not**:

- **A rangefinder / GPS / shot-tracker.** We are the *scorecard*, not the caddie. Distances, shot
  dispersion, and club recommendations are a different product with a different sensor budget and a
  different attention model (heads-down analysis vs. glance-and-go). Staying out of it keeps us fast.
- **A swing analyzer or coaching tool.** Not our loop, not our moment. The golfer using swng is *playing*,
  not studying.
- **A tee-time marketplace or booking platform.** We start when the group reaches the first tee. Booking
  is a business we don't need to be in to own the scorecard.
- **A social network.** The group *is* the social graph, scoped to the round. We are not chasing feeds,
  followers, or content. The connection is the golf, not the app.
- **A serious-only handicap authority.** We compute handicaps to make competition fun and fair, not to be
  a golfer's official governing-body record. Useful, not bureaucratic.

Each "not" is a decision to stay deep on the one thing rather than shallow on ten.

---

## The arc

The same core, expanding outward. Nothing here is a different product — each ring adds a reason to sign in
without ever taxing the ring inside it.

```
        ┌───────────────────────────────────────────────┐
        │   Events — leagues & tournaments, one leaderboard │
        │   ┌───────────────────────────────────────────┐ │
        │   │  Competition — handicaps, net, skins, match │ │
        │   │   ┌───────────────────────────────────────┐ │ │
        │   │   │  Identity — profile, history, index     │ │ │
        │   │   │   ┌───────────────────────────────────┐ │ │ │
        │   │   │   │  THE ROUND — instant, shared, live │ │ │ │
        │   │   │   │  (anonymous, no account, offline)  │ │ │ │
        │   │   │   └───────────────────────────────────┘ │ │ │
        │   │   └───────────────────────────────────────┘ │ │
        │   └───────────────────────────────────────────┘ │
        └───────────────────────────────────────────────┘
```

- **The round** — the free, anonymous, always-works center. Most sessions never leave here, and that's a
  success, not a funnel leak.
- **Identity** — opt in and the app starts remembering you: your rounds accumulate, your handicap forms.
- **Competition** — with identity and handicaps, the friendly game scores itself: net, skins, the match.
- **Events** — organizers gather rounds into leagues and tournaments with a real leaderboard.

We grow a user by making the next ring *worth it*, never by locking the current one.

---

## The feel — north star

When it's right, swng is **invisible**. The group barely notices they're using an app; they notice they
never argued about the score, never did the math, never lost the card, and knew who won before they
reached the clubhouse. It feels less like software and more like the round simply *kept track of itself*.

The bar, in one line: **a golfer who has always used a pencil should switch after one round — and never
think about the app again, because it never gets in the way.**

---

## How the architecture keeps these promises

The product bets above are not aspirations bolted onto an indifferent backend — they are the reason the
[system](./backend-design.md) is shaped the way it is:

- *Frictionless, anonymous-first* → **everyone is a `User`, guests included**, so playing needs no account
  yet nothing is a second-class citizen.
- *Live by default* → an **ordered event stream** puts one shared card on every device in real time.
- *On-course reality* → an **offline-first write queue** means scores persist with no signal and sync when
  it returns.
- *The card does the math* → a **pure scoring engine** (net, Stableford, match, skins) that runs the same
  on phone and server, so standings are instant and correct.
- *Grows with you* → **identity, handicaps, and events** are first-class in the core, so the casual round
  and the club tournament are one product, not two.

Read this document for *why*; read the backend design for *how*. If they ever disagree, this one is the
promise and that one has a bug.
