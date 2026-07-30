# swng — Domain & Backend Architecture

> Status: **approved** (2026-07-07; revised same day after blind clean-room validation —
> two independent designs from `product.md`+`roadmap.md` alone converged on this spine and
> corrected the conflict-resolution rule). The target architecture for the full product
> (`product.md`), sequenced by `roadmap.md`. v1 ships on this; v2/v3 grow in without
> rework — §6 demonstrates that claim.

## 1. Three decisions everything follows from

**1. The round is an event log; games are pure functions over it.**
A live round is collaboratively edited from multiple phones, half of them offline at any
moment. The honest model is an append-only log of scoring facts per round. Every game — match,
skins, Stableford, Nassau, Wolf — is a pure reducer over that log:

```ts
scoreGame(config: GameConfig, state: RoundState): GameState   // state = reduceRound(events); N games share one fold
```

Games never store mutable state. A score correction is a new event and every game simply
recomputes; a press or a concession is itself an event in the same log. This is what makes
"concurrent games over one card" cheap in v1 and "Nassau is configuration, not architecture"
literally true — and it is the conventions' *derive, don't store* applied at system scale.

**2. Finalized rounds are the source of truth; everything else is a projection.**
Golfer history, golfer averages, crew ledgers, head-to-head records, competition standings,
milestones, feeds, the course book — all of them are folds over immutable finalized rounds.
Projections are rebuildable by replaying the archive. This is "everything counts" made
structural, and it is the no-rework claim in one sentence: **v2 and v3 are new game configs
plus new projections over rounds that already exist.** Your 2026 rounds already count toward
features that haven't shipped.

**3. One domain, two runtimes.**
`@swng/domain` is pure TypeScript with zero dependencies, running identically in the browser
and in Lambda. The phone reduces the event stream locally — instant UI, full offline scoring;
the server reduces the same events for persistence and results. Parity is property-tested
(`client result === server result`), per the conventions' testing mandate.

Vocabulary: the product's "Event" (trip / league / outing) is the domain's **`Competition`** —
"event" is reserved for log events. The domain person is a **`Golfer`**, not a "User" ("user"
is an auth-layer word; names must tell the truth).

## 2. The domain model

### Golfer

One identity for a playing life. **Account and golfer are born together** (owner call,
2026-07-13 — ghosts and claims are deleted): the first authenticated request that needs the
caller's golfer mints it, with a deterministic placeholder name derived from the sub
("Golfer 4821" — f(sub), so the concurrent-first-request race cannot generate two names),
through the sub-binding's own `attribute_not_exists` transaction; the race's loser re-reads
the winner. Cognito is a pure authenticator — it contributes a `sub` and nothing else; the
name is a domain display attribute, editable forever, and nothing keys on it (`GolferId`s do).

```ts
interface Golfer {
  id: GolferId
  name: string
  homeCourseId?: CourseId
  namePlaceholder?: boolean   // true only while `name` is the sub-derived placeholder
}
```

**The golfer record holds no number and no source to pick** (2026-07-29 revision — the WHS/swng
Index pipeline is deleted whole, `docs/superpowers/specs/2026-07-29-relative-to-par-strokes-
model-design.md`). What a golfer shoots is `metrics.average`, computed on read from their own
finished rounds — a plain integer over/under par (score minus par, last 10 finished rounds with
every hole scored), no index, no slope, no best-8-of-20. What a golfer plays off in any given
round is the `StrokeBasis` they state when they join it (the Round section below); nothing
about it lives on the profile between rounds beyond that it pre-fills the next join's field.
Old stored rounds still contain ghost golferIds that never had and never will have accounts —
they fold and render exactly as written (the sealed leaf is the identity of record for its own
participants); only account-bound golfers are projected forward into records and presence.

### Course

```
Course ─ TeeSet[] ─ rating, slope (18- and 9-hole) ─ Hole[] { par, yardage, strokeIndex }
```

Tee sets are **versioned and immutable** — corrections create a new version; verification
(`verifiedBy`) and provenance (community-entered | imported) are per-version metadata.
**Rounds freeze a `CourseCard` snapshot at start**, so history never rewrites regardless.
The licensing buy-vs-build stays open (roadmap); the entity models either source.

### Round — the only event-sourced aggregate

A `Round` is: a frozen `CourseCard`, participants (with tee and stated `StrokeBasis` frozen at
join, correctable mid-round by a dedicated `participant-basis-set` event — you play at the
number you started with, until someone corrects it), attached games, and its event log.
Lifecycle is an explicit enum: `setup → live → final`, plus `abandoned` — a real terminal
reached via `round-abandoned`, mirroring `round-finalized`'s fold semantics but producing **no
archive**: an abandoned round aggregates nowhere and is excluded from every downstream view
(presence, projections, crew season counting). No null states.

```ts
type RoundEvent =
  | RoundCreated | ParticipantJoined | GameAdded
  | ScoreRecorded      // { golferId, hole, result: strokes | 'picked-up' | 'conceded', recordedBy, opId, hlc }
  | PressOpened | ConcessionGiven | PartnerPicked   // game decisions live in the same log
  | RoundFinalized | RoundReopened | RoundAbandoned
```

- Two clocks, two jobs. **`seq`** is server-assigned and gapless — the canonical log order
  and every client's catch-up cursor. **`hlc`** (a hybrid logical clock stamped at authoring)
  resolves conflicts: each score cell `(golferId, hole)` is a last-writer-wins register by
  `hlc` (tie-break `deviceId`), with full audit. Author time, not arrival time: a phone
  syncing stale scores out of a dead zone can never overwrite a correction made after them,
  and the fold is order-independent — any device applying any delivery order converges.
  Every client event carries an `opId` for idempotent dedupe. Naive wall-clock comparison
  appears nowhere.
- An explicit `ScoringPolicy` on the round says who may score for whom (default: anyone in
  the group, matching how real cards are kept).
- **The event schema is append-only** (new event types and optional fields only), and reducers
  ignore event types they don't recognize. Old clients survive mid-round; archived logs replay
  forever.
- Reopen-and-refinalize is the correction path after finalization; projections treat finalize
  as an idempotent upsert by `roundId` and recompute.
- Finalization writes the **`RoundArchive`**: one immutable record holding the setup and
  course snapshot, the final grid, the full event log, per-game results, and each
  participant's frozen strokes (derived at fold time from what they stated, never a WHS
  differential). Completeness rule: **the archive captures everything a projection that
  doesn't exist yet could need** — it is the replay source for all of them, and it is never
  mutated. Settlement is deterministic: re-settling the same log yields a byte-identical
  archive (enforced by test).

Rounds are small (4 players × 18 holes ≈ low hundreds of events), so full replay is cheap; a
maintained snapshot item exists purely as a read optimization, never as truth.

### The games engine (in `domain/scoring/`)

`GameConfig` is a discriminated union; each format contributes a config type, a `GameState`
type, and a reducer. **No format re-derives strokes from a percentage** (the old allowance
table is deleted, 2026-07-29): every format applies the ONE stroke-resolution rule below to its
own field of players — a game's own anchor, never the whole card's. Formats that involve
in-round decisions (presses, concessions, Wolf picks) consume their decision events from the
round log.

v1 members: `strokePlay` (gross/net), `stableford`, `singlesMatch`, `fourballMatch`, `skins`
(gross/net). Growing the menu — Nassau, quota, foursomes, scramble, shamble, Wolf, Vegas, Sixes
— adds union members and reducers. Nothing else in the system knows format internals; a
`GameState` renders and a `GameResult` settles.

### Strokes and the average (in `domain/scoring/strokeBasis.ts`, `domain/golfer/average.ts`)

No WHS math anywhere in the system (deleted whole, 2026-07-29 — `docs/superpowers/specs/2026-
07-29-relative-to-par-strokes-model-design.md`). A golfer states a `StrokeBasis` when they join
a round — either what they normally shoot relative to par (`{kind: "normally-shoots", overPar}`)
or a flat number of strokes (`{kind: "strokes", strokes}`, bounded at zero: nobody gives strokes
back under a relative model). **One rule derives strokes for everybody**: `resolveStrokes`
takes the difference from the lowest stated normal score among a field's *present* members (the
anchor, `anchorOf`), clamped at zero, halved once on a nine — a departed player is excluded from
the anchor but still resolves their own strokes against it. The same rule scopes to the round's
whole roster (the card's dots) and to each game's own frozen field (a match, a skins pot),
independently. Rating and slope stay recorded on the course card — they're printed on the real
scorecard — but feed no calculation anywhere. A golfer's **average** (`golfer/average.ts`) is
`score − par` over their last 10 finished rounds with every hole scored (a round containing a
picked-up hole contributes nothing; a nine counts doubled) — a read-time fold over
`GolferRoundLine`s, never stored or asserted, that pre-fills (never floors) the basis field the
next time they join a round.

### Where golf logic lives

Golf logic — the fold, the five scoring engines, stroke allocation, the ONE stroke-resolution
rule, the average, the metrics projection — is **one tested copy in `@swng/domain`**, and
nothing re-derives it. The server runs it behind the API for reads and finalize; the web runs it
**on-device** for the offline round (scoring must work with no signal), but only through
**`@swng/client`**, the one sanctioned client-side compute seam. `@swng/client` exposes
`foldAndScore` (the read-only cousin of `RoundSession`'s live `reduceRound → scoreGame` fold,
used by the spectator watch page and the archived-round page) and re-exports the round-compute
the web needs (`gameStrokeAllocation`, `roundStrokeAllocation`, `netStrokes`, `totalDots`,
`grossForHoles`, `unresolvedGames`). The average is deliberately NOT re-exported: it is
server-computed and served on the golfer record, so an on-device copy would be fence-legal and
boundary-wrong — nothing converts an index into strokes anymore, because a player states the
number directly. An ESLint fence (`@typescript-eslint/no-restricted-imports` on `apps/web/src`)
forbids the web importing those compute values straight from `@swng/domain`, so a future
hand-rolled golf computation in the web fails `pnpm lint`. Presentation formatters
(`formatOverPar`, `underPar`, `gameTreatment`, `gameKindLabel`/`gameKindBlurb`/`gameKindFits`,
`strokesNote`), id constructors, pure structural accessors (`cellKey`, `findTeeSet`,
`gameMembers`), and all `import type`s stay importable from `@swng/domain` directly — they
compute no golf result.

### Crew — plain entity, no event sourcing

A roster of real accounts — like everything else now: every round participant is an account,
and the round's join link is the sign-up funnel for whoever lacks one — plus named **seasons**
(`"2026"`, `"Summer Cup"`) that are nothing but a **time window**: a member creates one with
chosen, visible `startsAt`/`endsAt` calendar dates, and Live vs. **Final** is derived on read
(today's UTC date past `endsAt`) — there is no stored status and no separate close/reopen verb;
editing the end date *is* the whole lifecycle (2026-07-22, "the season is the record"). **A crew
is a grouping, not a preset** (owner call, 2026-07-13): nothing about a crew configures, seeds,
or runs a round — no standing games, no crew-sourced quick-adds at setup, no membership-based
seating consent. A claimed account gets onto a card exactly one way: the person joins as
themselves.

**The crew watches; members just play** (2026-07-21/22): nobody ever files a round with the
crew, and there is no counted-round list. A round counts toward a season automatically, for a
roster member, iff its played date falls inside the season's window — membership, not tenure,
so a round played before you joined the crew still counts, and leaving drops your rows at the
next read (rejoining restores them). Standings are **computed on read, stored nowhere**: one
`listLines` fetch per current roster member feeds (a) the **scoreboard** — rounds, average,
spread, best per member, every member windowed the same way — and (b) the set of **shared**
roundIds (≥2 members hold an in-window line for it), which is batch-fetched and folded
(`aggregateSeason` over `crewContribution`, `partnerRecords`) into the ledger, head-to-head, and
partner records — together-records, unlike the scoreboard, only ever come from rounds members
actually shared. Both folds scope to the **current roster** only; there is no all-time surface
separate from a season — a season given wide-enough dates *is* the all-time board. This is the
Competition principle below (**Competitions never own scoring — they reference rounds**) applied
to Crew too: one reference direction everywhere, outside → round, by id.

### Competition — plain entity (v2/v3), referencing rounds

```
Competition { type: trip | league | outing, roster, teams?, sessions: Fixture[] }
Fixture     { format + points rule + roundIds }
CompetitionSeries — links recurring instances (the trophy room)
```

**Competitions never own scoring — they reference rounds.** Standings are projections folding
the referenced `RoundResult`s through the points rule. Trips, leagues, and outings differ in
fixture generation and points rules (application-layer concerns), not in scoring machinery.
The atom never changes.

## 3. System shape

```
phones / big screens (web app)
   │ HTTPS commands + queries            ▲ WebSocket: round & projection channels
   ▼                                     │
API Gateway (HTTP + WS) ──── lambda (one package, per-trigger entry points)
   ▼
DynamoDB:  rounds │ snapshots │ core │ projections │ connections
                       └── stream ──► projector entry ──► golfer records + presence cleanup
```

- **Commands** validate against current state and append events; **queries** read the live
  round cache, the `snapshots` table, and projections. Contracts are Zod schemas in
  `@swng/contracts`, parsed once by the dispatcher table (conventions §3).
- **Realtime:** an append broadcasts to the round's channel. Finalize commits the
  `round-finalized` event and the round's archive together in **one cross-table transaction**
  (rounds + snapshots) — "finalized but no archive" is unrepresentable. The `snapshots`
  table's own stream invokes the projector on every write (every stream record is a
  snapshot — no filter, no branching), which updates each participant's golfer record —
  history lines only, the average is a read-time fold over them (2026-07-14 revision; no
  stored index) — and clears their live-round presence, then broadcasts to
  projection channels — the trip's Cup board and the outing's banquet leaderboard (v2/v3) are
  just big-screen subscribers to a standings channel. Rebuild is a paged, cursor-resumable
  backfill over the `snapshots` table — no scan, no wipe. Spectator mode is the round channel
  with a read-only token.
- **Offline sync** is owned by the client SDK: a durable outbox (IndexedDB behind a storage
  port) + last-seen `seq`; the sync loop pushes queued events (deduped by `opId`) and pulls
  since `seq`, and the HLC merge makes rebasing free — stale pushes can't clobber newer
  intent. **The WebSocket is delivery sugar; HTTP catch-up is the correctness path** — a
  dropped socket costs latency, never state.

### Identity & access

- Cognito (email + social sign-in) behind a JWT authorizer, contributing a `sub` and nothing
  else. **`GolferId` ≠ Cognito sub** — an identity mapping (the sub-binding row) links them,
  minted get-or-create on first authenticated touch.
- Join is always yourself: `POST /rounds` and `POST /rounds/join` are golfer-authed (there is
  no anonymous round path); a successful join yields the round-scoped participant token that
  scores. Any participant scores for any participant — delegation is capability inside the
  round, never identity.
- Share link → read-only spectator token. Same signing mechanism, narrower capability.
- `POST /rounds/{roundId}/token` (golfer auth): a signed-in participant re-mints a scoring
  token on any device — new phone taps the round on home and scores; no re-join, no separate
  token model.
- Home's "your rounds" is presence by identity (`LIVE#<roundId>` in the golfer's own
  projection partition, TTL-backed), never device-held tokens.

### Persistence sketch (DynamoDB)

| Table | Keys | Holds |
| --- | --- | --- |
| `rounds` | `ROUND#id` / `EVT#seq`, `SNAPSHOT`, `META` | the log (conditional put on seq enforces order) and a live read-cache snapshot (never truth — see §2); a `joinCode` GSI resolves the round a code names |
| `snapshots` | `<roundId>` (single item) | one immutable `RoundArchive` per finished round — the atom; system of record for everything downstream |
| `core` | `GOLFER#id`, `CREW#id` (+member items, `SEASON#id` — a name plus chosen dates, no counted-round items), `COURSE#id`, `COMP#id` (+fixtures) | entities; GSIs: course-name search (gsi1), and one gsi2 shared by two lookups distinguished by partition namespace — cognito sub→golfer and golfer→crews (crews carry no join code of their own; membership is by invite token, spec 2026-07-15) |
| `projections` | `GOLFER#id` / `ROUND#roundId` (a line), `LIVE#roundId` (presence, TTL attribute); `STANDINGS#comp` (v2/v3) | derived, rebuildable by a paged, cursor-resumable backfill over `snapshots` — keys are identities, time is an attribute, never embedded in a key; no stored index/average (2026-07-14 revision) — every number is a read-time fold over a golfer's own lines |
| `connections` | `connectionId` → subscriptions | WS fan-out |

Scale check: an outing is ~144 players ≈ 36 concurrent rounds ≈ a few thousand events across
an afternoon — trivial for this shape. Nothing here is provisioned for imaginary scale.

### Packages (target layout, conventions-conformant)

```
domain            scoring/ round/ golfer/ crew/ course/ competition/ — pure, zero deps
application       use cases (StartRound, RecordScore, FinalizeRound, LeaveRound, …)
                  ports/: RoundStore, EventJournal, Broadcast, IdentityProvider, Clock, IdGenerator, Logger
contracts         Zod schemas for HTTP + WS wire types (client depends on these, never on application)
adapters-dynamodb createDynamoRoundStore, createDynamoEventJournal, …
adapters-apigateway  createApiGatewayBroadcast
adapters-cognito  createCognitoIdentityProvider
adapters-powertools  createPowertoolsLogger
lambda            ONE package: entries http/, ws/, projector/, rebuild/; one composition root
client            sync engine + SDK (ESM build consumed by the web app's bundler)
apps/web, apps/infra-cdk
```

Layer direction `domain → application → adapters → lambda` is lint-enforced against this
layout (conventions §2c), including the client→contracts-only rule.

## 4. Testing strategy

- **Golden cards** — the correctness heart. Fixture scorecards with known outcomes per format:
  dots land on the right holes, strokes resolve correctly, skins carry and validate, net double
  bogey caps, 3&2 means 3&2. Every format ships with its deck; every scoring bug becomes a card.
- **Property tests:** net ≤ gross; client/server reducer parity; replay idempotence; merge
  order-independence (the HLC/LWW claim, tested as a property).
- **Convergence simulation:** N virtual phones, randomized offline windows, corrections,
  duplicate and out-of-order delivery — every interleaving must converge to the sequential
  oracle's state. One bench covers ordering, merge, and idempotency.
- **Settlement determinism:** settle every fixture twice, assert byte-identical archives;
  rebuild projections from archives and diff against incrementally-built ones.
- Adapters get contract tests against local DynamoDB; `lambda` entries stay too thin to need
  much. Weight goes where the complexity hides (conventions §5).

## 5. Deliberate non-choices

- **No event sourcing outside the Round.** Crews, courses, golfers, competitions are boring
  CRUD entities. ES pays rent only where the domain *is* a stream.
- **No general CRDT machinery.** One LWW-register per score cell, resolved by author HLC with
  full audit, is the entire merge surface — no merge libraries, no operational transforms.
- **No microservices, no queues beyond DynamoDB streams, no GraphQL.** One lambda package,
  per-trigger entries, Zod-contracted HTTP + WS. An event bus earns its place only when
  projector count demands it.
- **Cognito stays a dumb credential box** behind the `IdentityProvider` port — all identity
  subtlety lives in the domain (`GolferId` ≠ sub), so swapping it later is an adapter, not a
  redesign.
- **Nothing imported from the POC.** Its validated lessons — join-code friction, reconnection
  UX, events-reduced-on-client — are re-designed here, not carried over as code.

## 6. How the arc lands on this (the no-rework demonstration)

| Ships | What gets added | What is untouched |
| --- | --- | --- |
| **v1** | everything above except Competition, milestones, feed, course book | — |
| **v1.1** | Nassau+presses: a `GameConfig` + `PressOpened` (log already carries game events). Junk: configs. Card images: a render adapter. Stat tags: a new optional event type | round log schema, sync protocol, all projections |
| **v2** | `Competition` (trip) + standings/trophy projections; team-game configs (foursomes, scramble, shamble, Wolf, Vegas, Sixes); milestones/feed/course book as new projections over the existing archive | Round aggregate, games engine core, the stroke-resolution rule, crew ledger |
| **v3** | league fixture generation + a scheduler entry; outing flights + banquet channel; Season in Golf as a year-end projection | everything else |

Every row adds union members, projections, or entries — never a migration of the round log,
the sync protocol, or an existing projection's source of truth.
