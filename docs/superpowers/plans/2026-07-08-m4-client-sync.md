# M4 — Client SDK: Live Sync + Offline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `createRoundSession` — optimistic local scoring over the same `@swng/domain` fold, a durable outbox that survives offline, and convergence with the server proven by property simulation and a kill-network test against beta.

**Architecture:** `docs/architecture.md` §3 "Offline sync is owned by the client SDK." The session folds `confirmed ∪ outbox` through `reduceRound` (the commutative fold makes merge free); push is deduped by `opId`, pull is cursored by `seq`, and the WebSocket stays delivery sugar — HTTP catch-up is the correctness path.

**Tech stack:** pure browser-safe TypeScript in `@swng/client` (lint: imports `@swng/domain` + `@swng/contracts` only, no node:*); `fake-indexeddb` for the IndexedDB store's tests; fast-check for the convergence simulation; the `e2e/` package (which may import anything) for the beta kill-network gate.

## Global Constraints

- Work directly on `main`; `pnpm validate` green at every commit (hermetic — the convergence sim runs inside it; only Task 5's kill-network test and Task 6's redeploy need AWS).
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- TDD; comment the why only; layer law lint-enforced (`client` → domain+contracts only — the simulation server in client tests is built from DOMAIN primitives, never from `@swng/application`).
- Golden fixtures reuse `fixtureLinks` and the M2 cards (stableford Ann 15 / Bo 19; the concurrency deck for e2e).
- **Design decisions fixed by this plan** (do not relitigate):
  - **Full HLC, both rules.** The client HLC source implements the send rule (same-or-regressed `wallMs` → `counter + 1`, else counter 0 — the M3 lesson) AND the receive rule (observing a remote event floors the source at that hlc: a later stamp must compare greater than every hlc it has seen). Without the receive rule, a phone with a behind-skewed clock authors corrections that LOSE to the very writes they correct. Send/receive rules per Kulkarni et al.'s HLC algorithm, adapted to our `{ wallMs, counter, deviceId }` shape.
  - **Fold tolerates duplicate copies.** An optimistic outbox event and its server-confirmed copy share an `opId`; `reduceRound`'s canonical-order dedupe (M1) makes `reduceRound([...confirmed, ...outbox])` correct even when both are present. Outbox pruning (drop entries whose `opId` appears in the confirmed log) is an optimization, not a correctness requirement — and there is a test proving state is identical before and after pruning.
  - **Push semantics:** outbox pushes strictly oldest-first, one event per `POST /rounds/{id}/scores` call, sequentially. `{ duplicate: true }` counts as confirmed (a retry whose first attempt landed). Transient failures (network error, 5xx) stop the push and keep everything queued. Permanent rejections (4xx other than duplicate) DROP the entry from the outbox into `session.rejected()` (event + error code) for the UI — a finalized round must not wedge the queue forever.
  - **Cursor:** the session tracks `lastSeq`, initialized 0; every pull calls `GET events?since=lastSeq` and sets `lastSeq = response.nextSeq` (the server echoes `sinceSeq` on an empty page — pinned by M3's tests; the cursor never regresses).
  - **WS is sugar:** socket events are ingested exactly like pull batches (same code path). Socket open triggers a `sync()`; socket close/error just flips connectivity — no state is ever derived from socket delivery alone. There is no periodic timer in the SDK (the M5 UI decides when to call `sync()`); `recordScore` attempts an immediate opportunistic push when connected.
  - **`games()` filters to known kinds** before calling `scoreGame` (which throws on unknown kinds — carried note from M2): a client on an old build must survive a round containing a future game kind.
  - **`authorId` on optimistic events = the session's own `golferId`** (the server stamps the same value from the token, so the confirmed copy is byte-identical and the audit trail folds identically on both sides).
  - **Storage:** `OutboxStore` port with `createMemoryOutboxStore` and `createIndexedDbOutboxStore` (browser global `indexedDB`, injectable for tests via `fake-indexeddb`). The store persists outbox entries AND `lastSeq` per round. Confirmed events are NOT persisted in v1 — a fresh session re-pulls from seq 0 (rounds are small; `derive, don't store`).
  - **Build stays plain tsc.** The architecture's "(browser build via tsup)" parenthetical is superseded: the M5 web app bundles from the package's ESM output directly; tsup returns only if a standalone bundle is ever needed. Reconciled in Task 5.
  - **Sim server from domain primitives only** (~40 lines in client test code): append = opId-dedupe + contiguous seq-stamp + notify; read = filter seq > since. This is the same journal contract the Dynamo adapter contract-tests — cite that in a comment rather than importing `@swng/application`.

---

### Task 1: The HLC source and the transport

**Files:**
- Create: `packages/client/src/hlc.ts`, `packages/client/src/transport.ts`
- Replace: `packages/client/src/index.ts` barrel; delete the placeholder test
- Test: `packages/client/src/hlc.test.ts`, `packages/client/src/transport.test.ts`

**Interfaces (produced — later tasks consume these exact names):**

```ts
// hlc.ts
export interface HlcSource {
  next(): Hlc;                    // send rule: strictly greater than everything stamped OR observed so far
  observe(remote: Hlc): void;     // receive rule: floor the source at the remote hlc
}
export const createHlcSource: (deviceId: DeviceId, clock?: { now(): number }) => HlcSource;
// next(): wallMs = max(clock.now(), last.wallMs); counter = wallMs === last.wallMs ? last.counter + 1 : 0.
// observe(): last = max(last, remote) by compareHlc — so a later next() beats every observed event
// even when the local wall clock is behind the remote author's. Why: a correction authored on a
// skewed-behind phone must still WIN the LWW register against the score it corrects.

// transport.ts — the seam the session, the simulation, and the kill-network test all share.
export interface PushResult { readonly seq?: number; readonly duplicate: boolean; }
export class TransportError extends Error {
  constructor(readonly kind: "network" | "server", readonly status?: number, readonly code?: string) { ... }
}
export interface RoundTransport {
  push(event: RoundEvent): Promise<PushResult>;                     // one score-recorded, no seq
  pull(sinceSeq: number): Promise<{ events: readonly RoundEvent[]; nextSeq: number }>;
  openSocket(onEvents: (events: readonly RoundEvent[]) => void, onClose: () => void): () => void; // returns close()
}
export interface HttpTransportConfig {
  httpUrl: string; wsUrl: string; roundId: RoundId; token: string;
  fetchImpl?: typeof fetch;                        // injectable for tests and the kill-network toggle
  webSocketCtor?: new (url: string) => WebSocket;  // injectable likewise
}
export const createHttpTransport: (config: HttpTransportConfig) => RoundTransport;
// push → POST /rounds/{id}/scores with { golferId, hole, result, opId, hlc } from the event, Bearer token;
//   response parsed via recordScoreResponseSchema; 4xx/5xx → TransportError("server", status, body.code);
//   fetch rejection → TransportError("network").
// pull → GET /rounds/{id}/events?since=N, parsed via eventsResponseSchema.
// openSocket → new WebSocket(`${wsUrl}?token=${token}`); each message parsed via wsEnvelopeSchema,
//   events forwarded only when envelope.roundId matches; malformed messages are logged-and-dropped
//   (sugar must not throw); close/error → onClose exactly once.
```

- [ ] **Step 1 (RED):** `hlc.test.ts` — with a frozen clock, three `next()` calls yield counters 0,1,2 and are strictly increasing under `compareHlc`; with an advancing clock, counter resets on a new ms; after `observe({ wallMs: now + 60_000, counter: 5, deviceId: other })`, `next()` compares greater than the observed hlc (the skewed-behind correction case — assert with `compareHlc`, not field peeking); a regressing wall clock (clock goes backward) still yields strictly increasing stamps.
- [ ] **Step 2 (GREEN):** implement `hlc.ts`.
- [ ] **Step 3 (RED):** `transport.test.ts` with a fake `fetchImpl` and fake `webSocketCtor`: push formats the wire body from the event and parses the response; duplicate response surfaces `{ duplicate: true }`; a 409 surfaces `TransportError("server", 409, "round-not-live")`; fetch rejection surfaces `TransportError("network")`; pull hits `?since=` and parses; socket messages round-trip the envelope, mismatched roundId is dropped, malformed JSON is dropped without throwing, close fires `onClose` once.
- [ ] **Step 4 (GREEN):** implement `transport.ts`; barrel; `pnpm validate`; `pnpm -F @swng/client test` ×2; commit `feat(client): full HLC source (send+receive rules) and the round transport`.

---

### Task 2: Outbox stores and the session core

**Files:**
- Create: `packages/client/src/outbox.ts`, `packages/client/src/indexedDbOutbox.ts`, `packages/client/src/session.ts`
- Modify: barrel; `packages/client/package.json` + `pnpm-workspace.yaml` catalog (devDeps: `fast-check: catalog:` — already in catalog — and `fake-indexeddb` — add `^6.0.0` to catalog)
- Test: `packages/client/src/outbox.test.ts`, `packages/client/src/indexedDbOutbox.test.ts`, `packages/client/src/session.test.ts`

**Interfaces (produced):**

```ts
// outbox.ts
export interface PersistedSync {
  readonly pending: readonly RoundEvent[];
  readonly lastSeq: number;
  readonly opCounter: number;   // highest opId counter minted on this device — persisted so a
                                // restarted session can NEVER re-mint an opId it already used
                                // (a reused opId would make the server silently drop the new
                                // event as a duplicate of the old one)
}
export interface OutboxStore {
  load(roundId: RoundId): Promise<PersistedSync | undefined>;
  save(roundId: RoundId, sync: PersistedSync): Promise<void>;
}
export const createMemoryOutboxStore: () => OutboxStore;
// indexedDbOutbox.ts
export const createIndexedDbOutboxStore: (config?: { databaseName?: string; indexedDb?: IDBFactory }) => OutboxStore;

// session.ts
export interface RejectedOp { readonly event: RoundEvent; readonly code: string; }
export interface RoundSession {
  readonly roundId: RoundId;
  state(): RoundState;                       // reduceRound(confirmed ∪ outbox), cached until change
  games(): readonly GameState[];             // scoreGame over state().games FILTERED to known kinds
  recordScore(golferId: GolferId, hole: number, result: HoleResult): void; // optimistic; opportunistic push when connected
  sync(): Promise<void>;                     // push outbox oldest-first, then pull since lastSeq
  connect(): void;                           // open socket (idempotent); socket open triggers sync()
  disconnect(): void;
  connected(): boolean;
  pending(): number;                         // outbox depth (UI badge)
  rejected(): readonly RejectedOp[];         // permanently rejected ops (UI surfacing)
  onChange(listener: () => void): () => void;
  close(): Promise<void>;                    // disconnect + final save
}
export interface SessionConfig {
  transport: RoundTransport; store?: OutboxStore;   // default memory
  roundId: RoundId; golferId: GolferId; deviceId: DeviceId;
  clock?: { now(): number };
}
export const createRoundSession: (config: SessionConfig) => Promise<RoundSession>;
// Construction: load persisted { pending, lastSeq, opCounter } (fresh → [] / 0 / 0); an initial sync()
// is the CALLER's choice, not automatic (the kill-network test constructs offline). recordScore builds
// the event with opId `${deviceId}-${++opCounter}` (unique per device across restarts — the counter is
// persisted with every save), hlc from the session's HlcSource, authorId = config.golferId; appends to
// outbox; saves; notifies; opportunistically pushes. Task 2's tests include the restart case: a second
// session over the same store must mint opIds that don't collide with the first session's.
// Ingest (pull or socket): observe every remote hlc into the HlcSource; append unseen events (by opId)
// to confirmed; advance lastSeq (pull only — socket events carry seq but the cursor only advances
// through pull's nextSeq, keeping one cursor authority); prune outbox; save; notify once per batch.
```

- [ ] **Step 1 (RED → GREEN):** `outbox.test.ts` — memory store round-trip, unknown round → undefined. `indexedDbOutbox.test.ts` — same contract against `fake-indexeddb`'s `IDBFactory`, plus persistence across two store instances sharing one factory (the "app restarted" case).
- [ ] **Step 2 (RED):** `session.test.ts` with a scripted fake transport: optimistic `recordScore` reflects in `state()` immediately (cell present, `recordedBy`/`authorId` = session golfer); the M2 stableford golden card driven through `recordScore` for Ann+Bo yields `games()` points 15/19 once game-added events are ingested from the fake transport (construct the round's creation/join/game events as the "server log" the fake serves); a round containing an unknown game kind (`{ kind: "wolf-9000" }` forced past the type system) does NOT throw from `games()` and the known games still score; duplicate copies — after the fake confirms an event, `state()` before and after outbox pruning are deep-equal; `pending()` counts; `rejected()` populated when the fake returns a 409 permanently, and the entry leaves the outbox.
- [ ] **Step 3 (GREEN):** implement session core (no socket wiring yet beyond stubs; `sync()` in Task 3).
- [ ] **Step 4:** `pnpm validate`; suite ×2; commit `feat(client): outbox stores and the optimistic round session core`.

---

### Task 3: The sync loop — push, pull, socket, reconnect

**Files:**
- Modify: `packages/client/src/session.ts` (sync/connect/ingest complete), barrel if needed
- Test: extend `packages/client/src/session.test.ts` (a `sync + reconnect` describe block)

Semantics (fixed, from Global Constraints): push oldest-first sequential; duplicate = confirmed; `TransportError("network")`/5xx = stop push, keep queued, `sync()` resolves (offline is not an error — the queue IS the feature); other 4xx = drop to `rejected()`, continue push. Then pull `since=lastSeq`, ingest (observe hlcs, dedupe by opId, prune, single notify), `lastSeq = nextSeq`. Socket: `connect()` opens via transport, `onEvents` batches go through the same ingest, socket-open triggers `sync()`, `onClose` flips `connected()` and notifies — no auto-reconnect timer in v1 (the UI owns retry cadence; why-comment this).

- [ ] **Step 1 (RED):** scripted-transport tests: (a) offline burst — three `recordScore` while transport throws network errors → `pending() === 3`, `sync()` resolves without throwing, nothing lost; transport comes back → `sync()` pushes all three IN AUTHOR ORDER (assert the fake's received sequence), pulls confirmed copies, outbox drains to 0, state unchanged by the round-trip (deep-equal before/after); (b) interleaved remote events — the pull returns another device's scores; both devices' cells present after ingest; the session's HlcSource observed the remote hlcs (a subsequent local correction to the SAME cell wins the fold — assert winner); (c) duplicate wire delivery — the same confirmed event arrives via socket AND pull; state identical, no double-notify storm (listener called once per ingest batch); (d) socket lifecycle — connect opens, socket events ingest, close flips `connected()`, reconnect + sync converges; (e) a permanent 409 mid-queue drops that entry to `rejected()` and still pushes the rest.
- [ ] **Step 2 (GREEN):** implement; `pnpm validate`; suite ×2 (per-package flake check); commit `feat(client): sync loop — durable offline queue, cursored catch-up, socket ingest`.

---

### Task 4: The convergence simulation (the M4 correctness heart)

**Files:**
- Create: `packages/client/src/testing/simServer.ts` (test-only module; not exported from the barrel), `packages/client/src/convergence.properties.test.ts`

**Sim server contract (domain primitives ONLY — client lint forbids `@swng/application`; this mirrors the journal contract that `adapters-dynamodb`'s contract tests pin against real DynamoDB — say so in a comment):**

```ts
export interface SimServer {
  transportFor(deviceId: DeviceId): RoundTransport & { setOnline(online: boolean): void };
  log(): readonly RoundEvent[];       // seq-stamped, append order
  seed(events: readonly RoundEvent[]): void;  // creation/join/game-added scaffolding
}
export const createSimServer: () => SimServer;
// append: reject nothing except duplicate opId (return duplicate:true); assign contiguous seq;
// notify every online socket. setOnline(false): push/pull throw TransportError("network"),
// socket fires onClose. setOnline(true): sockets reconnect lazily via session.connect().
```

- [ ] **Step 1:** deterministic example tests first (RED→GREEN as you build the harness): two devices, one offline window, one correction — both converge to `reduceRound(server.log())`. Include the two M3-lesson devices: a FROZEN-clock device (its hlc counters must climb; its events still order correctly) and a SKEWED-BEHIND device (clock 5 minutes behind) that corrects a cell another device wrote — **the correction must win** (this fails if Task 1's receive rule is broken — it is the test that would have caught M3's bug class on the client).
- [ ] **Step 2:** the fast-check property. Generator: 2–4 devices (varied clock skews including frozen), a seeded round (fixtureLinks, 2 golfers, one stableford game), then a schedule of 10–40 ops drawn from: `record(device, golfer, hole, gross)`, `correct(device, golfer, hole)` (rewrites an already-scored cell), `goOffline(device)`, `comeOnline(device)` (connect + sync), `sync(device)`, `redeliver(device)` (re-inject an already-delivered socket batch — duplicate delivery), `pullOutOfOrder(device)` (a pull that races a socket batch). Quiescence: bring every device online, `sync()` all twice. **Properties:** (1) every device's `state()` deep-equals `reduceRound(server.log())`; (2) every device's `games()` deep-equal each other; (3) every `recordScore` opId appears in the server log exactly once (nothing lost, nothing doubled); (4) every outbox is empty and `rejected()` empty; (5) `JSON.stringify` of the folded states is identical across devices (byte parity). `fc.assert` with `numRuns` ≥ 50 (keep runtime < 30s; tune op count if needed).
- [ ] **Step 3:** `pnpm validate`; run the property suite THREE times (probabilistic bench — the M3 lesson: state the odds; three clean runs of ≥50 schedules each is the evidence bar); commit `test(client): N-device convergence simulation — every interleaving folds to the server log`.

---

### Task 5: The kill-network gate against beta + doc reconciliation

**Files:**
- Create: `e2e/syncSession.e2e.test.ts`
- Modify: `e2e/package.json` (add `"@swng/client": "workspace:*"`), `docs/implementation-plan.md` (M4 section only), `docs/architecture.md` (one parenthetical)

**The scenario (real stack, real transport — `fetchImpl` wrapped with an offline toggle, `ws` package as `webSocketCtor`):**

1. Create a round + join via the existing e2e HTTP harness (Ann host ch 8, Bo ch 2, white tees, one stableford game referencing both).
2. Build TWO `createRoundSession`s over `createHttpTransport` (session A = Ann's token, session B = Bo's token), both `connect()` + initial `sync()`.
3. A records Ann's front three (5,6,3); assert B's session converges over the socket (poll-with-deadline on `state()`).
4. **Kill B's network** (toggle its fetch wrapper to throw + close its socket): B records Bo's full card (4,4,3,5,5,3,4,5,4) offline → `pending() === 9`, B's local `games()` already shows Bo 19.
5. While B is dark, A keeps scoring Ann's remaining card including the h4 pickup (A records only Ann's cells — score-for-anyone stays exercised by the M3 e2e; this test isolates offline convergence).
6. **Restore B's network**, `connect()` + `sync()`: B's queue drains (pending 0, rejected 0); poll until BOTH sessions' `games()` equal `[stableford Ann 15 / Bo 19]` — the M2 golden numbers — and both `state()`s are deep-equal.
7. Finalize via the HTTP harness; assert the finalize response's stableford result matches both sessions' last `games()` output.
8. The suite is re-runnable (fresh round per run).

- [ ] **Step 1:** implement; run `pnpm e2e:beta` (runs both e2e files — this one and M3's) until green, then **twice more consecutively green** (three total; deterministic scenario, but the bench is live).
- [ ] **Step 2 (doc reconciliation, scope-limited):** `docs/implementation-plan.md` M4 section: note the session API name (`createRoundSession(config)` returning the session object), the full-HLC decision (receive rule — skewed-clock corrections), and that the convergence sim + kill-network test are the gate as executed. `docs/architecture.md`: "(browser build via tsup)" → "(ESM build consumed by the web app's bundler)". Nothing else in either file.
- [ ] **Step 3:** `pnpm validate`; commit `feat(e2e): kill-network sync gate against beta; M4 gate met`.

---

### Task 6: M3-deferred backend touch-ups (honoring the ledger) + redeploy

The M3 final review deferred these "to M4's first touch" — this task IS that touch, kept last so the client work never builds on a moving backend.

**Files:**
- Modify: `packages/adapters-dynamodb/src/createDynamoEventJournal.ts` + `createDynamoConnectionRegistry.ts` (extract the duplicated ExclusiveStartKey pagination loop into one shared helper — e.g. `queryAllPages` in a small `paginate.ts`; fix the transact-cap comment wording: the ValidationException surfaces from the first `attemptCommit` call, not "before the loop"), `packages/lambda/src/http/dispatch.ts` (route the hand-built 404 body through `errorMapping`'s response helper — one error-shaping site), `packages/lambda/src/http/routes.ts` (GET events: non-integer `?since=` → 400 `invalid-request` via `ContractError`; why-comment the `evtSk(NaN)` range quirk this prevents), `packages/lambda/src/compositionRoot.ts` (consoleLogger: spread `data` FIRST so a `data.message` key can't clobber the log message).
- Test: extend the covering suites — a pagination test still passes post-extraction (hermetic `keys.test.ts` untouched; the behavior pin is the contract suite), dispatcher tests gain `since=abc → 400` and a 404-shape assertion through the one helper; a logger unit test pins message-wins.

- [ ] **Step 1:** TDD the two new lambda behaviors (RED→GREEN); mechanical extraction + comment fixes; `pnpm validate` green.
- [ ] **Step 2:** `pnpm test:contract` (the pagination extraction touches the journal's read path — the contract suite is its behavior pin) — green.
- [ ] **Step 3:** commit `fix(lambda,adapters-dynamodb): M3-deferred touch-ups — one error-shaping site, since validation, shared pagination, logger order`.
- [ ] **Step 4:** redeploy (`pnpm deploy:beta`, stack `swng-beta` only — never `InfraCdkStack-*`), verify UPDATE_COMPLETE, then `pnpm e2e:beta` green TWICE (both suites — the M3 gate must still hold on the touched backend).

**M4 gate (from `docs/implementation-plan.md`):** parity suite green (Task 4's convergence properties — client result === server result across every interleaving); kill-network integration test (queue, reconnect, converge) green against beta (Task 5). Plus: the controller personally runs `pnpm e2e:beta` and the convergence suite before declaring the milestone done (standing lesson).
