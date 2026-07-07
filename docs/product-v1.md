# swng v1 — Product Definition

## What swng is

swng is a phone-first web app for keeping the scorecard during a round of golf. One group shares a
single live scorecard across everyone's phones: enter strokes hole by hole, see gross and net standings
update in real time, and trust that nothing is lost when the signal drops. It replaces the paper card and
the clunky solo scoring app with one shared card the whole group keeps together.

## Who it's for

1–4 golfers playing a round together — whether one person keeps the card for the group or everyone
scores on their own phone — on a real course, often with spotty signal. No sign-up and no setup: reach
the first tee, start a round, share the code, play.

## The core loop

Create a round (course, tees, players) → others join with a short code → each player thumbs in strokes
hole by hole → the shared card updates live on every phone → gross and net totals and standings
throughout → mark the round complete → a read-only scorecard remains as the record.

## In v1

**Rounds**
- Create a 9- or 18-hole round (front or back nine for 9-hole play).
- Add 1–4 players by name and assign each a tee.
- Join a round with a short access code — no account required.
- Rejoin restores the same player and their scores after a closed tab, refresh, or dropped connection;
  identity persists on the device, not per tab.

**Courses**
- Pick a course from a managed catalog that provides, per hole: par, stroke index, and per-tee yardage.
- Add a course on the spot (name; par and stroke index per hole) when it isn't in the catalog, so a
  missing course never blocks play.

**Scoring & games**
- Hole-by-hole stroke entry, one hole at a time, with large thumb targets; holes can be left blank while
  in progress and corrected at any time.
- Any player in the group can enter or edit any player's strokes — one shared card, whether one scorer
  or many.
- Supports the ways a single round is actually played, individual or in teams, all from the same shared
  card: **stroke play** (gross and net), **Stableford**, **match play**, **skins**, **four-ball
  (better-ball)**, and team-ball formats where one ball is played per side — **scramble** and
  **foursomes (alternate shot)**.
- Scores are entered per player, or per team for team-ball formats.
- Multiple games can run on one round at once (for example stroke play and a skins game together), each
  with its own live result.
- Net play: enter each player's handicap (optional); strokes are allocated by stroke index and applied
  correctly for the format being played. Leave handicaps off for gross-only play.
- Live results suited to each game: gross and net leaderboard for stroke play, points for Stableford,
  match status (e.g. "2 up") for match play, and skins won or carried.
- Running out / in / total and score-to-par per player throughout.

**Scorecard & record**
- Full scorecard grid — all players × all holes, with par and stroke-index rows and front / in / total
  columns.
- Mark the round complete; the finished card stays viewable read-only by its link/code as the record of
  the round.

**Reliability**
- Local-first entry: strokes save on the device immediately and queue when offline, syncing
  automatically when the signal returns.
- The round stays available to late joiners and reconnecting players, always showing current state.

## Not in v1

**Deferred to later versions**
- User accounts, sign-in, and profiles.
- Cross-round history, scoring averages, and trends.
- Cross-device continuity — resuming the same player on a different phone.
- Handicap-index computation and official (WHS) posting; handicaps are entered, not calculated.
- Tournaments, events, multi-round series, flights, and cross-round leaderboards.
- Scorer/marker roles and permission policies beyond the shared card.
- Creating or editing catalog courses (beyond the on-the-spot round course above).
- Native apps, push notifications, and localization.

**Out of scope — not what swng is**
- Betting, wagers, or money settlement.
- Social feed, following, or sharing beyond the round link.
- GPS, rangefinder, shot/putt tracking, or swing analysis.
