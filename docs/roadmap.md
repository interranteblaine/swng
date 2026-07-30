# swng — v1 Scope and the Release Arc

> Status: **approved** (2026-07-07; vocabulary corrected 2026-07-30 to match the stroke/average
> model that replaced the WHS index — see `CLAUDE.md`'s own arc record for the change itself;
> scope and sequencing below are otherwise unchanged). Scopes the first shippable slice of
> `product.md` and the order the rest lands. Product altitude only — see `architecture.md` for
> the domain and backend design that carries this arc.

## The scoping principle

v1 must prove the point of view, not ship a smaller scorecard. The irreducible claim of
`product.md` is **everything counts**: format-aware, stroke-aware rounds that write
permanently to golfer and crew records. A v1 that is "the scorecard with more formats" fails
exactly the way the old docs did. So the slice is chosen to make one real golf ritual
completely true:

> **The Saturday game.** A real crew plays its standing game in swng every week — the games
> score themselves, the strokes are settled before anyone tees off, and every round counts
> toward the crew's ledger and each player's average, forever.

Why this slice and not another:

- **It's the highest-frequency ritual in golf.** Weekly, not annual. It compounds: every
  Saturday deepens the ledger and the habit. A trip is a better demo; a standing game is a
  better product.
- **It exercises the entire spine.** Round engine, the stroke model, crew, course data —
  nothing built for v1 is throwaway, and v2/v3 are configurations of this spine, not new
  systems.
- **It recruits by itself.** Every round pulls the rest of the crew in through the join link —
  the invite and the sign-up funnel in one (a first-timer signs up once, in thirty seconds,
  on the way onto the card). The trip captain and league runner we want for v2/v3 are already
  in somebody's Saturday game.

## v1 — The Saturday Game

### The Round

- **Formats (deliberately five):** stroke play (gross and net), Stableford, singles match
  play, four-ball best-ball match play, and skins with carryovers. These cover the standing
  games of most crews. The menu grows later; the engine does not get rebuilt later —
  **concurrent games over one set of strokes is in v1** (a four-ball match *and* individual
  skins on the same card). That capability is the product's spine and cannot be retrofitted.
- **Stroke-aware:** strokes allocated by stroke index (dots on the card), from what each
  player states they normally shoot relative to par — swng takes the difference.
- **Scoring:** two taps; anyone can score for anyone (one person can keep the whole card);
  "picked up" and "conceded" are first-class scores.
- **Game state, always:** current standing of every game at a glance, pulled up per game from
  the card's own chips (the between-holes digest popup is deliberately gone; owner call,
  2026-07-13). *2 UP with 4 to play, Dave strokes here, three skins carrying.*
- **Golf's realities:** offline-first (dead zones never block entry), join by the round's link
  or code (a first-timer signs up on the way in, once; owner call, 2026-07-13), 9-hole rounds
  first-class.
- **After the round:** the card archives permanently, results write to the ledger, your
  average updates, and the round has a shareable link (spectator live view uses the same
  mechanism). Rendered card *images* for the group chat are v1.1.

### The Golfer

- Account, profile, home course.
- **What you shoot:** your average — score minus par over your last 10 finished rounds, a
  nine counting doubled. No bootstrap rule and no starting number to declare: your first
  finished round already gives you one.
- Round history (filter by course, crew, year), your average over time, scoring distribution
  (birdies/pars/bogeys/others).
- **Not in v1:** the course book, milestones, per-hole stat tags, season recap.

### The Crew

- Named persistent crew with a roster of **full accounts only** (owner call, 2026-07-13: a
  crew is a grouping of accounts; ghosts play inside rounds and are never added to a crew).
  The holdout signs up once through a round's join link and is fully present from that round
  on.
- **The crew's games are chosen fresh each round** (owner call, 2026-07-13: a crew is a
  grouping, not a preset — there is no saved standing game and no "play the usual"; the crew
  instead defines named seasons that count members' finalized rounds).
- **The ledger, core cut:** every crew round recorded; head-to-head match records between any
  two members; season leaderboard (wins, points, skins).
- **Not in v1:** the feed, partner records.

### The Course

- Course database with real scorecard data: tees, par, yardage, course rating, slope, stroke
  index. v1 ships with a first-class **add-and-verify flow** (enter your home course once,
  correctly; crew members can verify). Seeding from a licensed dataset is a separate
  buy-vs-build decision that must not block v1 — a crew that enters its two home courses is
  fully served.
- Treated as a product surface: every dot and stroke depends on it.

### The v1 bar

v1 is done when this is true, not when the features exist:

- A crew of 8 runs its standing game for a month with **zero paper and zero spreadsheet**.
- The app earns **≤ 20 seconds per hole** and never makes the group wait.
- Strokes are trusted enough that **the first-tee negotiation actually ends**.
- The member who'd never installed the app signs up once on the first tee (the join link is
  the funnel; owner call, 2026-07-13) and is **fully present** in every card and ledger from
  that round on.

## v1.1 — fast follows

Pure configuration and polish on the v1 engine, shipped as they're ready: **Nassau with
presses** (three concurrent matches plus press-from-the-card — configuration, not
architecture), **junk tallies** (greenies, sandies, the snake), modified Stableford and
quota, rendered card images for sharing, optional per-hole stat tags (putts, fairways, GIR,
penalties) so the data starts accruing.

## v2 — The Trip

The Event machinery in its most emotionally resonant shape: named recurring trips, rosters,
**team draft**, sessions each with their own format and points (four-ball AM, foursomes PM,
singles Sunday), the **Cup board** big-screen mode, and the **trophy room** that makes the
trip an institution. Requires the team-game menu trips actually play: foursomes, scramble,
shamble, Wolf, Vegas, Sixes. Alongside: milestones, the course book, and the crew feed.
Target: in golfers' hands **before peak buddies-trip season**.

## v3 — The League and the Outing

- **Leagues:** season containers — divisions, generated schedules, 9-hole matches with the
  same strokes model, substitutes, points table, playoffs.
- **Outings:** one-day events — big fields, flights, banquet-projector leaderboard,
  closest-to-the-pin and long drive, instant results at dinner.
- **Season in Golf** recap — ships once there's a full season of data to recap.

## Out of scope at every version

`product.md` §10 stands for the whole arc, restated here so no version drifts: no GPS or shot
tracking, **no money**, no tee-time booking, no stranger-social, no instruction or equipment,
no official handicap-network posting, no pro-shop tournament ops.

## Relationship to the POC

v1 is a **ground-up rebuild**. The POC is reference material for what live sync feels like on
a phone — it is never patched into v1. Its one durable lesson is already in the design:
frictionless join is why whole groups show up.
