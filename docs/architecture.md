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
Golfer history, the swng Index, crew ledgers, head-to-head records, competition standings,
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

One identity for a playing life. **Ghost vs. account is an authentication fact, not a domain
distinction** — the domain treats every golfer identically (scores, index, ledger). Claiming a
ghost attaches credentials to the existing `GolferId`; nothing else moves, so history is
continuous by construction.

```ts
interface Golfer {
  id: GolferId
  name: string
  homeCourseId?: CourseId
  handicap: HandicapProfile   // declared | official (manually maintained) | computed
}
```

The computed swng Index takes over automatically once 54 holes are archived (roadmap's
bootstrap rule); an official index, if maintained, always wins. If a claim collides with an
existing account, `GolferMerged { fromId, toId }` is a recorded fact: the old id becomes a
permanent alias and projections rebuild with alias resolution — a script, not a crisis.

### Course

```
Course ─ TeeSet[] ─ rating, slope (18- and 9-hole) ─ Hole[] { par, yardage, strokeIndex }
```

Tee sets are **versioned and immutable** — corrections create a new version; verification
(`verifiedBy`) and provenance (community-entered | imported) are per-version metadata.
**Rounds freeze a `CourseCard` snapshot at start**, so history never rewrites regardless.
The licensing buy-vs-build stays open (roadmap); the entity models either source.

### Round — the only event-sourced aggregate

A `Round` is: a frozen `CourseCard`, participants (with tee and course handicap frozen at
join — you play at the handicap you started with), attached games, and its event log.
Lifecycle is an explicit enum: `setup → live → final` (plus `abandoned`); no null states.

```ts
type RoundEvent =
  | RoundCreated | ParticipantJoined | GameAdded
  | ScoreRecorded      // { golferId, hole, result: strokes | 'picked-up' | 'conceded', recordedBy, opId, hlc }
  | PressOpened | ConcessionGiven | PartnerPicked   // game decisions live in the same log
  | RoundFinalized | RoundReopened
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
  course snapshot, the final grid, the full event log, per-game results, and per-golfer
  differentials. Completeness rule: **the archive captures everything a projection that
  doesn't exist yet could need** — it is the replay source for all of them, and it is never
  mutated. Settlement is deterministic: re-settling the same log yields a byte-identical
  archive (enforced by test).

Rounds are small (4 players × 18 holes ≈ low hundreds of events), so full replay is cheap; a
maintained snapshot item exists purely as a read optimization, never as truth.

### The games engine (in `domain/scoring/`)

`GameConfig` is a discriminated union; each format contributes a config type, a `GameState`
type, and a reducer. Handicap allowances live in a domain table with per-format defaults
(overridable in config). Formats that involve in-round decisions (presses, concessions, Wolf
picks) consume their decision events from the round log.

v1 members: `strokePlay` (gross/net), `stableford`, `singlesMatch`, `fourballMatch`, `skins`.
Growing the menu — Nassau, quota, foursomes, scramble, shamble, Wolf, Vegas, Sixes — adds
union members and reducers. Nothing else in the system knows format internals; a `GameState`
renders and a `GameResult` settles.

### The handicap engine (in `domain/handicap/`)

Pure WHS math: differential `(113 / slope) × (adjustedGross − rating)`; adjusted gross via net
double bogey; index = average of best 8 of last 20; 9-hole rounds emit raw 9-hole
differentials, and the index projection combines two into one 18-hole differential per the
published 2020 WHS rule — the 2024 expected-differential method is a closed calculation the
governing bodies do not publish, and swng does not ship unverifiable constants. PCC likewise
deliberately omitted — the swng Index is honest-unofficial (`product.md` §10).
Index history is a projection of `IndexSnapshot`s recomputed at each finalize.

### Crew — plain entity, no event sourcing

Roster (members with role and status; ghosts welcome), standing-game presets (bundles of
`GameConfig`s plus course/tee defaults — *"play the usual"* is a preset applied at round
creation). A round is a crew round via an optional `crewId` tag at creation. The ledger,
head-to-head records, and season boards are projections keyed by that tag — the Crew entity
itself stores no results.

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
DynamoDB:  rounds (log + snapshot) │ core (entities) │ projections │ connections
                └── streams ──► projector entry ──► projections + channel fan-out
```

- **Commands** validate against current state and append events; **queries** read snapshots
  and projections. Contracts are Zod schemas in `@swng/contracts`, parsed once by the
  dispatcher table (conventions §3).
- **Realtime:** an append broadcasts to the round's channel. Finalization flows through the
  DynamoDB stream to the projector, which updates ledgers/standings/index and broadcasts to
  projection channels — the trip's Cup board and the outing's banquet leaderboard are just
  big-screen subscribers to a standings channel. Spectator mode is the round channel with a
  read-only token.
- **Offline sync** is owned by the client SDK: a durable outbox (IndexedDB behind a storage
  port) + last-seen `seq`; the sync loop pushes queued events (deduped by `opId`) and pulls
  since `seq`, and the HLC merge makes rebasing free — stale pushes can't clobber newer
  intent. **The WebSocket is delivery sugar; HTTP catch-up is the correctness path** — a
  dropped socket costs latency, never state.

### Identity & access

- Cognito (email + social sign-in) behind a JWT authorizer. **`GolferId` ≠ Cognito sub** — an
  identity mapping links them, which is exactly what makes ghost-claiming a one-row operation.
- Join code → exchanged for a round-scoped participant token (score without an account).
- Share link → read-only spectator token. Same mechanism, narrower capability.

### Persistence sketch (DynamoDB)

| Table | Keys | Holds |
| --- | --- | --- |
| `rounds` | `ROUND#id` / `EVT#seq`, `SNAPSHOT`, `ARCHIVE`, `META` | the log (conditional put on seq enforces order) and the immutable archive |
| `core` | `GOLFER#id`, `CREW#id` (+member items), `COURSE#id`, `COMP#id` (+fixtures) | entities; GSIs: join code, cognito sub, golfer→crews |
| `projections` | `INDEX#golfer`, `LEDGER#crew#season`, `H2H#crew#a#b`, `STANDINGS#comp`, `HISTORY#golfer` | versioned, rebuildable by replay (a rebuild entry point replays finalized rounds) |
| `connections` | `connectionId` → subscriptions | WS fan-out |

Scale check: an outing is ~144 players ≈ 36 concurrent rounds ≈ a few thousand events across
an afternoon — trivial for this shape. Nothing here is provisioned for imaginary scale.

### Packages (target layout, conventions-conformant)

```
domain            scoring/ handicap/ round/ golfer/ crew/ course/ competition/ — pure, zero deps
application       use cases (StartRound, RecordScore, FinalizeRound, ClaimGhost, …)
                  ports/: RoundStore, EventJournal, Broadcast, IdentityProvider, Clock, IdGenerator, Logger
contracts         Zod schemas for HTTP + WS wire types (client depends on these, never on application)
adapters-dynamodb createDynamoRoundStore, createDynamoEventJournal, …
adapters-apigateway  createApiGatewayBroadcast
adapters-cognito  createCognitoIdentityProvider
adapters-powertools  createPowertoolsLogger
lambda            ONE package: entries http/, ws/, projector/, rebuild/; one composition root
client            sync engine + SDK (browser build via tsup)
apps/web, apps/infra-cdk
```

Layer direction `domain → application → adapters → lambda` is lint-enforced against this
layout (conventions §2c), including the client→contracts-only rule.

## 4. Testing strategy

- **Golden cards** — the correctness heart. Fixture scorecards with known outcomes per format:
  dots land on the right holes, allowances apply, skins carry and validate, net double bogey
  caps, 3&2 means 3&2. Every format ships with its deck; every scoring bug becomes a card.
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
| **v2** | `Competition` (trip) + standings/trophy projections; team-game configs (foursomes, scramble, shamble, Wolf, Vegas, Sixes); milestones/feed/course book as new projections over the existing archive | Round aggregate, games engine core, handicap engine, crew ledger |
| **v3** | league fixture generation + a scheduler entry; outing flights + banquet channel; Season in Golf as a year-end projection | everything else |

Every row adds union members, projections, or entries — never a migration of the round log,
the sync protocol, or an existing projection's source of truth.
