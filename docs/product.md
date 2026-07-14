# swng — Product Design

> Status: **approved** (2026-07-07). Written one-shot from golf domain knowledge per
> `product-invention-brief.md`, deliberately not derived from the POC or prior docs.
> This is the product north star. It supersedes `product-design.md`, `product-v1.md`,
> and the other prior-session docs.

**swng is the app for the golf you actually play: real games, with the same people, year after year — and it makes every round count.**

---

## 1. The point of view

Three facts about golf that no scorecard app takes seriously:

**Golf is the only sport where any two players can have a fair match.** The handicap system exists so a 22 and a 6 can stand on the first tee with a genuine contest. Competition is never out of reach in golf — it is the default state of the game. And yet most golfers' handicaps are unofficial, stale, or vibes; and the math of *who gets strokes, and on which holes* is first-tee friction that usually ends in someone waving it away.

**Golf is played in persistent small groups, repeatedly, for years.** The Saturday foursome. The twelve guys on the annual trip. The Tuesday-night nine-hole league. Golfers don't accumulate rounds — they accumulate *history with people*: standing games, running rivalries, a decade of trip results, the year Danny finally broke 80. That history is the emotional core of amateur golf, and today it lives in group chats, fading memories, and one guy's spreadsheet.

**A round is rarely just stroke play.** Real groups layer games on top of the strokes: a two-man match, skins carrying over, a Nassau with a press on the back, junk for greenies and sandies — often several at once. The strokes are raw material; the games are the point. Paper can't keep up, and no app seriously tries.

Existing products treat golf as either a solo improvement project (GPS, shot tracking, strokes gained) or a disposable scorecard (write it down, throw it away). The golf that golfers actually love — **the game with your people, for keeps** — has no home.

swng is that home.

## 2. Who it's for

The golfer who plays *with people*. Ten to sixty rounds a year, most of them with the same faces. Concretely:

- **The regular** — has a Saturday game, a usual crew, a usual format, opinions about who's sandbagging.
- **The trip captain** — organizes the annual buddies trip: rosters, teams, formats, and the sacred trophy. Today runs it on a spreadsheet and sheer will.
- **The league runner** — keeps a 9-hole work or bar league alive: schedule, subs, standings, playoffs. Today: paper and Excel.
- **Everyone they play with** — because joining a round takes the round's link (or code) plus, for a first-timer, a one-time thirty-second sign-up — one tap forever after — every round played recruits the rest of the group.

Who it is *not* for: the solo stats obsessive (Arccos has him), the tee-time bargain hunter (GolfNow has him), the golf-content scroller. swng is for people who already have people.

## 3. The shape: four nouns, one record

swng is four things, tightly joined: **the Round, the Golfer, the Crew, the Event.** The joining principle is:

> **Everything counts.** Score a round once, and it simultaneously resolves every game inside it, updates every player's history and handicap index, writes to the crew's ledger, and moves the event's standings. No round is disposable.

The POC's live multi-phone scorecard survives as the innermost kernel of the Round — but a scorecard only records what you *shot*. swng knows what you're *playing*, and what it *means*: for the match, the skins pot, the trip cup, the league table, the lifetime rivalry, your index. Meaning is the product.

---

## 4. The Round

The live engine. Phone-first, shared, and — the key move — **format-aware and handicap-aware**.

**Starting a round.** Pick the course and tees; the join code or link brings the players — it is both the invite and the sign-up funnel. Everyone on a card is a signed-in account (owner call, 2026-07-13): a player who has swng joins in one tap, a first-timer signs up on the way and lands on the card in about thirty seconds. Nobody puts anyone else on a card. Pick the game(s). Handicaps are already known, so strokes are computed and the dots are on the card before anyone tees off. *The first-tee negotiation is over before it starts.* (A round never draws on a crew — no crew rosters, presets, or memberships at setup; owner call, 2026-07-13.)

**Scoring.** Two taps to post a score, for yourself or anyone in your group (one person can keep the whole card — that's how real groups work). "Picked up" and "conceded" are first-class scores, not errors: match play concessions, Stableford pickups, and net-double-bogey caps are all normal golf. Optional one-tap tags per hole — putts, fairway, penalty, sand save — for those who want stats; invisible for those who don't.

**Games, plural.** Any number of games run concurrently over one set of strokes:

- *Individual*: stroke play (gross/net), Stableford (standard and modified), quota, skins (carryovers, optional validation), singles match play.
- *Team*: four-ball best ball, foursomes (alternate shot), scramble, shamble, Vegas, Wolf, Sixes (rotating partners every six holes).
- *Structures*: Nassau (front/back/overall) with presses initiated right from the card.
- *Junk*: greenies, sandies, barkies, poleys, the snake — tallied as units alongside everything else.

Handicap math is done silently and correctly: strokes allocated by the course's stroke index, format-correct allowances applied automatically (adjustable by the group). Nobody does arithmetic on a cart.

**Game state, always.** The card's job is to answer, at a glance, *"where does everything stand right now?"* — *You're 2 UP with 4 to play. Dave gets a stroke here. Skins: three carrying into 14. The press is all square.* Every game's standing is one tap away on the card's own chips — pulled when wanted, never pushed as an interruption (the between-holes digest popup is deliberately gone; owner call, 2026-07-13). This is the on-course magic moment: the app is the one member of the group who always knows the state of every game.

**Built for golf's realities.** Offline-first — dead zones never block score entry; everything syncs when signal returns. Glare-readable, big targets, usable in twenty seconds on a tee box. Nine-hole rounds are first-class citizens (leagues, twilight nines). A spectator link lets people at home watch the match live.

**When the putt drops on 18.** The round archives forever as a proper scorecard. Games settle to results. Handicap differentials post. Milestones fire (personal best, first eagle, finally beat Dave). A clean, shareable image of the final card goes to the group chat.

## 5. The Golfer

The permanent record of a playing life.

- **The swng Index.** A WHS-faithful handicap index computed from your swng rounds — best 8 of your last 20 differentials, course rating and slope, net-double-bogey adjustment, proper 9-hole handling. Unofficial, but honest and current — which is more than most golfers' handicaps can say. If you carry an official index, set it manually and swng uses that instead.
- **History.** Every round you've ever played in swng, filterable by course, crew, year, format.
- **The course book.** Your record at every course you play: scoring average per hole, best round there, the hole that always gets you. *You're playing your home course and swng knows you double 13 more than any hole on the card.*
- **Stats the card already knows.** Scoring distribution (birdies/pars/bogeys/others), par-3/4/5 averages, and — if you use the tags — putts, fairways, GIR, penalties. Enough to know where the strokes go; deliberately not shot-by-shot tracking.
- **Milestones and seasons.** First birdie, breaking 90/80, best nine, streaks. A season arc with an index trend line, and a year-end **Season in Golf** recap built to be shared.

## 6. The Crew

The atomic social unit of golf, made first-class. A crew is a persistent named group — *The Saturday Boys* — a roster of members and a ledger. **A crew is a grouping, not a preset** (owner call, 2026-07-13): it never configures, seeds, or runs a round; it groups finished rounds into seasons and keeps what they mean.

- **One tap and you're on the card** (owner call, 2026-07-13 — this replaces the ghost-profile pillar). Everyone in a round, like everyone in a crew, is a real account: swng scores games between people who exist. Ghost profiles and claim-later identity are gone — maintaining a fake party to a rivalry was the system's steadiest source of identity bugs and attack surface. The join link in the group chat is the whole onboarding: sign up once, ever, in thirty seconds; every round after is one tap. The holdout's first Saturday costs him a sign-up — until then his side bets live on cardboard, and that trade is accepted knowingly.
- **Crew handicaps.** Every member has a current swng Index computed from real rounds — the end of the sandbagging argument, or at least the beginning of a fair fight. Crews can pin an override where crew lore demands it.
- **The ledger.** All-time and per-season records: head-to-head match results between any two members (*you're 7–6 lifetime against Dave, and swng reminds you both on the first tee*), partner records (*you and Mike are 9–2 in four-ball*), skins won, points leaderboards, lowest net average, most improved.
- **The feed.** Rounds played, records broken, streaks alive and dead — the raw material of the group chat, generated automatically.

## 7. The Event

The occasions golf is organized around. Three shapes, one machinery: rosters, formats, schedules, standings — with every event round still counting as a real round in every player's record.

**The Trip.** The annual buddies trip, run like the institution it is. Name it, set the dates, build the roster. Split into teams — captains can draft right in the app on draft night. Schedule sessions, each with its own format and points: four-ball Friday morning, foursomes Friday afternoon, singles Sunday, Ryder Cup style. The **Cup board** — big-screen mode for the rental-house TV — shows live team standings all weekend. And because trips recur, swng keeps the **trophy room**: *The Baker Cup, 2019–2026: Red 4, Blue 3.* Individual trip records (best trip record, most points all-time) turn one weekend a year into a permanent institution.

**The League.** Season container for weekly golf: divisions, generated match schedules, 9-hole matches with league handicaps, substitutes, a points table, playoffs. The standings page everyone checks on Tuesday night — without the league runner touching a spreadsheet.

**The Outing.** The one-day charity scramble or work event: big field, flights, live leaderboard on the banquet-room projector, closest-to-the-pin and long-drive tracking, instant results at dinner. Organizer-lite by design — a player with a phone can run it.

## 8. The Course

The quiet layer everything stands on: a course database with real scorecard data — tees, par, yardages, course rating, slope, stroke index. Community-maintainable: add or verify your home course once and every game in swng computes correctly on it forever. Handicaps, dots, and formats are only as trustworthy as this layer, so it is treated as a product surface, not an import script.

## 9. How it should feel

- **Heads-up golf.** The app earns about twenty seconds per hole and no more. Nothing swng does may slow play; pace is a design constraint, not a nicety.
- **Two taps.** The common action — post a score, check the games — is never more than two taps from pocket.
- **One link, whole group.** The round's join link is invite and onboarding in one: sign in once, then every round after is a single tap. The wall is real — everyone on a card is an account — but it is thirty seconds high, and it buys the whole group a trustworthy ledger.
- **The card is sacred.** Finished rounds look like scorecards — the familiar grid, dots for strokes given, match results written *3&2*. The trip board looks like a Ryder Cup board. swng speaks golf's visual language instead of inventing one.
- **Works where golf happens.** Offline-tolerant, sunlight-readable, glove-friendly.

## 10. Deliberately out

- **GPS, rangefinding, shot tracking, strokes gained.** Commodity features served better by watches, lasers, and sensor products. Bolting them on dilutes the point of view; swng is the game layer, not a yardage device.
- **Money.** Games score in holes, points, skins, and units. What a unit is worth is the group's business, settled off-app. No wagering, no settlement, no payments — swng tracks *results*, full stop.
- **Tee-time booking and course marketing.** A different, transactional business.
- **A social network of strangers.** No public feeds, no discovery, no follower counts. swng is for people who already play together.
- **Instruction, swing video, equipment.**
- **Official handicap-network integration.** The swng Index is deliberately honest-unofficial. Posting to official networks is a possible later bridge, not a foundation.
- **Pro-shop tournament operations.** Cart signs, pairings printers, and pro-shop workflows are Golf Genius's turf. swng events are player-run.
- **Monetization design.** Not addressed here; separate conversation after the product is agreed.

## 11. What this adds up to

A scorecard records what you shot and gets thrown away. swng knows what you're *playing* — the match, the skins, the trip, the season, the rivalry — and keeps what it *means*, forever. The handicap makes every pairing a fair fight; the crew makes every Saturday part of a longer story; the event makes the trip and the league institutions; and the round engine makes all of it effortless on the first tee.

Golf with your people, for keeps.
