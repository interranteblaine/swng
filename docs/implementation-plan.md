# swng v1 Implementation Plan (Master)

> **For agentic workers:** This is the master plan: build order, milestone scopes, interfaces,
> and verification gates. At the START of each milestone, generate that milestone's detailed
> task-by-task plan with superpowers:writing-plans (complete code, failing-test-first steps,
> saved to `docs/superpowers/plans/`), then execute it with
> superpowers:subagent-driven-development or superpowers:executing-plans. Do not execute from
> this document alone.

> Status: **proposed** (2026-07-07). Plans the build of v1 per `roadmap.md` on the
> architecture in `architecture.md`, written to `engineering-conventions.md`.

**Goal:** Ship v1 — The Saturday Game: a crew runs its standing game weekly in swng with
format-aware, handicap-aware live scoring, and every round counts forever.

**Architecture:** Round as event log + games as pure reducers; finalized rounds as source of
truth + rebuildable projections; one pure domain running in browser and Lambda
(`architecture.md` §1).

**Tech stack:** pnpm monorepo, TypeScript strict/ESM, Node 20+, React 19 + Vite + Tailwind 4,
Zod contracts, AWS via CDK (API Gateway HTTP + WebSocket, Lambda, DynamoDB + Streams,
Cognito, S3/CloudFront), Vitest.

## Global constraints

Every milestone's detailed plan inherits these:

- **TDD.** Every behavior lands test-first; domain tests are pure (no mocks).
- **`pnpm validate` green at every commit** — lint + build + test; never claim done without it.
- **Conventions are law** (`engineering-conventions.md` §6): `…Store` never `…Repository`;
  adapters `create<Tech><Capability>`, no `Port` suffix on interfaces; truthful names
  (`tee`, `strokeIndex`); no `| null` state unions; flat `src/`, group by concept, co-located
  `*.test.ts`, one barrel per package; layer direction `domain → application → adapters →
  lambda` lint-enforced; second instance ⇒ extract; comment the why only.
- **Derive, don't store**: persist irreducible facts; compute the rest.
- **Explicit `seq` and `opId`** for ordering and idempotency — never wall clocks.
- Packages are `@swng/*`; client depends on `contracts`, never `application`.
- AWS profile `swng`, region `us-east-1`, stages `beta`/`prod`.
- POC is reference-only. Never import its code; it exists at tag `poc-final`.

## Milestone map

```
M0 clean break ─ M1 round log + scoring core ─ M2 full menu + handicap   (pure domain)
      └─ M3 backend vertical slice (deployed) ─ M4 client sync SDK ─ M5 the Round UI
            └─ M6 courses ─ M7 identity + golfer record ─ M8 crews + ledger ─ M9 finish line
```

Each milestone ends with working, verifiable software and a gate. Order rationale: correctness
risk (games/handicap math) dies first in pure domain; integration risk dies early via a
deployed vertical slice; identity comes late because the system is **ghost-first** — join
codes and ghost golfers carry M3–M6, and accounts are just an upgrade (`architecture.md` §2).

---

### M0 — Clean break & foundations

**Goal:** an empty, correctly-tooled monorepo where the conventions are mechanically enforced.

**Tasks:**
1. Tag the POC (`git tag poc-final`) and delete `packages/*` and `apps/web` from main;
   keep `docs/`, root configs, `apps/infra-cdk` as a shell (deps and scripts only).
2. Root tooling: `tsconfig.base.json` (strict, NodeNext), workspace `vitest` config,
   `pnpm validate` wiring.
3. `eslint.config.js` with per-package `no-restricted-imports` allow-lists authored against
   the target layout (conventions §2c), plus naming bans (`Repository`, `Port` suffix).
4. Package skeletons with barrels and one placeholder test each: `domain`, `application`,
   `contracts`, `adapters-dynamodb`, `adapters-apigateway`, `adapters-cognito`,
   `adapters-powertools`, `lambda`, `client`.

**Gate:** `pnpm validate` green; a deliberate `domain → application` import fails lint
(demonstrated, then removed).

### M1 — Domain: round log & scoring framework

**Goal:** the event-sourced round and the games engine skeleton, proven on the two formats
that exercise handicaps hardest.

**Tasks:**
1. Core types: branded ids; `CourseCard`/`TeeSet`/`Hole { par, yardage, strokeIndex }`;
   `Participant { golferId, tee, courseHandicap }`.
2. `RoundEvent` union (`architecture.md` §2) and `reduceRound(events: RoundEvent[]): RoundState`
   — lifecycle enum, per-cell LWW by `seq` with audit, unknown-event tolerance.
3. Games framework: `GameConfig`/`GameState`/`GameResult` discriminated unions,
   `scoreGame(config, card, participants, events): GameState` dispatch, allowances table.
4. `allocateStrokes(courseHandicap: number, teeSet: TeeSet): number[]` — dots by stroke
   index, including >18 and plus handicaps.
5. `strokePlay` reducer (gross/net; picked-up scores net via net double bogey, gross marked
   incomplete) + golden-card deck.
6. `singlesMatch` reducer (holes up/dormie/closed out `3&2`, concessions, full-difference
   allowance) + golden-card deck.
7. Property tests: net ≤ gross, reducer determinism, replay idempotence.

**Produces:** `reduceRound`, `scoreGame`, `allocateStrokes`, the event and config unions —
the signatures every later milestone consumes.

**Gate:** golden decks pass; `pnpm -F @swng/domain test` green; property suite green.

### M2 — Domain: full v1 menu + handicap engine

**Goal:** all five v1 formats concurrent on one card, and WHS-faithful handicap math.

**Tasks:**
1. `stableford` reducer (standard points; pickup = 0) + deck.
2. `fourballMatch` reducer (best ball per side, table allowance) + deck.
3. `skins` reducer (carryovers, tie-push, optional validation) + deck.
4. Concurrent-games integration deck: `fourballMatch` + `skins` on one log; one
   `ScoreCorrected` recomputes both.
5. Handicap engine: net-double-bogey adjusted gross; differential
   `(113/slope) × (AGS − rating)`; 9-hole handling; `computeIndex(differentials)` — best 8 of
   20 with WHS small-sample table; `courseHandicap(index, teeSet)`.
6. `settleRound(round): RoundResult` — per-game results + per-golfer differentials, emitted
   at finalize.

**Gate:** every format's deck passes; handicap engine verified against published WHS worked
examples; concurrency deck passes.

### M3 — Backend vertical slice (deployed to beta)

**Goal:** the full server path live: create → join by code → score → broadcast → finalize.

**Tasks:**
1. `contracts`: Zod schemas for round commands/queries and the WS envelope.
2. `application`: ports `EventJournal`, `RoundStore`, `Broadcast`, `TokenIssuer`, `Clock`,
   `IdGenerator`, `Logger`; use cases `StartRound`, `JoinRound`, `RecordScore`,
   `FinalizeRound`; typed errors; `ScoringPolicy` authorization.
3. `adapters-dynamodb`: `createDynamoEventJournal` (conditional put on `seq`),
   `createDynamoRoundStore`; contract tests against local DynamoDB.
4. `lambda`: declarative dispatcher table, one composition root, `http/` and `ws/` entries;
   `createApiGatewayBroadcast`.
5. Join code → signed round-scoped participant token (ghost golfer created at join).
6. `infra-cdk`: fresh beta stack — `rounds`/`core`/`projections`/`connections` tables, HTTP +
   WS APIs, per-entry functions. Deploy.

**Gate:** scripted E2E against beta: two simulated clients join by code, score concurrently,
both receive each other's events over WS, finalize returns `RoundResult`s matching a golden
card. Idempotent re-send of an `opId` is a no-op.

### M4 — Client SDK: live sync + offline

**Goal:** the sync engine — optimistic, offline-tolerant, provably convergent with the server.

**Tasks:**
1. HTTP client + WS subscription from `contracts` types.
2. `createRoundSession(...)`: optimistic local append reduced through **the same
   `@swng/domain`** reducers; `opId` generation.
3. Outbox queue + reconnect protocol: push pending (deduped), pull since `seq`, rebase local
   state on server order; queue persistence behind a storage port (memory + localStorage).
4. Parity property test: any interleaving of local/remote events converges to the
   server-reduced state (`client result === server result`).

**Produces:** `createRoundSession` — the only API the web app scores through.

**Gate:** parity suite green; kill-network integration test (queue, reconnect, converge)
green against beta.

### M5 — The Round on the phone

**Goal:** the v1 round experience — a crew can actually play Saturday with it (fixture
courses).

**Tasks:**
1. Rebuild `apps/web`: routes for home, create, join-by-code, and the round view.
2. Score entry: two taps, score-for-anyone, picked-up/conceded as first-class entries; dots
   on the card.
3. Game-state surfaces: standings header per game, between-holes digest.
4. Finalize flow + results screen; archived card view (reads like a scorecard).
5. Round setup: games from `GameConfig` menu, tees per player, handicaps shown pre-tee.

**Gate:** simulated field test — two browsers, network toggled offline mid-round, full 18 of
`fourballMatch` + `skins`; digest and final results match the golden deck; every scoring
action ≤ 2 taps.

### M6 — Courses

**Goal:** real courses replace fixtures; course data becomes a product surface.

**Tasks:**
1. `domain/course`: entity + invariants (stroke-index permutation, rating/slope ranges,
   9/18-hole tee sets), provenance + verification state.
2. Contracts + use cases (`CreateCourse`, `AddTeeSet`, `VerifyCourse`, `SearchCourses`);
   `CourseStore` + adapter + lookup GSI.
3. Web: add-and-verify flow; course/tee picker in round setup; rounds freeze `CourseCard`
   snapshots (already in domain — wire the source).

**Gate:** enter a real course from its paper scorecard in under 10 minutes; a round on it
allocates dots correctly against a hand-checked card.

### M7 — Identity & the Golfer record

**Goal:** accounts, ghost-claiming, and the permanent record — the index goes live.

**Tasks:**
1. Cognito user pool (email + social) + JWT authorizer in CDK;
   `createCognitoIdentityProvider`; golfer↔sub mapping items; sign-in UI.
2. Claim flow: claim link/code attaches a sub to an existing ghost `GolferId` (one-row
   operation; history continuous by construction).
3. Projector lambda entry + DynamoDB Streams wiring: on finalize → `HISTORY#golfer` items and
   `INDEX#golfer` snapshots via `computeIndex`; `rebuild/` entry replays finalized rounds.
4. Web: profile (declared/official index entry with the 54-hole bootstrap rule), round
   history, index trend, scoring distribution.

**Gate:** on beta — finalize a round: history and index update live; claim a ghost mid-season
and the record is unbroken; wipe projections, run rebuild, values identical.

### M8 — Crews & the ledger

**Goal:** the Saturday Boys exist: presets, "play the usual," and the ledger.

**Tasks:**
1. `domain/crew` + `CrewStore`: roster (roles; ghost members), invariants.
2. Contracts + use cases: `CreateCrew`, `AddMember` (account or ghost), `SaveStandingGame`.
3. "Play the usual": round creation from a crew preset, `crewId` tag on the round.
4. Projector extension: `LEDGER#crew#season` (wins, points, skins) and `H2H#crew#a#b` items.
5. Web: crew home — roster, season leaderboard, head-to-head records, start-round-from-crew.

**Gate:** scripted season simulation (a dozen golden rounds) produces the exact expected
ledger and H2H records; creating Saturday's usual game is one tap from the crew page.

### M9 — Finish line: share, harden, ship

**Goal:** the v1 bar (`roadmap.md`) met on prod.

**Tasks:**
1. Spectator/share tokens + read-only live round view; shareable archived-card link.
2. Hardening: error surfaces, empty states, reconnect edge QA, basic rate limiting,
   monitoring/alarms on the beta stack.
3. Prod stack deploy + web publish; smoke E2E on prod.
4. **Field test against the v1 bar:** a real crew, real course, a real Saturday — zero paper,
   ≤20s/hole, handicaps trusted, ghost fully represented. Fix list burned down; bar re-run.

**Gate:** the four v1-bar bullets verified in the field, not in test.

---

## Risks watched

- **WHS/format math correctness** — golden decks checked against published worked examples
  and hand-scored cards (M1/M2 gates); every scoring bug becomes a card.
- **Offline convergence** — parity property tests (M4) before any UI exists.
- **Course-entry friction** — M6's 10-minute gate is the tripwire; licensing stays an open
  buy-vs-build fallback (`roadmap.md`).
- **Auth integration drag** — contained: identity is one milestone (M7) because the system is
  ghost-first by design.

## Not in this plan

Everything `roadmap.md` places beyond v1 (Nassau/presses, junk, card images, tags, trips,
leagues, outings), service workers/PWA install, native apps, course-data seeding imports,
official handicap posting.
