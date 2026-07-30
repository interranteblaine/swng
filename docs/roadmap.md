# swng — v1 Scope and the Release Arc

> Status: **approved** (2026-07-07; vocabulary corrected twice on 2026-07-30 — first to the
> stroke/average model that replaced the WHS index, then to typed strokes when the derivation
> that model shipped with was itself deleted. See `CLAUDE.md`'s arc records for the changes
> themselves; scope and sequencing below are otherwise unchanged). Scopes the first shippable slice of
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
- **Stroke-aware:** one number per player, typed on the roster by whoever agreed it and
  editable by anyone all round, allocated by stroke index (dots on the card). A card is
  absolute — stroke play, Stableford and skins use each player's own number — and a match is
  relative: a singles match and a four-ball are played off the difference, from the hardest
  hole down.
- **Scoring:** two taps; anyone can score for anyone (one person can keep the whole card);
  "picked up" is a first-class entry for a hole with no number, and a gimme is simply the
  score you tap.
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
  finished round already gives you one. It is read-only in both directions — computed from
  rounds, never asserted, and never read back into one. Its job is to tell you what to ask
  for on the first tee.
- Round history (filter by course, crew, year), your average over time, scoring distribution
  (birdies/pars/bogeys/others).
- **Not in v1:** the course book, milestones, per-hole stat tags, season recap.

### The Crew

- Named persistent crew with a roster of **full accounts only** — as is every card in swng
  (owner call, 2026-07-13, the accounts-only wall: ghost profiles and claim-later identity are
  deleted outright; nobody plays a round who is not a signed-in account). Members join by
  invite link; nobody is added by someone else. The holdout signs up once through a round's
  join link and is fully present from that round on.
- **The crew's games are chosen fresh each round** (owner call, 2026-07-13: a crew is a
  grouping, not a preset — there is no saved standing game and no "play the usual").
- **The ledger, core cut:** **the crew watches; members just play** (owner-approved,
  2026-07-21/22) — a season is a time window with chosen dates, and a member's finished round
  is in it automatically if its played date falls inside. Nothing is filed, counted, or
  recorded with the crew. From that window: a per-member scoreboard, head-to-head match
  records and four-ball partner records between members who shared a round, and season
  standings (wins, points, skins).
- **Not in v1:** the feed.

### The Course

- Course database with real scorecard data: tees, par, yardage, course rating, slope, stroke
  index. v1 ships with a first-class **course-entry flow** — transcribe your home course once
  from its paper card, and correct the whole card in place when the club changes something
  (owner call, 2026-07-15: the trust model is transcription, not authority, so there is no
  verification step claiming an authority the data never had). Seeding from a licensed dataset is a separate
  buy-vs-build decision that must not block v1 — a crew that enters its two home courses is
  fully served.
- Treated as a product surface: every dot and stroke depends on it.

### The v1 bar

v1 is done when this is true, not when the features exist:

- A crew of 8 runs its standing game for a month with **zero paper and zero spreadsheet**.
- The app earns **≤ 20 seconds per hole** and never makes the group wait.
- Strokes are trusted enough that **nobody re-does them on a cart** — the number the group
  agreed goes on the card once, the dots land on the right holes, and no one goes back to
  check.
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
