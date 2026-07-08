# M3 — Backend Vertical Slice (deployed to beta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full server path live on a fresh beta stack: create → join by code → score → broadcast → finalize — proven by a scripted E2E that reproduces the M2 concurrency deck's exact numbers over the wire.

**Architecture:** `docs/architecture.md` §3. Commands validate against reduced state and append events; the journal assigns `seq`; WebSocket is delivery sugar and HTTP catch-up is the correctness path. One lambda package with per-trigger entries, a declarative dispatcher, and one composition root.

**Tech stack:** Zod 4 (`@swng/contracts`), AWS SDK v3 (adapters only), API Gateway HTTP + WebSocket, DynamoDB (TransactWriteItems), CDK 2 (`aws-cdk-lib` 2.229.1, `NodejsFunction`/esbuild), Vitest. DynamoDB Local (Java 21, no docker) for adapter contract tests.

## Global Constraints

- Work directly on `main`; `pnpm validate` (lint + typecheck + build + test) green at every commit; **`pnpm validate` stays hermetic — no network, no AWS, no DynamoDB Local inside it.** Adapter contract tests and E2E run behind explicit scripts (`test:contract`, `e2e:beta`) and are gate steps, not validate steps.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- TDD; layer law is lint-enforced (contracts may import domain; application never imports adapters; AWS SDKs only in `adapters-*`; lambda never imports client).
- **Never create or deploy stacks named `InfraCdkStack-*`.** The live POC stacks keep those names; this milestone's stack is `swng-beta`. Deleting the POC stacks is NOT in this plan — it is a separate, user-confirmed act.
- AWS profile `swng`, region `us-east-1`. Deploy/E2E steps that need credentials: if the environment can't reach AWS, report BLOCKED for the controller to run the command — never fake a gate.
- **Design decisions fixed by this plan** (do not relitigate):
  - **Five use cases, not four.** `AddGame` joins `StartRound`/`JoinRound`/`RecordScore`/`FinalizeRound`: game configs reference golfer ids that exist only after joins, so games are added post-join (as on a real first tee). The master plan is reconciled in Task 6.
  - **Rounds are live from creation**: `StartRound` appends `round-created` + `participant-joined`(host) + `round-started` in one append. `JoinRound` and `AddGame` are allowed while status ≠ `final`; `RecordScore` requires `live`. No go-live command in v1; the domain's `setup` status remains for a future staged-setup flow (additive).
  - **Server-authored vs client-authored events.** `round-created`/`participant-joined`/`game-added`/`round-started`/`round-finalized` are constructed server-side: `opId` from `IdGenerator`, `hlc = { wallMs: clock.now(), counter: 0, deviceId: deviceId("server") }`, `authorId` = the commanding golfer (host for creation events, joiner for their join, finalizer for finalize). `score-recorded` is client-authored: the client supplies `opId`, `hlc`, `golferId` (subject), `hole`, `result`; the server stamps `authorId` from the verified token — a client can never claim another author.
  - **Idempotency at ingest**: the journal appends each event and its `OPID#` marker in one transaction; a duplicate `opId` is a no-op success (`duplicate: true` on the wire), never an error, and is not broadcast. This makes archive-level opId dedupe moot by construction (ledger note resolved: server logs have unique opIds).
  - Wire ids are plain strings; contracts schemas brand them at parse (`z.string().transform(golferId)` etc.). Requests are parsed once by the dispatcher; responses are typed, not parsed, server-side (the same schemas serve the E2E/M4 client for inbound parsing).
  - Join codes: 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L). Tokens: HMAC-SHA256 over a JSON payload `{ roundId, golferId, exp }`, base64url `payload.signature`, verified with `crypto.timingSafeEqual`, 24h expiry from `Clock`. Secret from env `TOKEN_SECRET` (beta-grade; hardening is M9).
  - Participant tokens authorize `RecordScore`/`AddGame`/`FinalizeRound` (`Authorization: Bearer <token>`) and WS `$connect` (`?token=`). `ScoringPolicy` v1 is `anyone-in-group`: author must be a participant; subject must be a participant.
  - Error mapping lives in ONE lambda module: zod parse failure → 400, `invalid-token` → 401, `not-a-participant`/`token-round-mismatch` → 403, `round-not-found`/`bad-join-code` → 404, `round-not-live`/`round-final`/domain `game-unresolved` → 409, domain `unknown-tee-set` → 400, `unknown-golfer-in-game` → 400 (amended during execution — same "referenced id not in this round" shape as unknown-tee-set), anything else → 500 (logged).
  - DynamoDB key shapes (rounds table): pk `ROUND#<roundId>`; sk `EVT#<seq padded to 10 digits>`, `META`, `ARCHIVE`, `OPID#<opId>`. `gsi1` on attribute `joinCode` (META items only). Connections table: pk `CONN#<connectionId>` with attribute `roundId`; `gsi1` on `roundId`. `core`/`projections` tables are created now (pk/sk, empty) so later milestones never touch the stack shape.

---

### Task 1: Domain housekeeping + `@swng/contracts` wire schemas

**Files:**
- Modify: `packages/domain/src/scoring/singlesMatch.ts` (adopt `playerTeeSet` + `playingHandicap` — behavior frozen by its untouched tests), `packages/domain/src/scoring/golden/deck.ts` (rename `let seq` → `let opCounter` — it counts opIds, not envelope seq), `packages/domain/src/round/state.ts` (one comment line: `withoutSeq`/`byCanonicalOrder` are published via the barrel deliberately — sync/journal tooling and M4 tests are the intended consumers)
- Modify: `pnpm-workspace.yaml` (catalog: `zod: ^4.1.0`), `packages/contracts/package.json` (add `"zod": "catalog:"` to dependencies)
- Create: `packages/contracts/src/ids.ts`, `packages/contracts/src/round.ts`, `packages/contracts/src/commands.ts`, `packages/contracts/src/ws.ts`, `packages/contracts/src/parse.ts`
- Replace: `packages/contracts/src/index.ts` (barrel), delete the placeholder test
- Test: `packages/contracts/src/round.test.ts`, `packages/contracts/src/commands.test.ts`

**Interfaces (produced — every later task consumes these exact names):**

```ts
// parse.ts — the one generic parse (conventions §3). Throws ContractError("invalid-request", issues) on failure.
export class ContractError extends Error { constructor(readonly code: "invalid-request", readonly issues: string[]) { super(code); } }
export const parse: <S extends z.ZodType>(schema: S, input: unknown) => z.infer<S>;

// ids.ts — branded-at-parse id schemas
export const golferIdSchema: z.ZodType<GolferId>;   // z.string().min(1).transform(golferId) — same pattern for roundId/gameId/opId/deviceId
export const hlcSchema: z.ZodType<Hlc>;             // { wallMs: int ≥ 0, counter: int ≥ 0, deviceId }

// round.ts — wire mirrors of domain types. COMPILE-TIME PARITY IS THE TEST:
//   const _e: RoundEvent = {} as z.infer<typeof roundEventSchema>;  (and the reverse direction)
export const holeResultSchema: z.ZodType<HoleResult>;
export const courseCardSchema: z.ZodType<CourseCard>;   // holes: number/par/yardage/strokeIndex ints; teeSets non-empty; deep validation is M6's
export const participantSchema: z.ZodType<Participant>;
export const gameConfigSchema: z.ZodType<GameConfig>;   // discriminated union on kind, all five members
export const roundEventSchema: z.ZodType<RoundEvent>;   // discriminated union on kind; envelope opId/hlc/authorId/seq?
export const gameResultSchema: z.ZodType<GameResult>;

// commands.ts — requests (parsed inbound) and response TYPES (typed outbound, parsed by clients)
export const gameConfigInputSchema; // gameConfigSchema members WITHOUT id (server assigns): z.discriminatedUnion over five id-less shapes
export type GameConfigInput = z.infer<typeof gameConfigInputSchema>;
export const startRoundRequestSchema;   // { card: CourseCard, host: { name, tee, courseHandicap: int (may be negative) } }
export const joinRoundRequestSchema;    // { code: string(6), name, tee, courseHandicap }
export const addGameRequestSchema;      // { game: GameConfigInput }
export const recordScoreRequestSchema;  // { golferId, hole: int ≥ 1, result: HoleResult, opId, hlc }
export interface StartRoundResponse { roundId: RoundId; joinCode: string; token: string; golferId: GolferId; }
export interface JoinRoundResponse  { roundId: RoundId; token: string; golferId: GolferId; }
export interface AddGameResponse    { gameId: GameId; seq: number; }
export interface RecordScoreResponse { seq?: number; duplicate: boolean; }  // seq of the appended event; absent when duplicate (the original's seq isn't re-derived)
export interface FinalizeRoundResponse { results: readonly GameResult[]; handicapping: RoundArchive["handicapping"]; }
export interface EventsResponse { events: readonly RoundEvent[]; nextSeq: number; }  // GET /rounds/{id}/events?since=N
export const startRoundResponseSchema, joinRoundResponseSchema, recordScoreResponseSchema,
             finalizeRoundResponseSchema, eventsResponseSchema, addGameResponseSchema; // for client-side parsing (E2E, M4)
export const errorResponseSchema; // { code: string, message: string }

// ws.ts — the server→client envelope. One message type in v1.
export const wsEnvelopeSchema; // { type: "events", roundId, events: RoundEvent[] } — events are seq-stamped
export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;
```

- [ ] **Step 1 (housekeeping, own commit):** migrate `singlesMatch.ts` — replace the two inline participant `find`/throw pairs with `playerTeeSet(state, config.a)` / `playerTeeSet(state, config.b)` (its `teeSet` return also replaces the later `findTeeSet(state.card, participantA.tee)` for `cardTeeSet` and `findTeeSet(state.card, higher.tee)`), and replace `roundHalfUp((higher.courseHandicap - lower.courseHandicap) * allowance)` with `playingHandicap(higher.courseHandicap - lower.courseHandicap, allowance)`. `singlesMatch.test.ts` must pass UNCHANGED. Rename deck's `let seq` → `let opCounter` (and its uses). Add the deliberate-export comment in `state.ts`. Run `pnpm -F @swng/domain test` ×2; `pnpm validate`; commit `refactor(domain): singles over shared helpers; rename deck opId counter; mark canonical exports deliberate`.
- [ ] **Step 2:** add zod to the catalog + contracts deps; `pnpm install`.
- [ ] **Step 3 (RED):** write `round.test.ts` — a valid `score-recorded` wire object parses and round-trips (`parse(roundEventSchema, JSON.parse(JSON.stringify(event)))` deep-equals the original); an unknown `kind` fails; a `game-added` carrying each of the five configs parses; `seq` optional and preserved when present; compile-time parity assignments both directions (`z.infer` ↔ domain types) for `roundEventSchema`, `gameConfigSchema`, `gameResultSchema`. `commands.test.ts` — each request schema accepts its happy case and rejects a representative bad case (courseHandicap 8.5 non-int, hole 0, empty name, 5-char code); `gameConfigInputSchema` rejects a config that carries an `id`( `.strict()` members).
- [ ] **Step 4 (GREEN):** implement the schemas exactly as specified; barrel exports; delete the placeholder test.
- [ ] **Step 5:** `pnpm validate`; commit `feat(contracts): zod wire schemas for round commands, events, results, and the WS envelope`.

---

### Task 2: `@swng/application` — ports, policy, five use cases

**Files:**
- Create: `packages/application/src/ports/eventJournal.ts`, `ports/roundStore.ts`, `ports/broadcast.ts`, `ports/tokenIssuer.ts`, `ports/clock.ts`, `ports/idGenerator.ts`, `ports/logger.ts`, `ports/connectionRegistry.ts`
- Create: `packages/application/src/errors.ts`, `packages/application/src/scoringPolicy.ts`, `packages/application/src/rounds/startRound.ts`, `rounds/joinRound.ts`, `rounds/addGame.ts`, `rounds/recordScore.ts`, `rounds/finalizeRound.ts`, `rounds/readEvents.ts`
- Create: `packages/application/src/testing/fakes.ts` (in-memory ports — exported for reuse by lambda/E2E unit tests)
- Replace: `packages/application/src/index.ts`; delete placeholder test
- Test: `packages/application/src/rounds/roundSlice.test.ts`

**Interfaces (produced):**

```ts
// ports — capabilities, no Port suffix (conventions §1)
export interface AppendResult { readonly appended: readonly RoundEvent[]; readonly duplicateOpIds: readonly OpId[]; }
export interface EventJournal {
  append(roundId: RoundId, events: readonly RoundEvent[]): Promise<AppendResult>; // input events carry NO seq; result's appended are seq-stamped, contiguous
  read(roundId: RoundId, sinceSeq: number): Promise<readonly RoundEvent[]>;       // seq > sinceSeq, ascending; [] for unknown round
}
export interface RoundStore {
  createRound(meta: { roundId: RoundId; joinCode: string }): Promise<void>;
  findByJoinCode(code: string): Promise<RoundId | undefined>;
  putArchive(archive: RoundArchive): Promise<void>;
}
export interface Broadcast { publish(roundId: RoundId, events: readonly RoundEvent[]): Promise<void>; }
export interface ParticipantClaims { readonly roundId: RoundId; readonly golferId: GolferId; }
export interface TokenIssuer { issue(claims: ParticipantClaims): string; verify(token: string): ParticipantClaims | undefined; }
export interface Clock { now(): number; }
export interface IdGenerator { newId(): string; newJoinCode(): string; }
export interface Logger { info(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void; }
export interface ConnectionRegistry { // WS delivery infrastructure (used by ws entries + broadcast adapter, not by use cases)
  register(connectionId: string, roundId: RoundId): Promise<void>;
  deregister(connectionId: string): Promise<void>;
  listByRound(roundId: RoundId): Promise<readonly string[]>;
}

export class ApplicationError extends Error { constructor(readonly code:
  "round-not-found" | "bad-join-code" | "invalid-token" | "token-round-mismatch" |
  "not-a-participant" | "round-not-live" | "round-final" | "unknown-golfer-in-game", message?: string) { super(message ?? code); } }

// scoringPolicy.ts — the seam, trivially satisfied in v1
export type ScoringPolicy = { readonly kind: "anyone-in-group" };
export const mayScore: (policy: ScoringPolicy, state: RoundState, author: GolferId, subject: GolferId) => boolean;

// use cases — factory over deps, command in, typed result out. Deps object per use case, only what it uses.
export const startRound:    (deps: { journal: EventJournal; store: RoundStore; broadcast: Broadcast; tokens: TokenIssuer; clock: Clock; ids: IdGenerator }) =>
                            (command: StartRoundRequest) => Promise<StartRoundResponse>;
export const joinRound:     (deps: /* journal, store, broadcast, tokens, clock, ids */) => (command: JoinRoundRequest) => Promise<JoinRoundResponse>;
export const addGame:       (deps: /* journal, broadcast, clock, ids */) => (claims: ParticipantClaims, command: AddGameRequest) => Promise<AddGameResponse>;
export const recordScore:   (deps: /* journal, broadcast */) => (claims: ParticipantClaims, command: RecordScoreRequest) => Promise<RecordScoreResponse>;
export const finalizeRound: (deps: /* journal, store, broadcast, clock, ids */) => (claims: ParticipantClaims) => Promise<FinalizeRoundResponse>;
export const readEvents:    (deps: { journal: EventJournal }) => (roundIdValue: RoundId, sinceSeq: number) => Promise<EventsResponse>;
```

Semantics (fixed): every claims-taking use case first reduces `journal.read(roundId, 0)` — empty log → `round-not-found`; claims golfer not in participants → `not-a-participant`. `JoinRound`/`AddGame` require status ≠ `final` (else `round-final`); `RecordScore` requires `live` (else `round-not-live`); tee names are validated via domain `findTeeSet` (its `unknown-tee-set` DomainError propagates); `AddGame` validates every golfer referenced by the config (players / a / b pairs) is a participant (else `unknown-golfer-in-game`) and assigns `gameId(ids.newId())`. `RecordScore` builds the event from the client's `opId`/`hlc`/subject/`hole`/`result` with `authorId: claims.golferId`; a `duplicateOpIds` hit returns `{ duplicate: true }` (no `seq`) and does NOT broadcast; a fresh append returns `{ seq: <the stamped seq>, duplicate: false }`. `FinalizeRound`: if already `final`, recompute `settleRound(read(0))` and return (idempotent, no append); else append `round-finalized`, `settleRound` over the FULL post-append log, `store.putArchive`, broadcast, return `{ results, handicapping }` from the archive. Non-duplicate appends always broadcast the seq-stamped events.

`testing/fakes.ts`: `createInMemoryJournal()` (assigns contiguous seq from 1; enforces opId dedupe returning `duplicateOpIds` — it must honor the SAME contract the Dynamo adapter is tested against), `createInMemoryRoundStore()`, `createCapturingBroadcast()` (records `publish` calls), `createFixedClock(startMs)` (advances 1ms per call), `createSequentialIds(prefix)` (deterministic ids + join codes), `createNullLogger()`.

- [ ] **Step 1 (RED):** `roundSlice.test.ts` — the golden path drives all five use cases end-to-end through the fakes:

```ts
// Abridged to the assertions that pin behavior; build the full test with the fakes above.
const host = await start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
const bo = await join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });
const hostClaims = { roundId: host.roundId, golferId: host.golferId };
await addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
// ... record Ann's and Bo's stableford golden cards (Ann [5,6,3,PU,5,4,5,6,5], Bo [4,4,3,5,5,3,4,5,4]) via recordScore,
//     each event carrying a client hlc/opId; Bo's phone records Ann's h1 (score-for-anyone) — assert the stored
//     event's authorId is Bo and golferId is Ann.
const dup = await record(hostClaims, sameOpIdCommand);        // exact re-send
expect(dup.duplicate).toBe(true);
expect(capturedBroadcasts.filter(sameOpId)).toHaveLength(1);   // duplicate never re-broadcast
const final = await finalize(hostClaims);
expect(final.results).toEqual([expect.objectContaining({ kind: "stableford",
  points: [ { golferId: host.golferId, points: 15 }, { golferId: bo.golferId, points: 19 } ] })]); // M2 golden numbers
```

Plus focused cases: join with a bad code → `bad-join-code`; record before any game/join by a stranger token → `not-a-participant`; record on a finalized round → `round-not-live`; join after finalize → `round-final`; addGame referencing a non-participant → `unknown-golfer-in-game`; finalize twice → second returns identical results with no new events (assert journal length unchanged); every server-authored event has `deviceId "server"`, clock-driven `hlc`, and the correct `authorId`; StartRound's append is exactly `[round-created, participant-joined, round-started]` in that order with contiguous seq 1..3.
- [ ] **Step 2 (GREEN):** implement ports, errors, policy, fakes, use cases.
- [ ] **Step 3:** barrel; `pnpm validate`; suite ×2 (`pnpm -F @swng/application test`); commit `feat(application): round use cases over ports — create/join/add-game/score/finalize with idempotent ingest`.

---

### Task 3: `@swng/adapters-dynamodb` — journal, store, connection registry

**Files:**
- Create: `packages/adapters-dynamodb/src/keys.ts`, `src/createDynamoEventJournal.ts`, `src/createDynamoRoundStore.ts`, `src/createDynamoConnectionRegistry.ts`, `src/testing/local.ts` (DynamoDB Local lifecycle + table creation for contract tests)
- Modify: `packages/adapters-dynamodb/package.json` (deps `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` via catalog entry `^3.700.0`; scripts add `"test:contract": "DYNAMO_CONTRACT=1 vitest run src/contract"`), `pnpm-workspace.yaml` (catalog: the two SDK packages), root `package.json` (script `"test:contract": "pnpm -F @swng/adapters-dynamodb test:contract"`)
- Replace barrel; delete placeholder test
- Test: `packages/adapters-dynamodb/src/keys.test.ts` (hermetic, in validate), `packages/adapters-dynamodb/src/contract/journal.contract.test.ts`, `src/contract/store.contract.test.ts` (contract suite — NOT in validate; the whole `src/contract/` dir is excluded from the default vitest run via `exclude` in the package vitest config unless `DYNAMO_CONTRACT=1`)

**Interfaces (produced):**

```ts
export const createDynamoEventJournal: (config: { client: DynamoDBDocumentClient; tableName: string }) => EventJournal;
export const createDynamoRoundStore:   (config: { client: DynamoDBDocumentClient; tableName: string }) => RoundStore;
export const createDynamoConnectionRegistry: (config: { client: DynamoDBDocumentClient; tableName: string }) => ConnectionRegistry;
// keys.ts
export const roundPk = (id: RoundId) => `ROUND#${id}`;
export const evtSk = (seq: number) => `EVT#${String(seq).padStart(10, "0")}`;  // lexical order === numeric order
export const opIdSk = (id: OpId) => `OPID#${id}`;
```

Journal `append` algorithm (fixed): (1) Query head seq (`ScanIndexForward: false, Limit: 1`, sk `begins_with EVT#`); (2) `TransactWriteItems` — for event i: Put `{ pk, sk: evtSk(head+1+i), event: <seq-stamped event>, opId }` with `attribute_not_exists(sk)` AND Put `{ pk, sk: opIdSk(event.opId) }` with `attribute_not_exists(sk)`; (3) on `TransactionCanceledException` read `CancellationReasons`: an OPID collision → drop those events, retry with the remainder (all duplicates → return `{ appended: [], duplicateOpIds }`); an EVT collision (seq race) → re-read head and retry everything (bounded retries, then throw). `read` Queries sk between `evtSk(since+1)` and `EVT#9999999999`, paginating, returning the stored `event` attribute.

RoundStore: META item `{ pk, sk: "META", joinCode, roundId }` with `attribute_not_exists(sk)`; `findByJoinCode` queries `gsi1` (partition `joinCode`); `putArchive` puts `{ pk, sk: "ARCHIVE", archive }` unconditionally (re-finalize after reopen overwrites — projections treat finalize as an idempotent upsert). ConnectionRegistry: put/delete `CONN#<id>` items; `listByRound` queries `gsi1` (partition `roundId`).

`testing/local.ts`: downloads DynamoDB Local (`https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz`) into `node_modules/.cache/dynamodb-local/` if absent, spawns `java -jar DynamoDBLocal.jar -inMemory -port <free port>`, creates the `rounds` + `connections` tables with the exact key/GSI shapes from the Global Constraints, and tears down. Java missing or download failing → the contract suite FAILS with a clear message (no silent skip; it is not part of validate).

- [ ] **Step 1 (RED, hermetic):** `keys.test.ts` — padding (seq 7 → `EVT#0000000007`), lexical-order property (`evtSk(a) < evtSk(b)` iff `a < b` via fast-check over int pairs).
- [ ] **Step 2 (GREEN):** implement `keys.ts`; commit hermetic slice if desired.
- [ ] **Step 3 (RED, contract):** contract tests against DynamoDB Local: append assigns 1..n contiguous; a second append continues the sequence; concurrent appends (two `Promise.all`ed appends of 5 events each from two journal instances) produce 10 events with seqs exactly 1..10 and no duplicates; exact-duplicate `opId` re-send → `{ appended: [], duplicateOpIds: [op] }` and the log unchanged; `read(sinceSeq)` slices correctly and paginates (>1MB not needed — assert with a page-size-1 client override or 150 events); store create/find/put-archive round-trip; `findByJoinCode` on an unknown code → undefined; registry register/list/deregister round-trip.
- [ ] **Step 4 (GREEN):** implement the three adapters. Run `pnpm test:contract` — green.
- [ ] **Step 5:** `pnpm validate` (hermetic tests only) ×2 on the domain-style flake check for the fast-check property; commit `feat(adapters-dynamodb): event journal with transactional seq+opId ingest, round store, connection registry`.

---

### Task 4: `@swng/lambda` + `@swng/adapters-apigateway` — dispatcher, entries, tokens, broadcast

**Files:**
- Create: `packages/lambda/src/auth/hmacTokenIssuer.ts`, `src/http/routes.ts`, `src/http/dispatch.ts`, `src/http/errorMapping.ts`, `src/compositionRoot.ts`, `src/entries/http.ts`, `src/entries/wsConnect.ts`, `src/entries/wsDisconnect.ts`
- Create: `packages/adapters-apigateway/src/createApiGatewayBroadcast.ts`
- Modify: `packages/lambda/package.json` (dep `@aws-sdk/client-apigatewaymanagementapi` is NOT here — it lives in adapters-apigateway; lambda gets no new AWS deps beyond what adapters re-expose through factories; devDep `@types/aws-lambda` via catalog), `packages/adapters-apigateway/package.json` (dep `@aws-sdk/client-apigatewaymanagementapi` catalog `^3.700.0`), catalog additions
- Replace barrels; delete placeholder tests
- Test: `packages/lambda/src/auth/hmacTokenIssuer.test.ts`, `src/http/dispatch.test.ts`, `packages/adapters-apigateway/src/createApiGatewayBroadcast.test.ts`

**Interfaces (produced):**

```ts
// hmacTokenIssuer.ts (lambda/src/auth — node:crypto is legal here; graduates to an adapter package only when a second consumer exists)
export const createHmacTokenIssuer: (config: { secret: string; clock: Clock; ttlMs?: number /* default 24h */ }) => TokenIssuer;
// token = base64url(JSON{roundId,golferId,exp}) + "." + base64url(hmacSha256(secret, payload)); verify: timingSafeEqual + exp > clock.now()

// http/routes.ts — the declarative table. Each route: method, path template, schema (or none), auth: "none" | "participant", handler.
export interface RouteContext { claims?: ParticipantClaims; pathParams: Record<string, string>; }
export interface UseCases { // the deps-applied use-case functions from Task 2, one per route
  startRound: (c: StartRoundRequest) => Promise<StartRoundResponse>;
  joinRound: (c: JoinRoundRequest) => Promise<JoinRoundResponse>;
  addGame: (claims: ParticipantClaims, c: AddGameRequest) => Promise<AddGameResponse>;
  recordScore: (claims: ParticipantClaims, c: RecordScoreRequest) => Promise<RecordScoreResponse>;
  finalizeRound: (claims: ParticipantClaims) => Promise<FinalizeRoundResponse>;
  readEvents: (id: RoundId, sinceSeq: number) => Promise<EventsResponse>;
}
export const buildRoutes: (useCases: UseCases) => readonly Route[];
//   POST /rounds                    none        startRoundRequestSchema
//   POST /rounds/join               none        joinRoundRequestSchema
//   POST /rounds/{roundId}/games    participant addGameRequestSchema
//   POST /rounds/{roundId}/scores   participant recordScoreRequestSchema
//   POST /rounds/{roundId}/finalize participant (no body)
//   GET  /rounds/{roundId}/events   participant (query ?since=N, default 0)
// participant auth: Bearer token verified via TokenIssuer; claims.roundId must equal pathParams.roundId (else token-round-mismatch).

// http/dispatch.ts — one generic dispatcher over the table: match route → verify auth → parse(schema, JSON.parse(body)) →
// handler → 200/201 JSON; all thrown errors → errorMapping. APIGatewayProxyEventV2 in, APIGatewayProxyResultV2 out.
export const createDispatcher: (routes: readonly Route[], tokens: TokenIssuer, logger: Logger) => (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

// http/errorMapping.ts — the ONE code→status map from Global Constraints. Unknown errors: log, 500, generic body.
export const toHttpError: (error: unknown, logger: Logger) => { statusCode: number; body: string };

// adapters-apigateway
export const createApiGatewayBroadcast: (config: { client: ApiGatewayManagementApiClient; connections: ConnectionRegistry; logger: Logger }) => Broadcast;
// publish: listByRound → PostToConnection(wsEnvelope JSON) each, Promise.allSettled; GoneException (410) → deregister that connection; other failures logged, never thrown (delivery sugar must not fail the command).

// compositionRoot.ts — built ONCE at module scope from env: TABLE_ROUNDS, TABLE_CONNECTIONS, TOKEN_SECRET, WS_ENDPOINT.
// Wires Dynamo clients, journal/store/registry, broadcast, hmac issuer, Clock = { now: () => Date.now() },
// IdGenerator = crypto.randomUUID + join-code gen over the fixed alphabet, console Logger.
export const buildApp: (env: NodeJS.ProcessEnv) => { dispatcher: ..., registry: ConnectionRegistry, tokens: TokenIssuer };

// entries/http.ts: export const handler = (event) => app.dispatcher(event)
// entries/wsConnect.ts: verify ?token= (roundId comes from the claims) → registry.register(connectionId, claims.roundId) → 200; bad token → 401
// entries/wsDisconnect.ts: registry.deregister(connectionId) → 200
```

- [ ] **Step 1 (RED):** `hmacTokenIssuer.test.ts` — issue→verify round-trips claims; tampered payload → undefined; tampered signature → undefined; expired (fixed clock advanced past ttl) → undefined; token from a different secret → undefined.
- [ ] **Step 2 (GREEN):** implement the issuer.
- [ ] **Step 3 (RED):** `dispatch.test.ts` with application's in-memory fakes wired through `buildRoutes`: full HTTP-shaped golden path (create → join → add game → score → duplicate re-send → finalize) asserting status codes and parsed bodies; missing/garbage bearer token → 401; token for round X used on round Y's path → 403; zod-invalid body → 400 with `errorResponseSchema` shape; unknown path → 404. `createApiGatewayBroadcast.test.ts` with a fake management client + in-memory registry: publishes the `wsEnvelope` to every connection; a client throwing GoneException gets deregistered; a throwing client never rejects `publish`.
- [ ] **Step 4 (GREEN):** implement routes/dispatch/errorMapping/composition/entries/broadcast.
- [ ] **Step 5:** `pnpm validate`; suites ×2; commit `feat(lambda,adapters-apigateway): declarative HTTP dispatcher, HMAC participant tokens, WS entries and broadcast`.

---

### Task 5: `apps/infra-cdk` — the swng-beta stack, synthesized, tested, deployed

**Files:**
- Create: `apps/infra-cdk/lib/swngStack.ts`, `apps/infra-cdk/test/swngStack.test.ts`
- Modify: `apps/infra-cdk/bin/infra-cdk.ts` to instantiate `SwngStack` with id `swng-beta` (stage-parameterized: `swng-${stage}`, default beta; **assert at construct time the id never matches `/^InfraCdkStack/`**), `apps/infra-cdk/package.json` (add `vitest`/`@types/node` catalog devDeps as needed; scripts: `"test": "vitest run"`, `"typecheck": "tsc -p tsconfig.json"`, `"synth": "cdk synth --profile swng"`, `"deploy:beta": "cdk deploy swng-beta --profile swng --require-approval never --outputs-file cdk-outputs.json"`), root `package.json` (`"deploy:beta": "pnpm -F @swng/infra-cdk deploy:beta"`)
- Delete: the `PlaceholderStack` and its references

**Stack shape (fixed):**
- Tables (all `BillingMode.PAY_PER_REQUEST`, `RemovalPolicy.RETAIN` on `rounds`, DESTROY on `connections`, RETAIN on `core`/`projections`): `swng-rounds-beta` (pk `pk` S, sk `sk` S; GSI `gsi1`: pk `joinCode` S), `swng-core-beta` (pk/sk), `swng-projections-beta` (pk/sk), `swng-connections-beta` (pk `pk` S; GSI `gsi1`: pk `roundId` S).
- Functions (`NodejsFunction`, Node 20 runtime, esbuild bundling, entry files in `packages/lambda/src/entries/`): `http`, `wsConnect`, `wsDisconnect`. Env: `TABLE_ROUNDS`, `TABLE_CONNECTIONS`, `TOKEN_SECRET` (from a CDK-generated `Secret` via `secretValue.unsafeUnwrap()` — beta-grade, M9 hardens), `WS_ENDPOINT` (the WS API callback URL).
- `HttpApi` with the six routes → `http` function (amended during execution: plus `corsPreflight` — wildcard origin, GET/POST, content-type/authorization headers — beta-grade forward-work for the M4/M5 browser client; M9 revisits origins). `WebSocketApi` with `$connect` → wsConnect, `$disconnect` → wsDisconnect; `WebSocketStage` named `beta`. Grants: rounds table RW to `http`; connections table RW to all three; `execute-api:ManageConnections` on the WS API to `http`.
- `CfnOutput`s: `HttpApiUrl`, `WsApiUrl`.

- [ ] **Step 1 (RED):** `swngStack.test.ts` with `aws-cdk-lib/assertions`: exactly 4 `AWS::DynamoDB::Table`s with the exact key schemas and GSIs above; 3 `AWS::Lambda::Function`s with the env keys present; an `AWS::ApiGatewayV2::Api` of protocol HTTP and one of protocol WEBSOCKET; stack id assertion test (`new SwngStack(app, "InfraCdkStack-beta")` throws).
- [ ] **Step 2 (GREEN):** implement the stack; delete PlaceholderStack; `pnpm validate` (the assertions test runs in validate — synth is offline and hermetic).
- [ ] **Step 3 — DEPLOY:** `pnpm deploy:beta` (AWS creds, profile `swng`). If the sandbox blocks network/creds, report BLOCKED with the exact command for the controller. Verify: `aws cloudformation describe-stacks --stack-name swng-beta --profile swng --query 'Stacks[0].StackStatus'` → `CREATE_COMPLETE`/`UPDATE_COMPLETE`; capture `cdk-outputs.json`. Confirm the POC stacks were untouched (`describe-stacks` on `InfraCdkStack-beta` still exists, unchanged timestamps).
- [ ] **Step 4:** commit `feat(infra): swng-beta stack — tables, HTTP+WS APIs, entry functions (POC stacks untouched)`.

---

### Task 6: E2E gate — the M2 concurrency deck over the wire, and master-plan reconciliation

**Files:**
- Create: `e2e/package.json` (`@swng/e2e`, private; deps `@swng/contracts`, `@swng/domain`, `ws` + `@types/ws`; scripts `"test:e2e": "vitest run --config vitest.e2e.config.ts"` — deliberately NOT named `test`, so `pnpm test` never runs it — and `"typecheck": "tsc -p tsconfig.json"` so validate still typechecks the harness), `e2e/tsconfig.json`, `e2e/vitest.e2e.config.ts` (testTimeout 60_000), `e2e/roundSlice.e2e.test.ts`, `e2e/support/client.ts` (thin fetch+ws harness: per-client `deviceId`, monotonic hlc counter, opId generator, `parse()` of every response and WS message through the contracts schemas)
- Modify: root `package.json` (`"e2e:beta": "pnpm -F @swng/e2e test:e2e"`), `pnpm-workspace.yaml` (add `- "e2e"` to the packages globs — `apps/*`/`packages/*` do not match it)
- Modify: `docs/implementation-plan.md` — M3 section ONLY: add `AddGame` to the use-case list with one clause of why (game configs reference join-time golfer ids); note rounds are live from creation in v1 (no go-live command); note the E2E gate reuses the M2 concurrency deck's numbers. Nothing else in the file.

**The E2E scenario (fixed — these are the M2 hand-verified numbers):**

Endpoints from env `E2E_HTTP_URL`/`E2E_WS_URL`, falling back to `apps/infra-cdk/cdk-outputs.json`.

1. **Client 1 (Ann's phone):** `POST /rounds` with `fixtureLinks` and host `{ name: "Ann", tee: "white", courseHandicap: 8 }` → keep `joinCode`, `token1`, `annId`. Open WS with `token1`.
2. **Client 2 (Bo's phone, scoring for two):** `POST /rounds/join` `{ code, name: "Bo", tee: "white", courseHandicap: 2 }` → `token2`, `boId`; join again `{ name: "Cal", courseHandicap: 12 }` → `token2c`, `calId` (two golfers, one phone — score-for-anyone is the product). Open WS with `token2`.
3. Client 1 adds both games: skins `{ players: [annId, boId, calId] }` and stableford `{ players: [annId, boId, calId] }`.
4. Score the deck concurrently: client 1 records Ann's card `[5,5,4,6,5,4,5,6,"picked-up"]`; client 2 records Bo's `[4,5,3,6,4,4,4,5,4]` and Cal's `[6,7,4,8,6,5,6,7,6]` (interleaved `Promise.all` batches — the journal's seq race handling is under test here).
5. **Cross-receipt over WS:** client 1's socket must receive Bo's and Cal's `score-recorded` events (27 within the deck); client 2's socket must receive Ann's. Every WS message parses with `wsEnvelopeSchema`.
6. **Idempotency:** client 2 re-sends one of its exact `RecordScore` bodies (same `opId`) → `{ duplicate: true }`, and neither socket receives a second copy.
7. **The correction:** client 2 records Ann h9 → `4` gross with a later hlc (score-for-anyone again).
8. `POST /rounds/{id}/finalize` (client 1) → the response's skins result carries ann 8 / bo 1 skins with `carriedOut: 0`, and the stableford result carries points ann 18 / bo 17 / cal 10 — the M2 concurrency-deck post-correction numbers, now reproduced over deployed infrastructure. Pin exact shapes by deep-equal against locally recomputed `resultOf(scoreGame(config, reduceRound(fetchedLog)))` for both games (step 9 fetches the log) rather than hand-writing the `won` array's zero-entry convention. `handicapping` has all three golfers `complete`.
9. **Catch-up is the correctness path:** `GET /rounds/{id}/events?since=0` returns the full log, seqs contiguous from 1; reducing it with `@swng/domain`'s `reduceRound` and scoring both games locally equals the finalize response (client/server parity over the wire).
10. Finalize again → identical results (idempotent).

- [ ] **Step 1:** build the harness + test file (RED is trivial here — it fails against a missing env; develop against beta directly).
- [ ] **Step 2:** run `pnpm e2e:beta` until green, then run it a second time (fresh round each run — the suite must be re-runnable against a shared stack).
- [ ] **Step 3:** master-plan reconciliation edits; `pnpm validate`; commit `feat(e2e): deployed vertical-slice gate — M2 concurrency deck reproduced over the wire; M3 gate met`.

**M3 gate (from `docs/implementation-plan.md`):** scripted E2E against beta — two simulated clients join by code, score concurrently, both receive each other's events over WS, finalize returns results matching a golden card, duplicate `opId` re-send is a no-op. All met by Task 6's scenario; adapter contract tests (`pnpm test:contract`) green is part of the gate evidence.
