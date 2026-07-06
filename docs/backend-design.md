# SWNG — Backend & Domain Design

> Status: proposed. This is the target design for the "proper" system. It supersedes the
> proof-of-concept and is written assuming **no backward compatibility** with existing data —
> the current beta holds disposable POC rounds, so we cut over cleanly rather than migrate.
>
> This revision incorporates a critical design review; the hard parts (match-play handicapping,
> per-round ordering under concurrency, guest-credential secrecy, claim/merge, and offline
> on-course play) have been specified rather than glossed.
>
> Companion to [`PUNCHLIST.md`](./PUNCHLIST.md), which states the problem. This states the design.

---

## 1. High-level design

The current system models **one anonymous round at a time**. Everything downstream of that
limitation — no identity, no history, no tournaments, no scoring formats, fragile sessions — is a
symptom of a single missing idea: a **persistent actor**.

This design is built on one spine and four load-bearing decisions.

**The spine — identity:** Everyone who touches the system is a `User`. A `User` is persistent and
spans rounds. Guests are Users too (`kind: "guest"`), just ephemeral until they participate or are
claimed. A round `Participant` always references a `User`. This single choice dissolves most of the
punchlist: history exists because identity persists, rejoin works because identity is durable, and
"anonymous vs authenticated" becomes one field instead of a fork in every code path.

The four decisions that hang off the spine:

1. **Store facts, derive scoring.** The only persisted scoring datum is `strokes` per (player,
   hole). Net, Stableford, match play, skins, and leaderboards are **pure functions** of facts +
   course + handicaps + format config. Scoring is one deep module with a small interface and all the
   golf complexity hidden behind it — reused verbatim on client and server for *consistency* (the
   engine is not where authority lives; §2.3). This is also what lets a round take on a format, net
   scoring, or a whole competition *mid-play* without a reset (§2.9) — the product's core stance.
2. **Authorization is a pure policy function.** `authorize(actor, action, resource)`. One question
   for every caller; all role/context logic lives in one place. This replaces the scattered inline
   `if` checks and the fragile "sort players by `joinedAt` to guess the creator" logic.
3. **A monotonic per-round sequence drives real-time and offline.** Every committed mutation is
   assigned a monotonic `seq` and appended to an ordered journal. Clients reconnect by asking "give
   me everything since `seq N`," and any detected gap triggers a snapshot refetch. Reconnection stops
   being a heuristic. We take the one useful thing from event sourcing — an ordered log — and refuse
   the rest.
4. **Sessions bind to Users, not to rounds.** A session identifies *who you are*, stored durably
   (localStorage), not *which player-in-which-round you are*, stored per-tab. Tab close, second tab,
   and same-device rejoin stop being special cases.

```
                          ┌──────────────────────────────────────────────┐
   External IdP  ───────▶ │  Session  ──▶  User  ◀── Participant ──▶ Round │ ──▶ Event
   (registered auth)      └──────────────────────────────────────────────┘        (tournament)
   Guest credential ────▶                    │                    │
                                             ▼                    ▼
                                     profile, handicap,     Scoring engine (pure)
                                     history, prefs         Policy engine (pure)
```

Layering is unchanged and healthy: `domain` (pure) → `application` (orchestration) → `adapters`
(DynamoDB, API GW, IdP) → `lambda` (entry points). The new weight lands in `domain`, where it
belongs: identity types, the scoring engine, the policy engine, and handicap math are all pure and
ship to the browser as easily as to Lambda.

The rest of this document explains each decision and the *why* behind it (§2), then maps the gap
from what exists today to what we build (§3).

---

## 2. Key design decisions

Each subsection contrasts the current implementation, states the target, and explains the reasoning.
The guiding lens throughout is Ousterhout's: **complexity is what matters, and it comes from
dependencies and obscurity.** Prefer deep modules (simple interface, powerful implementation), pull
complexity downward into those modules, and design errors out of existence rather than handling them
everywhere.

### 2.1 Identity: everyone is a `User`

**Today.** There is no persistent actor. A `Player` exists only inside one round (`roundId +
playerId`) and is erased from history the moment the round ends. The creator isn't even stored — it's
re-derived by sorting players by `joinedAt` and taking the first, in the two methods that need it
(`patchRoundState`, `removePlayer`).

**Target.** Introduce a persistent `User` and make it the universal actor. A round `Participant`
references a `User`.

```ts
// domain — the persistent actor
interface User {
  userId: UserId;
  kind: "registered" | "guest";
  profile: {
    displayName: string;
    handicapIndex?: number;      // WHS index, e.g. 12.4 — the player's rating
    homeCourseId?: CourseId;
    preferences?: UserPreferences;
  };
  authSubject?: string;          // present iff registered: external IdP subject (opaque)
  createdAt: IsoDateTime;
  // lifecycle: a guest that never participates is TTL-eligible (§2.2); once it has any
  // Participant row it is promoted to non-expiring and governed by round-history retention.
}

// domain — a User's participation in ONE round (replaces `Player`)
interface Participant {
  roundId: RoundId;
  userId: UserId;                // ← the spine. every participant is a User.
  role: RoundRole;               // Host | Scorer | Participant | Spectator
  displayName: string;          // snapshot; editable per round (guests, nicknames)
  tee: TeeSetName;               // renamed from the misnamed `color`
  courseHandicap: number;       // snapshot: index → course handicap for this tee
  playingHandicap: number;      // snapshot: course handicap × format allowance (§2.3)
  status: "active" | "withdrawn";
  joinedAt: IsoDateTime;
}
```

**Why unify guests and registered users under one type.** The alternative — a `Player` that
*optionally* links to an account — pushes a conditional into every call site: "is this player linked?
if so … else …". That is exactly the obscurity Ousterhout warns against: a distinction that leaks
everywhere. Making a guest a first-class `User` with `kind: "guest"` collapses that conditional into a
single field that most code never reads. `Participant → User` is total, not partial. History,
handicap, and preferences attach to `User` uniformly. When a guest signs up, we **claim** their guest
`User` into a registered one (§2.2). The registered/guest split lives in one field and in the
authentication mechanism (§2.2), not in the domain logic.

**Why store the host first-class.** `Round.hostUserId` replaces the `joinedAt`-sort derivation. The
current approach is fragile (ties, clock skew, the host leaving) and it is *information leakage*:
authorization reaches into player ordering to reconstruct a fact the system should simply know. Store
the fact once.

### 2.2 Sessions & authentication: durable, user-bound, unified actor

**Today.** A session is a `(roundId, playerId)` pair in `sessionStorage`, sent as `x-session-id`.
`sessionStorage` is per-tab and dies with the tab. The consequences are all in the punchlist: close the
tab and your scores orphan; open a second tab and you're a second player; no cross-device; no notion of
a logged-in user.

**Target.** A session identifies a **User**, not a player-in-a-round. The *actor* is unified; the
*authentication mechanism* differs by kind and is hidden behind an `IdentityProvider` port. We do
not force one storage row to model two mechanisms:

```ts
// what every request resolves to — uniform regardless of how it was authenticated
interface Principal {
  userId: UserId;
  kind: "registered" | "guest";
}

// guest sessions are our own opaque, stored, revocable tokens
interface GuestSession {
  token: string;              // opaque, high-entropy; stored server-side (SESSION#<token>)
  userId: UserId;
  issuedAt: IsoDateTime;
  expiresAt: IsoDateTime;     // sliding window
}
// registered sessions are provider-issued (Cognito JWT) and validated by the IdentityProvider
// port; there is no SESSION# row for them. Revocation/expiry semantics live behind the port.
```

**Storage & transport: localStorage + bearer, deliberately.** The token lives in `localStorage`
and travels as an `Authorization: Bearer` header (HTTP) and a `$connect` query parameter (WebSocket —
browsers cannot set headers on the socket; the existing WS authorizer already reads a token from the
query string, so this is consistent with current infra). This is a security decision, not a
transport nicety: the SPA and API are on different origins (CloudFront vs. API Gateway), which makes
cross-site cookies painful (SameSite/CORS-credentials) and CSRF a live concern. A bearer token in
`localStorage` is CSRF-immune and trivial to attach to both HTTP and WS; its cost is XSS-readability,
which we accept and mitigate at the app layer (strict CSP, no raw HTML injection). We do **not** treat
cookie-vs-localStorage as interchangeable.

Two ways a session comes to exist, behind the `IdentityProvider` port:

- **Registered.** The user authenticates against a **Cognito User Pool** (hosted sign-in:
  email/password or passwordless email OTP, plus Google/Apple social federation via OIDC). Cognito
  issues a JWT; we validate it, look up or create the `User` by `authSubject` (the Cognito `sub`), and
  establish a principal. Login is repeatable, so it works across devices.
- **Guest.** `POST /guest` mints a guest `User` and a `GuestSession`, stored in `localStorage`. This
  endpoint is unauthenticated and therefore rate-limited / abuse-guarded, and abandoned guests are
  TTL-reaped. Reopening the app on the same device resumes the same guest `User`.

**Request authorization splits by kind, but handlers never see the split.** Registered requests carry
the Cognito JWT, validated at the edge by API Gateway's native JWT authorizer; guest requests carry our
opaque token, validated by a Lambda authorizer that resolves it to a `userId`; the WebSocket `$connect`
Lambda authorizer accepts either. Downstream handlers receive only a resolved `Principal` and never
learn which path produced it — the unified actor of §2.1, enforced at the boundary.

**Sharing and cross-device — the access code and the identity credential are different tokens.**
These have opposite secrecy requirements and must never be conflated:

- The **access code** is *meant to be shared*. It lets a recipient **join as themselves**. It rides
  the round link.
- The **guest identity credential** *is* a `User` (a bearer token). It must **never** ride a
  shareable link — URLs leak via referrers, chat previews, logs, and screenshots, and a leaked
  credential is impersonation (every recipient becomes the *sharer's* participant and scores).
- **Cross-device guest resume** is an explicit, deliberate action ("move my session to this
  device"), backed by a **separate single-use, short-TTL transfer token** — never the durable
  credential, never auto-applied on link open.

**Rejoin and orphaning (stated honestly).** Two independent mechanisms make same-device rejoin
robust and, in the common case, eliminate orphaned scores:

1. **Durable storage.** `localStorage` survives tab close and is shared across tabs.
2. **Idempotent join.** Joining a round you're already in returns your existing `Participant` (keyed
   by `(roundId, userId)`) rather than minting a new one. Even if a session is re-established, the same
   `User` re-attaches to the same `Participant` and scores.

Orphaning is *eliminated while the credential persists*. It is **not** impossible: users clear
storage, use private windows, and Safari/ITP can evict it — a fresh browser is a fresh guest, and its
prior scores stay under the old `userId`. The honest mitigation is the claim-to-register nudge, not a
promise we can't keep.

**Claim / merge is an async, idempotent job — not "free".** A guest who signs up triggers a
claim. Because `Score` is keyed by `(roundId, userId)` and journal payloads embed `userId`, claim is a
cross-partition rewrite, not a pointer swap. We specify it concretely:

- Maintain an **alias map** `AliasItem { fromUserId → toUserId }`. History and journal lookups
  indirect through it, so already-emitted journal entries that still carry the old `userId` resolve
  correctly without rewriting the log.
- Rewrite `Participant`/`Score` rows (the key changes, so it is delete-and-write) as an **idempotent
  background job**, safe to retry.
- Define the **same-round merge conflict** explicitly: if the guest and the now-registered user both
  have a `Participant` in the same round, the registered participant's scorecard wins and the guest's
  is discarded (or, if only one has scores, the non-empty one wins). This must be a stated rule, not
  an accident.

**Why delegate registered auth to a provider (behind a port).** Auth is security-critical, deep, and
adjacent to compliance. Owning password storage, token rotation, and social federation is complexity we
should *not* pull into this codebase. The `IdentityProvider` port keeps the domain and application
layers ignorant of the vendor and trivially testable with a fake. We own only the thin, non-secret
parts we must: guest-credential minting, transfer tokens, and the alias map. (Provider choice is an
owner decision; see §3.4. The port makes it swappable, so it is not on the critical path.)

**Honest limitation.** Two anonymous devices with no shared credential are, by definition, two
different guest `User`s — the system cannot know they are the same person. Claim/merge fixes it
retroactively once they authenticate.

### 2.3 Scoring: store facts, derive everything

This is the deepest module in the system and the one that most changes the product's ceiling.

**Today.** The domain stores raw `strokes` and nothing else. All scoring math lives in the web app
(`roundCalcs.ts`): gross-only, hardcoded to a 9+9 front/back split, always reads `teeSets[0]` (ignoring
each player's actual tee), no concept of handicap/net/Stableford/match/skins, and **ties broken by
array index** — nondeterministic and unsuited to a shared authoritative computation.

**Target.** Persist exactly one fact — `strokes` per (player, hole) — and derive *all* scoring through
a pure engine. Every named format remains a pure function of `(strokes, course, handicaps, config)`;
what changes from the first draft is that the **result shapes** and the **handicap allocation** are now
correct for formats that are not simple stroke totals.

```ts
// domain — the only persisted scoring fact (irreducible truth)
interface Score {
  roundId: RoundId;
  userId: UserId;             // whose score
  holeNumber: number;
  strokes: number;
  enteredBy: UserId;          // who keyed it (scorer/audit)
  opId: string;               // client-generated idempotency key (§2.7)
  seq: number;                // monotonic seq assigned at commit (§2.6)
  updatedAt: IsoDateTime;
}
```

**Formats are pure, but their results are not all leaderboards.** Forcing match play and
skins into one `LeaderboardEntry` with optional fields was a leaky god-object — every consumer would
have to know which fields are valid for which format, which is the obscurity a deep module must hide.
Instead the engine returns a **discriminated union** keyed by format, each variant carrying exactly its
own fields:

```ts
interface ScoringInput {
  course: CourseSnapshot;
  participants: ScoringParticipant[];   // { userId, playingHandicap, tee }
  strokes: StrokeGrid;                  // (userId, hole) → strokes
}

type FormatConfig =
  | { format: "stroke";     scoring: "gross" | "net" }
  | { format: "stableford"; scoring: "gross" | "net"; allowance: number }
  | { format: "match";      pairing: [UserId, UserId] | Team[]; allowance: number }
  | { format: "skins";      scoring: "gross" | "net"; carryover: boolean; validation?: "carry" };

type ScoringResult =
  | StrokeLeaderboard      // ordered entries: { userId, gross, net?, thru, toPar }
  | StablefordLeaderboard  // ordered entries: { userId, points, thru }
  | MatchResult            // pairwise/graph: per-pair status ("3&2", "AS"), not a linear list
  | SkinsLedger;           // per-hole: { hole, winner?: UserId, carriedTo?: number, value }

interface ScoringFormat {
  readonly id: FormatId;
  score(input: ScoringInput, config: FormatConfig): ScoringResult;
}
```

Handicap math is a set of pure helpers, and only the engine touches them. The allocation differs by
format, and the first draft's single absolute helper was wrong for match play:

```ts
// index → course handicap for a tee.  NOTE: 9-hole rounds need 9-hole rating/slope and a
// halved index; v1 scopes full handicapping to 18-hole rounds — 9-hole handicapping is
// explicitly deferred until TeeSet carries 9-hole rating/slope.
function courseHandicap(index: number, tee: TeeSet, holeCount: number): number;

// playing handicap applies the format allowance (e.g. stroke-net 100%, four-ball 85%,
// singles match 100% of the difference). The punchlist names "playing handicap" explicitly.
function playingHandicap(courseHandicap: number, allowance: number): number;

// STROKE / STABLEFORD (net): absolute strokes received per hole from the player's own handicap.
function strokesReceived(playingHandicap: number, strokeIndex: number, holeCount: number): number;

// MATCH: allocation is RELATIVE to the low handicapper in the pairing (the "difference method").
// Only the higher player receives strokes = (theirPH − lowPH), on the lowest stroke-index holes.
// This lands strokes on DIFFERENT holes than absolute netting, so per-hole match results differ —
// it cannot be expressed by netting each player independently.
function matchStrokesReceived(pairing: PlayingHandicaps, strokeIndex: number, holeCount: number): HoleAllocation;
```

Match play is therefore modeled as a **pairwise/graph** result (relationships like "A beat B 3&2",
"all square"), not an entry in an ordered list — for more than two players there is no single
leaderboard. Skins is a **stateful fold** over ordered holes (carryovers) that is still pure, but its
result is a **per-hole ledger** (who won each hole / what carried), not a single `skinsWon` integer.

**Deterministic tie-breaking.** The engine breaks ties by USGA countback — back-9, back-6,
back-3, then the 18th — and finally a stable key (`userId`), never by array position. This is required
for the client and server to agree; the current index-based tiebreak would silently disagree across the
two.

**Why derive instead of store.** Raw strokes are the single source of truth; every other number is a
*view*. Storing net or points would make every handicap correction, tee change, or rules tweak a
migration with drift risk. A pure engine has none of that. The write path stays trivial: upsert one
integer.

**Why the same engine runs on client and server — and what that does and doesn't buy.** Because
`domain` is pure and ships to the browser, both sides run the identical engine, so a client's optimistic
leaderboard and the server's standings **agree** given the same inputs — that is *consistency*, and it
is the engine's job. It is **not** authority. Authority is entirely about *who may write strokes* and
*whether the server trusts a submitted stroke* — that lives in the score-write path and `authorize`
(§2.5), not in the engine.

**Why a closed set of formats, not a rules engine.** The universe of golf formats is small and
well-known. A general-purpose rules engine would be over-general — deep in the wrong direction. Four
concrete implementations behind one interface is the right generality: adding a format is one pure
function; callers are unaffected.

**Correctness fix embedded here:** `TeeHole.handicapIndex` → `strokeIndex`. It is the per-hole
difficulty ranking (1..holeCount), not a handicap index (a player's rating, now on `User.profile`). The
current name is doubly wrong and would poison every handicap calculation.

### 2.4 Tournaments: a first-class grouping and a format-specific aggregation seam

**Today.** Nothing. A round belongs to no parent; there is no competition, cross-round leaderboard, or
flight.

**Target.** An `Event` groups rounds, entrants, and results under a shared format and configuration.

```ts
interface Event {
  eventId: EventId;
  name: string;
  hostUserId: UserId;
  format: FormatId;                 // default scoring format for its rounds
  config: EventConfig;              // divisions (gross/net), flights, aggregation strategy
  entrants: UserId[];               // registered participants
  status: "setup" | "active" | "completed";
  startDate: IsoDate;
  endDate?: IsoDate;
}
```

A `Round` gains an optional `eventId`. Standalone rounds (the common case, including all anonymous play)
have none. **Event standings are derived by the scoring engine**, but aggregation is **format-specific,
not a single `sum | best-N`.** Stroke and Stableford aggregate cleanly across rounds (sum, or
best-N of M). Match-play events (e.g. Ryder-cup points) and skins do **not** fall out of numeric
aggregation — they need their own aggregation strategy over per-round results, and flights, cut lines,
and gross/net divisions may need hole-level data beneath the per-round result. The design provides the
*seam* (a per-format `aggregate(perRoundResults, config)`), not a claim that all standings are one sum.

**Why keep the Event deliberately thin.** The punchlist asks for "a first-class model that groups rounds
under a shared context, with configurable formats." It does not ask for tee-time scheduling, payouts, or
brackets — building those now would be speculative generality. We model the grouping and the aggregation
seam precisely and stop; real tournament requirements later extend `EventConfig` and add aggregation
strategies without touching the scoring engine or the round model.

### 2.5 Authorization: one pure policy function

**Today.** Rules are inline and inconsistent. `updatePlayer` is self-only; `patchRoundState` is
creator-only (creator re-derived by sort); `removePlayer` mixes self-and-creator logic; `updateScore`
lets **anyone in the round edit anyone's score** *and never checks the target is a real participant*, so
you can currently write a score for a nonexistent player (a bug to fix, not preserve). Reads are
gated by `ensureSessionForRound`. The rules are smeared across `RoundService`.

**Target.** A single pure function with a fully specified resource, covering reads as well as writes.

```ts
// domain — the whole authorization surface
type Action =
  | "round.read" | "round.updateStatus" | "round.removeParticipant"
  | "score.write" | "participant.updateProfile" | "event.manage";

interface Actor {                 // hydrated ONCE per request (see below)
  userId: UserId;
  roundRole?: RoundRole;          // Host | Scorer | Participant | Spectator
  eventRole?: EventRole;          // Director (cascades to child rounds) | Entrant
}

interface Resource {              // MUST carry the ids a decision needs
  roundId?: RoundId;
  eventId?: EventId;
  ownerUserId?: UserId;           // e.g. the target score/participant's owner — required for "self"
  scoringPolicy?: ScoringPolicy;  // the round's policy, so score.write can be decided
}

interface Decision { allow: boolean; reason?: string }   // reason for UI/telemetry, not bare boolean

function authorize(actor: Actor, action: Action, resource: Resource): Decision;

// the round-level policy that makes today's implicit rule an explicit choice
type ScoringPolicy =
  | "group"      // any active participant may enter any score (shared-phone case) ← current de-facto
  | "self"       // participants enter only their own (needs resource.ownerUserId)
  | "scorerOnly";
```

**Actor resolution is I/O and is located, not scattered.** The function is pure, but hydrating
`roundRole`/`eventRole` from `(userId, roundId/eventId)` is a database read. That read happens **once per
request** in a single `resolveActor(userId, context)` in the application layer, whose result is passed to
`authorize`. This is the opposite of the current design's per-decision lookups: one hydration, one pure
decision.

**Why a pure function is the right shape.** Authorization is a classic deep module: callers ask one
question and every role, context, and cascade rule hides behind it. You can answer "what can a Scorer
do?" by reading one table. Centralizing lets rules vary by context — the tournament-director case is an
`eventRole` the function consults, not a rewrite of every handler. Returning a `reason` (not a bare
boolean) gives the UI something to show and telemetry something to log.

### 2.6 Real-time delivery: monotonic ordering, self-healing reconnection

**Today.** Mutations broadcast a `DomainEvent` with no ordering; the client reducer resolves score
conflicts by comparing wall-clock `updatedAt`, and there is **no way to detect a dropped message**. A
lost frame means silent divergence until the next full refetch. `RoundState.stateVersion` is a monotonic
counter, but it covers only state changes and is enforced by a single-item conditional write.

**Target.** One **monotonic `seq` per round covering every mutation**, plus an append-only journal —
but *monotonic, not gap-free*, because the real requirement is detect-and-resync, not perfect density.

```ts
interface JournalEntry {
  roundId: RoundId;
  seq: number;                 // strictly increasing per round; gaps permitted
  type: DomainEventType;
  occurredAt: IsoDateTime;
  payload: unknown;            // score, participant, state, …
}
```

**Where `seq` comes from, and why not a hot counter.** Assigning a *gap-free* per-round counter
synchronously would force every write through one item and demand a `TransactWriteItems` (counter +
state row + journal row) on **every stroke** — hot-partition contention and latency, exactly the
`stateVersion` pattern the current code uses, now on the write-heavy path. We reject that as the default.
Instead:

- **Writes are contention-free idempotent upserts** keyed by natural key (`roundId, userId, hole`),
  carrying the client's `opId` so retries are safe. No counter on the write path.
- **A serializer assigns `seq` at commit** — via DynamoDB Streams (one ordered consumer per round) —
  and appends the journal entry and fans out to WebSocket connections. `seq` is monotonic per round;
  clients must not assume it is dense.
- The HTTP write response echoes the accepted fact; the authoritative `seq` arrives via the journal
  shortly after (the client has already applied its own write optimistically), so the client never
  blocks on `seq`.

This keeps **current-state rows authoritative and the journal a derived delivery log** without the
divergence risk, because the journal is *produced from* the committed writes rather than written in a
separate, un-coordinated step. (If a specific feature ever needs strict synchronous ordering — e.g. live
match-play hole results — the transactional gap-free variant remains available as a documented, opt-in
alternative for that path. It is not the default.)

**Reconnection protocol.** Ordered to avoid both duplicates and misses:

1. Fetch snapshot → `{ ...snapshot, seq }`.
2. Open WebSocket; `$connect` carries the bearer token in the query string and is validated by a
   Lambda authorizer that maps the connection to a `userId`; **read authorization** (§2.5
   `round.read`) decides whether this user may subscribe (participant/host/scorer/spectator vs.
   stranger). Connection→`userId` is persisted for fan-out.
3. Subscribe with `lastSeq = snapshot.seq`; the server replays journal entries `> lastSeq`, then
   streams live.
4. The client dedupes by `seq` and, on **any detected gap** (or a `lastSeq` older than the journal
   horizon, TTL ~24–48h), refetches the snapshot. Gap→refetch is the self-healing safety net that
   makes misses a normal, correct path rather than an error.

**Why this dissolves the reconnection problems.** "Resume after backgrounding," "switch devices,"
"recover from flaky signal" are the same question — *what did I miss?* — and `seq` answers it. This is
"define errors out of existence" applied to the network.

**Why not event sourcing.** A scorecard is a small mutable grid, naturally current-value rows with
idempotent upserts; full event sourcing adds replay, snapshotting, and projection rebuilds for no payoff
at this scale. We take total order for delivery and keep current-state rows authoritative — the simpler
design that loses nothing we need.

### 2.7 Offline & on-course score entry

**This is the product's entire point and was missing from the first draft.** Golf courses have
terrible connectivity; a design that assumes a live socket and a server-assigned `seq` per write does
not survive the 6th fairway. The `seq`/journal model above is chosen partly to make this tractable.

**Target — optimistic, queue-and-sync:**

- **Client-side durable write queue.** Score edits are written to a local durable store (IndexedDB)
  and applied to the local snapshot immediately. Each edit carries a **client-generated `opId`**
  (idempotency key) and the local monotonic revision it was based on.
- **Idempotent server upserts.** On connectivity, the queue flushes. The server upsert is keyed by
  `(roundId, userId, hole)` and deduplicated by `opId`, so replays and retries are safe; the server
  assigns `seq` **on arrival**, not at entry time. An offline client therefore never needs a `seq` to
  make progress.
- **Reconnect reconciliation.** On reconnect the client (a) replays the journal since its `lastSeq`
  to fold in others' changes, then (b) flushes its own queued writes, then (c) re-derives leaderboards
  from the merged facts. Because both directions are idempotent upserts of independent (player, hole)
  cells, they compose without a merge algorithm.
- **Same-cell conflicts are last-write-wins, and that is a stated choice, not an accident.** For a
  shared scorecard, LWW on a single (player, hole) cell is acceptable; the UI surfaces when a value it
  wrote was superseded by another scorer rather than silently discarding it. Wall-clock `updatedAt` is
  replaced by `seq` for deterministic resolution.

**Why this is the right shape.** The on-course reality is "enter scores now, sync later." Making the
fact (`strokes`) the unit of sync, keying it naturally, and making every write idempotent means offline
is not a special subsystem — it is the same write path with a queue in front. Ordering (`seq`) is a
delivery concern layered on top, never a prerequisite for entry.

### 2.8 Persistence: single-table, access-pattern-driven

**Today.** A well-built single DynamoDB table (`swng-main-{stage}`, on-demand, GSI1) keyed by
`ROUND#/SESSION#/COURSE#` partitions. It is fine for what it does. What it *cannot* do is answer "what
rounds has this user played?" — because there is no user.

**Target.** Keep single-table (cheap, on-demand, right for known access patterns). DynamoDB is designed
backward from access patterns, so here they are with their keys:

| Access pattern (what the UI needs) | Key / index |
| --- | --- |
| User by id | `PK=USER#<userId>`, `SK=PROFILE` |
| User by auth subject (login) | GSI `AUTH#<subject>` → user |
| **User's round history (home screen)** | GSI `USER#<userId>` over participation rows, sorted by date |
| Guest-user alias (claim/merge) | `PK=ALIAS#<fromUserId>` → `toUserId` (§2.2) |
| Round snapshot (config, state, participants, scores) | `PK=ROUND#<roundId>` query |
| Round by access code | GSI `CODE#<accessCode>` |
| Round event journal (catch-up) | `PK=ROUND#<roundId>`, `SK=SEQ#<zero-padded>`, TTL |
| Event by id / its entrants / its rounds | `PK=EVENT#<eventId>` query |
| Course catalog + a course by id | `PK=COURSE#<courseId>`, GSI `COURSES` |
| Guest session lookup | `PK=SESSION#<token>` → userId, TTL |
| Round connections (broadcast fan-out) | `PK=ROUND#<roundId>`, `SK=CONN#<id>` → userId, TTL |

The load-bearing addition is the participation row carrying a `USER#<userId>` GSI key: it makes a user's
history a single query instead of an impossible scan. Course snapshots stay embedded in the round for
reproducibility (a round must render identically even if the course is later edited).

**Dropped: course versioning.** The first draft kept an embedded `CourseSnapshot` *and* `#V<n>`
catalog versions. If the snapshot makes a round self-contained, no stated access pattern needs
historical catalog versions — that is speculative generality, cut until a concrete "how did this course
change?" query exists.

**Write-path notes.** The `stateVersion` optimistic-lock pattern generalizes only where genuinely
needed (round status transitions), not to the per-stroke path, which is idempotent upsert (§2.6–2.7).
Round and event *creation* take a client idempotency key so retries don't double-create.

**Why not a relational store.** The access patterns are few, key-based, and latency-sensitive;
on-demand DynamoDB serves them at trivial cost and operational weight. If cross-round *analytics* later
justify it, that is a downstream read-model, not a change to the write path.

### 2.9 Round lifecycle, progressive structure, and small correctness fixes

**Today.** `RoundState.status` is typed `"IN_PROGRESS" | "COMPLETED" | null`, where `null` is never set
but is permitted — an obscurity every consumer must defensively handle. (The `RoundStatus` alias itself
is `"IN_PROGRESS" | "COMPLETED"`; the `null` lives on the field.)

**Target.** An explicit lifecycle with no null:

```
SETUP  →  ACTIVE  →  COMPLETED
                 ↘  ABANDONED
```

`SETUP` is *optional staging*, not a gate: the default path — the frictionless casual round — is created
directly in `ACTIVE` with sensible defaults, and an organizer who wants to configure before players
arrive may start in `SETUP`. Crucially, configuration is **not** confined to `SETUP`. The state machine
is small and total, so illegal transitions are rejected in one place.

**Progressive structure — configuration is mutable, never declared up front.** The product's core stance
is that a round starts frictionless and takes on seriousness *progressively, even mid-round, without
restarting* (see [`product-design.md`](./product-design.md)). The backend makes this cheap rather than
special: because the only persisted fact is `strokes` (§2.3), a round's **format, `scoringPolicy`,
handicap allowance, and event attachment are mutable attributes of the round**, not creation-time
constants. Change any of them and standings simply **re-derive from the same immutable stroke grid** — no
migration, no recompute of stored values, no reset. "Back nine for skins" or "actually, make this net" is
a config patch, not a new round.

Consequences to design for:

- **Handicap/net formats gate on identity.** A net or allowance-adjusted result requires each participant
  to have a handicap index, which requires the identity ring (§2.1–2.2). Until a participant has one they
  score **gross only**; adding an index (by signing in or entering one) upgrades them in place. The
  casual→competitive ring, expressed at the data layer rather than as a separate mode.
- **Playing-handicap snapshots follow the config.** `Participant.playingHandicap` is a snapshot of
  `courseHandicap × allowance`; when the format/allowance changes mid-round it is recomputed from known
  inputs (index, tee, allowance), so it never drifts from the active format.
- **Trust scales with seriousness.** Every score already carries `enteredBy`, `updatedAt`, and `seq` on
  the current row (a lightweight trace); the append-only journal records each change but is TTL'd for
  delivery, not audit (§2.6). Competitive/event rounds additionally persist a **durable score-change
  audit** beyond the journal horizon — those are the rounds that are someone's official record or their
  money (*trust is the feature*). Casual rounds carry only the lightweight trace: no unnecessary cost.

Rolled up, the naming/correctness corrections (each removing a latent bug or a lie in the types):

- `Player.color` → `Participant.tee`. The field held a tee-set name, never a color. Any real display
  color is a UI concern and leaves the domain.
- `TeeHole.handicapIndex` → `strokeIndex` (§2.3).
- `RoundState.status` loses `null`; lifecycle enum above.
- `RoundState.stateVersion` → `Round.seq` for delivery (§2.6); status transitions keep a conditional
  guard.
- `hostUserId` stored first-class (§2.1).
- Join is idempotent on `(roundId, userId)` (§2.2).
- `score.write` validates the target `userId` is an active participant (fixes the current
  write-for-a-nonexistent-player bug).

### 2.10 API & contracts surface

**Today.** Clean Zod contracts, but with ~7 near-identical `parseX` wrapper functions — pure
boilerplate (verified) — and a route table scoped entirely to single-round anonymous play.

**Target.** Collapse the wrappers into one generic `parse(schema, input)` (a shallow-module smell
removed), and extend the surface:

- **Auth / identity:** `POST /guest` (mint guest; rate-limited), `POST /auth/session` (exchange IdP
  token), `POST /me/claim` (guest → registered, async job), `POST /sessions/transfer` (single-use
  cross-device guest token).
- **User:** `GET /me`, `PATCH /me`, `GET /me/rounds` (history), backed by the new history query.
- **Rounds:** create requires only a course (defaults: gross stroke play, `group` scoring, no
  handicaps) — no seriousness declared up front. `PATCH /rounds/:id/config` mutates `format`,
  `scoringPolicy`, and handicap allowance mid-round; `PATCH /rounds/:id/event` attaches a round to an
  event at any time (§2.9). Participant carries `tee`; snapshot and write responses relate to `seq` as in
  §2.6.
- **Events:** `POST /events`, `GET /events/:id`, `GET /events/:id/standings`.

Sessions move from `x-session-id` to a standard `Authorization: Bearer` credential (HTTP) and a
`$connect` query token (WS), per §2.2.

---

## 3. The gap: from POC to target

Because there is **no backward-compatibility constraint**, this is a clean cutover, not a migration.
Existing beta data is disposable POC content; we deploy the new schema to fresh tables and abandon the
old rows. That removes an entire category of migration risk and lets the domain be designed for the end
state.

### 3.1 Area-by-area map

| Area | Today | Target | What it unblocks |
| --- | --- | --- | --- |
| **Identity** | `Player` scoped to one round; no persistence | `User` (registered \| guest) as universal actor; `Participant → User` | History, handicap, cross-round identity |
| **Host** | Re-derived by `joinedAt` sort (2 methods) | `Round.hostUserId` stored | Correct, stable authorization |
| **Sessions** | `(roundId, playerId)` in `sessionStorage`, per-tab | `Principal → userId`, durable `localStorage` bearer; idempotent join | Same-device rejoin, multi-tab; scores don't orphan while credential persists |
| **Auth** | None | External IdP behind a port + guest credentials + transfer token + claim/merge | Registered accounts coexisting with anonymous play |
| **Scoring** | Gross-only, UI-computed, 9+9 hardcoded, ignores tee, index tiebreak | Pure engine; discriminated-union results; countback tiebreak; store strokes only | Net, Stableford, match, skins; client/server consistency |
| **Handicap** | `TeeHole.handicapIndex` misused for display | `strokeIndex` + course/playing handicap + format allowance; match relative-allocation; 18-hole v1 | Real net & competition scoring |
| **Tournaments** | Absent | Thin `Event` grouping + format-specific aggregation seam | Competitions, cross-round standings |
| **Authorization** | Inline, inconsistent, no target-participant check | `authorize(actor, action, resource)` + read actions + `resolveActor` + `ScoringPolicy` | Uniform, context-varying rules; closes score-target bug |
| **Real-time** | Unordered events, wall-clock conflict resolution | Monotonic `seq` (stream-assigned) + journal; `since=seq` + gap→refetch | Robust reconnection without hot-counter contention |
| **Offline** | None (assumes live socket) | Durable client queue + `opId` idempotency + queue-and-sync | On-course play with bad signal |
| **Lifecycle** | `status \| null` ambiguity | `SETUP→ACTIVE→COMPLETED/ABANDONED` | Enforceable transitions |
| **Persistence** | Single-table, no user access patterns | Same table + `USER#`/`AUTH#`/`EVENT#`/`ALIAS#` + history GSI + journal | History query, events, claim/merge |
| **Contracts** | 7 duplicated `parseX` wrappers | One generic `parse(schema, input)` | Less surface, same safety |

### 3.2 Package / module changes

The clean-architecture layering is sound and stays. The work is additive, concentrated in `domain`:

- **`domain`** — add `User`, `Participant` (replacing `Player`), `Event`; the **scoring engine**
  (`ScoringFormat` + four format implementations + the discriminated `ScoringResult` + countback
  tiebreak); **handicap** helpers (course/playing handicap, absolute vs. match-relative allocation);
  the **policy** engine (`authorize`, `Resource`, roles, `ScoringPolicy`); the round **lifecycle**
  machine. Rename `color→tee`, `handicapIndex→strokeIndex`; drop `status` null; `stateVersion→seq`.
- **`application`** — split the overloaded `RoundService` into `RoundService`, `ParticipantService`,
  `ScoringService` (read/derive), `EventService`, `UserService`, `AuthService`; add `resolveActor`;
  add ports `IdentityProvider`, `EventJournal`, `ClaimJob`. Replace inline auth with `authorize`.
- **`contracts`** — new schemas (auth, user, event, format/policy on round create); generic `parse`.
- **`adapters-dynamodb`** — new item mappers and **stores** (not repositories): `RoundStore`,
  `UserStore`, `ScoreStore`, `EventStore`, `JournalStore`, `AliasStore`, …; the history + auth GSIs;
  connection→userId. Journal fed by the stream sequencer that assigns `seq`.
- **`adapters-cognito`** *(new)* — the `IdentityProvider` implementation for Cognito (`createCognito…`,
  validates User Pool JWTs, maps `sub` → `User`); isolated behind the port so tests use a fake.
- **`lambda`** *(consolidated — one package)* — a shared **composition root** (`composition/container.ts`)
  plus per-trigger entry points: `http/` (routes for rounds/scores/auth/user/event via a declarative
  route table, plus the guest token authorizer), `ws/` (`$connect` authorizer accepting either a Cognito
  JWT or a guest token, connection→userId, read-authz), `stream/` (Streams consumer that assigns `seq`,
  writes the journal, fans out), and `jobs/` (async claim/merge). Registered HTTP requests use API
  Gateway's native **Cognito JWT authorizer** — no code. Client reconnection uses the replay/`since=seq`
  protocol.
- **`apps/web`** *(noted, though this doc is backend)* — durable IndexedDB write queue with `opId`, and
  the snapshot→subscribe→dedupe→gap-refetch client loop.

### 3.3 Suggested delivery sequence

Ordered so each phase is independently shippable and the highest-leverage spine lands first.

1. **Identity spine.** `User` + durable, user-bound session + idempotent join + `hostUserId`. Guests
   only. This fixes *same-device rejoin and multi-tab* (not yet cross-device guest continuity, §3.4) and
   is the prerequisite for everything else.
2. **Real-time journal + offline queue.** Stream-assigned monotonic `seq` + journal + `since=seq` +
   gap→refetch, and the client durable write queue with `opId`. Delivered together because the offline
   story and the ordering model are two halves of one design (§2.6–2.7).
3. **Scoring engine + handicap.** Move scoring into the pure engine; discriminated results; countback
   tiebreak; net/Stableford; `strokeIndex` rename; playing-handicap allowance; `handicapIndex` on
   `User`. 18-hole handicapping first.
4. **Authorization engine.** Replace inline checks with `authorize` (incl. read-authz and the
   score-target fix); introduce `ScoringPolicy`.
5. **Registered auth + claim.** `IdentityProvider` port + implementation; transfer token; async
   claim/merge with the alias map and same-round conflict rule; `GET /me/rounds` history.
6. **Events.** Thin `Event` grouping + per-format aggregation; match play / skins result types and
   their event aggregation strategies.

### 3.4 Decisions

- **Registered-auth provider — decided: Amazon Cognito.** Chosen for being native to the
  AWS/serverless stack (an API Gateway HTTP API can validate a Cognito User Pool JWT with its built-in
  JWT authorizer — no custom auth Lambda for the registered path), lowest marginal cost, and no
  third-party data processor to vet. The tradeoff accepted is more assembly than a Clerk/Auth0 —
  hosted-UI theming and passwordless email OTP via Cognito Lambda triggers rather than out-of-the-box.
  The `IdentityProvider` port still isolates it so unit tests run against a fake and the choice remains
  reversible if requirements outgrow it.
- **Anonymous cross-device (open).** Full guest portability requires the single-use transfer token (§2.2)
  and a "move my session here" UX. *Recommendation:* ship link-carried **access codes** (join as
  yourself) for the shared-round case; treat guest portability as an explicit transfer action and a
  claim-to-register nudge, not an always-on feature.

---

## Appendix: the design in one breath

Introduce a persistent `User`; make guests Users too. Bind sessions to Users and store them durably, so
identity survives tabs and same-device reopen and scores don't orphan while the credential lives; share
*access codes*, never identity credentials. Persist only raw strokes and derive every format through one
pure engine — with correct match-relative handicapping, per-format result types, and countback
tiebreaks — shared by client and server for consistency, while authority stays in the write path.
Assign a monotonic `seq` off the commit stream (no hot counter), order delivery through a journal, and
make any gap a refetch; put a durable client queue in front so on-course play works offline. Answer "can
you do this?" with one pure policy function that also gates reads. Group rounds into thin `Event`s with
format-specific aggregation. Everything else — history, handicaps, tournaments, robust and offline-capable
play — falls out of those moves rather than being bolted on.

---

## Appendix B: Codebase structure

The clean-architecture layering does not change — the dependency direction (`domain → application →
adapters → lambda`) stays exactly as today. Most new weight lands in `domain` (all pure), a couple of new
adapters appear, the four POC lambda packages **collapse into one `lambda` package** with per-trigger
entry points and a shared composition root, and one data-flow moves (broadcast leaves the write path).
Net package count drops from 13 → ~10 even as the system does much more. Two conventions from
[`engineering-conventions.md`](./engineering-conventions.md) shape the names below: **adapters are not
ports** (`createApiGatewayBroadcast`, never `…Port`) and **stores are not repositories**
(`RoundStore`, not `RoundRepository`). Directories flatten (no `src/<pkgname>/` nesting), tests
co-locate as `*.test.ts`, and packages group **by concept**, not by technical kind.

```
packages/
  domain/                         pure, no deps — most new weight; grouped BY CONCEPT
    src/
      identity/                   user.ts  principal.ts  session.ts
      round/                      round.ts  participant.ts  score.ts  events.ts  lifecycle.ts
      course/                     course.ts  teeSet.ts  validation.ts
      scoring/                    format.ts  stroke.ts  stableford.ts  match.ts  skins.ts  countback.ts
      handicap/                   courseHandicap.ts  allocation.ts     # absolute + match-relative
      policy/                     authorize.ts  roles.ts
      event/                      event.ts  aggregation.ts
      shared/                     ids.ts  time.ts  errors.ts           # DomainError
      index.ts                    # the ONE public surface (barrel)
  application/                    orchestration; depends on domain only
    src/
      ports/                      stores.ts  identityProvider.ts  broadcast.ts  journal.ts  clock.ts  ids.ts  logger.ts
      services/                   round.ts  participant.ts  scoring.ts  user.ts  auth.ts  event.ts  course.ts
      resolveActor.ts             # hydrate Actor roles ONCE per request
      errors.ts                   # ApplicationError + codes
      index.ts
  contracts/                      zod at the boundary
    src/  parse.ts (generic)  rounds.ts  scores.ts  auth.ts  users.ts  events.ts  courses.ts  index.ts
  adapters-dynamodb/              implements the store ports
    src/
      client.ts  keys.ts          # keys.ts keeps the documented single-table key map
      items/                      userItem.ts  scoreItem.ts  journalItem.ts  aliasItem.ts  …
      stores/                     dynamoRoundStore.ts  dynamoUserStore.ts  …   (NOT "…Repository")
      index.ts
  adapters-apigw-broadcast/       createApiGatewayBroadcast          (NOT …Port)
  adapters-cognito/    NEW        createCognitoIdentityProvider      (validate JWT, sub → User)
  adapters-powertools-logger/     createPowertoolsLogger
  lambda/                         ALL entry points — ONE package, ONE composition root
    src/
      composition/                container.ts  env.ts   # env → clients → stores → services, ONCE
      http/                       router.ts  routes.ts  httpError.ts  handler.ts
      ws/                         connect.ts  disconnect.ts  authorizer.ts   (dual-token)
      stream/          NEW        sequencer.ts           # DDB stream → seq → journal → broadcast
      jobs/            NEW        claim.ts               # async guest→registered merge
  client/                         core SDK: http.ts  ws.ts  reconnect.ts (keys on seq)  types.ts
  browser-client/                 browser transport + offlineQueue.ts (IndexedDB, opId)
apps/
  web/                            React SPA — new views + offline-queue integration
  infra-cdk/lib/constructs/       data-store.ts  auth.ts (Cognito)  http-api.ts  websocket.ts  stream.ts  web-app.ts
```

(The SDK's node binding — today's separate `node-client` — folds into `client` or `tools/` by the same
"earn the boundary" rule; it isn't a package.)

**The non-obvious calls (and why):**

1. **`domain` stays one package, not five.** The scoring engine, handicap, policy, and identity are
   large, but they all share domain types and ship to the same two consumers (client + server).
   Splitting them into `@swng/scoring` etc. would create *shallow* packages — build-graph wiring and
   version coordination with no isolation payoff. Folders (grouped by concept) give the organization; a
   package boundary should mean a real dependency boundary, and these don't have one.
2. **All Lambda entry points live in one package with one composition root.** The four POC lambda
   packages (`lambda-http-handler` + the three `lambda-ws-*`, three of them ~100-line handlers) plus the
   new stream and claim handlers collapse into a single `lambda` package. Each handler still deploys as
   its own function — esbuild tree-shakes per entry point — but they stop being separate npm packages
   and finally **share the wiring**: `composition/container.ts` builds stores and services from env
   *once*, instead of every handler re-instantiating them as they do today. A handler can split back out
   only if it ever needs a genuinely different dependency set.
3. **Broadcast moves off the write path — the one genuine flow change.** Today a service calls
   `broadcast.notify()` inline after every mutation. Now the write is just an idempotent upsert; the
   stream sequencer (`lambda/stream/sequencer.ts`) assigns `seq`, writes the journal, and fans out. This
   is what makes contention-free writes and offline sync possible — and it *simplifies* the HTTP
   handler, which no longer needs the connection store or `execute-api:ManageConnections` IAM. The
   `adapters-apigw-broadcast` package keeps its shape; only its caller moves.
4. **Registered auth needs no lambda; guest auth needs one.** The Cognito JWT authorizer is native to
   API Gateway HTTP API, so the largest auth surface adds zero code — just config. Only the guest
   opaque-token path needs a Lambda authorizer (`lambda/http/` — an entry point, not a package). That
   asymmetry is a direct dividend of the Cognito decision.
5. **Names tell the truth (see the conventions doc).** Adapters are named for their technology and
   capability, never `…Port` (`createApiGatewayBroadcast`); the interfaces they implement are the ports,
   named for the capability (`Broadcast`, `RoundStore`). Persistence interfaces are **stores**, not
   repositories, because they are thin key-value stores, not DDD aggregates. Package count *drops*
   (13 → ~10) even as the system grows — deep over shallow.
