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
- **Two clocks, two jobs:** server-assigned `seq` for canonical order and cursors, authoring
  `hlc` for score-cell conflict resolution, `opId` for idempotency — naive wall clocks never.
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
2. `RoundEvent` union (`architecture.md` §2) with HLC envelope, and
   `reduceRound(events: RoundEvent[]): RoundState` — lifecycle enum, per-cell LWW registers
   resolved by author `hlc` (tie-break `deviceId`) with audit, unknown-event tolerance.
3. Games framework: `GameConfig`/`GameState` discriminated unions (`GameResult` settlement
   currency lands in M2), `scoreGame(config, reducedState)` dispatch, allowances table.
4. `allocateStrokes(courseHandicap: number, teeSet: TeeSet): number[]` — dots by stroke
   index, including >18 and plus handicaps.
5. `strokePlay` reducer (gross/net; picked-up scores net via net double bogey, gross marked
   incomplete) + golden-card deck.
6. `singlesMatch` reducer (holes up/dormie/closed out `3&2`, concessions, full-difference
   allowance) + golden-card deck.
7. Property tests: net ≤ gross, reducer determinism, replay idempotence, merge
   order-independence (any delivery order converges).

**Produces:** `reduceRound`, `scoreGame(config, reducedState)`, `allocateStrokes`, the event and config unions —
the signatures every later milestone consumes.

**Gate:** golden decks pass; `pnpm -F @swng/domain test` green; property suite green.

### M2 — Domain: full v1 menu + handicap engine

**Goal:** all five v1 formats concurrent on one card, and WHS-faithful handicap math.

**Tasks:**
1. `stableford` reducer (standard points; pickup = 0) + deck.
2. `fourballMatch` reducer (best ball per side, table allowance) + deck.
3. `skins` reducer (carryovers, tie-push, optional validation) + deck.
4. Concurrent-games integration deck: `stableford` + `skins` on one log; one
   `ScoreCorrected` recomputes both.
5. Handicap engine: net-double-bogey adjusted gross; differential
   `(113/slope) × (AGS − rating)`; 9-hole handling; `computeIndex(differentials)` — best 8 of
   20 with WHS small-sample table; `courseHandicap(index, teeSet)`.
6. `settleRound(events): RoundArchive` — the immutable archive (setup + course snapshot, final
   grid, event log, per-game results, per-golfer differentials; complete by rule). Settlement
   determinism test: settling the same log twice is byte-identical.

**Gate:** every format's deck passes; handicap engine verified against published WHS worked
examples; concurrency deck passes.

### M3 — Backend vertical slice (deployed to beta)

**Goal:** the full server path live: create → join by code → score → broadcast → finalize.

**Tasks:**
1. `contracts`: Zod schemas for round commands/queries and the WS envelope.
2. `application`: ports `EventJournal`, `RoundStore`, `Broadcast`, `TokenIssuer`, `Clock`,
   `IdGenerator`, `Logger`; use cases `StartRound`, `JoinRound`, `AddGame` (a game's config
   references join-time golfer ids, so it can only be added once the round has participants
   to reference), `RecordScore`, `FinalizeRound`; typed errors; `ScoringPolicy` authorization.
   Rounds are live from creation in v1 — `StartRound`'s one append is already
   genesis + host-join + start, in that fixed order; there is no separate go-live command.
3. `adapters-dynamodb`: `createDynamoEventJournal` (conditional put on `seq`),
   `createDynamoRoundStore`; contract tests against local DynamoDB.
4. `lambda`: declarative dispatcher table, one composition root, `http/` and `ws/` entries;
   `createApiGatewayBroadcast`.
5. Join code → signed round-scoped participant token (ghost golfer created at join).
6. `infra-cdk`: fresh beta stack — `rounds`/`core`/`projections`/`connections` tables, HTTP +
   WS APIs, per-entry functions. Deploy.

**Gate:** scripted E2E against beta: two simulated clients join by code, score concurrently,
both receive each other's events over WS, finalize returns `RoundResult`s matching a golden
card. Idempotent re-send of an `opId` is a no-op. The golden card is the M2 concurrency
deck's own hand-verified post-correction numbers (`packages/domain/src/scoring/concurrent.test.ts`)
— the E2E gate's job is proving the deployed server reproduces those exact numbers over the
wire, not inventing a new fixture.

### M4 — Client SDK: live sync + offline

**Goal:** the sync engine — optimistic, offline-tolerant, provably convergent with the server.

**Tasks:**
1. HTTP client + WS subscription from `contracts` types.
2. `createRoundSession(config)`: optimistic local append reduced through **the same
   `@swng/domain`** reducers; `opId` generation. Returns the session object itself (`state()`,
   `games()`, `recordScore()`, `sync()`, `connect()`/`disconnect()`, `pending()`/`rejected()`,
   `onChange()`, `close()`) — sessions do not auto-sync on construction; the caller drives
   `connect()`/`sync()` explicitly.
3. Outbox queue + reconnect protocol: push pending (deduped by `opId`), pull since `seq`,
   HLC merge on refold; queue persistence behind a storage port (memory + IndexedDB). The full
   HLC (not just wall-clock) is the merge key, with an explicit receive rule: observing a
   remote hlc floors the local clock source at it, so a correction authored on a skewed-behind
   phone still wins the LWW register it corrects once that phone's next op is stamped.
4. Convergence simulation: N virtual devices, randomized offline windows, corrections,
   duplicate/out-of-order delivery — every interleaving converges to the sequential oracle
   (`client result === server result`).

**Produces:** `createRoundSession` — the only API the web app scores through.

**Gate:** parity suite green; kill-network integration test (queue, reconnect, converge)
green against beta. As executed: the convergence simulation
(`packages/client/src/convergence.properties.test.ts`) plus a kill-network scenario against
the deployed beta stack (`e2e/syncSession.e2e.test.ts` — two real sessions, one goes dark
mid-round and queues its whole card offline, network restored, both converge on the M2 golden
stableford numbers over the real HTTP + WS transport).

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

**M4 → M5 handoff** (from the M4 closing fix wave):
- `deviceId` must be minted per LIVE SESSION, not per browser/user — reusing one across
  concurrent sessions sharing a store makes them mint colliding opIds (same opCounter),
  which the server silently dedupes down to one side's score. M5 must mint a fresh
  `deviceId` per browser tab.
- `createRoundSession` needs a readiness accessor: `state()`/`games()` currently throw
  `DomainError` before genesis is ingested, which the UI can't call blind on first render —
  add `hydrated()` or equivalent. Separately, `games()` returns a fresh array on every call;
  the UI layer must cache it itself for `useSyncExternalStore` identity, or it will re-render
  in a loop.
- `close()` only guarantees the final outbox persist completed, not that a sync reached
  quiescence (pending events may still be un-pushed when it resolves).
- `rejected()` is in-memory only — not persisted across restarts; a permanently-rejected op
  is forgotten on reload.
- The stableford-golden-card server-log-building helper is duplicated across
  `e2e/syncSession.e2e.test.ts` and `e2e/roundSlice.e2e.test.ts` (and mirrors
  `session.test.ts`'s `buildServerLog`) — extract it to a shared spot on the next touch to
  either file, rather than letting a third copy accrete.

**M5 gate — as executed (Task 7):** `apps/web/e2e/fieldTest.spec.ts` (`pnpm e2e:field`,
Playwright) plays the deck in `@swng/domain`'s `fieldDeck18`/`fixtureLinks18`
(`packages/domain/src/scoring/golden/fieldDeck18.ts` — fourball Ann+Bo vs Cal+Dee closing
2&1, skins 0/7/0/8 with 3 carried out) through the real UI, two Chromium contexts against the
deployed `swng-beta` stack (`playwright.config.ts`'s `webServer` runs
`scripts/webEnv.mjs && vite build && vite preview`). Expected UI strings are derived, not
hand-copied: the spec folds the deck's own scores/corrections through `reduceRound` +
`scoreGame` and reads the result back through the app's own `describeGame`
(`apps/web/e2e/support.ts`), so a UI wording change and a deck change can't silently drift
apart. Per-tab identity: each Playwright `BrowserContext` is one browser tab in the M4→M5
handoff's sense, so `tabDeviceId()`'s per-tab `sessionStorage` id already gives contexts A/B
distinct `deviceId`s with no test-side plumbing. Cal and Dee join over a direct HTTP fetch
from the spec (`joinRoundDirect`), not a third browser context — score-for-anyone makes their
own tabs unnecessary, and joining them through context A's browser would overwrite Ann's
`swng:credential:<roundId>` entry (one credential per round per browser, not per golfer).
Debugging finding: Chromium's `context.setOffline(true)` blocks new HTTP/WS connections but
does **not** close an already-open WebSocket, so B's socket needed an explicit
`routeWebSocket(...).close()` to produce the client-visible disconnect (offline banner, the
"Sync now" reconnect affordance) a real dropped connection would — see the spec's own
`beforeAll` comment. A proxied connection was also observed to occasionally die silently late
in a run without firing the page's `onclose` (no periodic pull in this client to notice and
recover on its own); `waitForFinalOrRecover` races the finalize heading against the offline
banner and taps "Sync now" if the banner wins — the same recovery a real golfer has, not a
hidden retry. Gate met: 3 consecutive green `pnpm e2e:field` runs (fresh round each time).

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

**M6 gate — as executed (Task 6):** `apps/web/e2e/courseEntry.spec.ts` (new) plays the
milestone's own hand-verified gate card ("Casa Verde GC", white tees, rating 71.1, slope 129)
through the real UI, one Chromium context against the deployed `swng-beta` stack: search comes
up empty for a per-run-unique name, "Add a course" hands off to `AddCoursePage`, all 18 rows of
the grid are filled keyboard-only (one script-driven `focus()` into hole 1's par field, then
Tab/type for every subsequent field — par cells touched only where the card differs from the
par-4 default, the friction-proxy stand-in for the product's 10-minute paper-card bar), the
card is verified as "Sam" (`✓ 1 verified`), a round is created on it (Pat, white, ch 21), Quinn
joins over a direct HTTP fetch (ch 2, same score-for-anyone precedent as `fieldTest.spec.ts`'s
Cal/Dee), a singles match is added via `SetupPanel`, and the grid's dots are asserted
hole-by-hole (all 18 holes) against the plan's own hand-verified arithmetic:
`gameStrokeAllocation`'s singles-match branch is relative (higher-handicap player only),
`playingHandicap(|21-2|, 1) = 19`, and `allocateStrokes(19, 18 holes)` gives 1 dot every hole
plus a 2nd on stroke-index 1 (hole 3) — Pat ●● on hole 3, ● on every other hole including hole
18, Quinn none. The engines agreed with the plan's arithmetic on every hole — no BLOCKED trace
was needed. A hole is then scored two-tap and the net (gross − dots) is asserted on the cell.

The course API surface (M6 Task 4, `packages/lambda/src/http/routes.ts`, all `auth: "none"`
pending M7 identity): `POST /courses`, `POST /courses/{courseId}/tees`, `POST
/courses/{courseId}/verify`, `GET /courses/{courseId}`, `GET /courses?query=&limit=` (prefix
search on `courseNameKey`'s one normalization, the same one the store's write-side GSI key
uses), plus `GET /rounds/peek?code=` — a capability-scoped preview (course name + tee summaries
only, no `roundId`/card/participants) that lets `JoinRoundPage` show a real tee picker before
`joinRound`, falling back to free text with a note if the peek fails, since joining must never
be gated by the nicety. The backend carries that shipped alongside the routes: finalize now
validates settle-ability (`settleRound` over the candidate log) BEFORE appending
`round-finalized`, closing the "wedged final-but-unsettleable" failure mode a game-unresolved
throw used to leave behind; the append itself takes an optional `expectedHeadSeq` so a
`RecordScore` landing in the settle-check's own read gap forces a bounded re-validate instead
of a blind append.

Post-gate amendment (final whole-branch review): `POST /courses/{courseId}/verify` now
REQUIRES `version` in its body — a verification is an attestation of the exact numbers the
verifier looked at, so it pins the tee-set version it attests and a revision landing in
between returns 409 `tee-set-revised` (the web re-fetches and asks the golfer to review the
revised card before verifying). Without the pin, a verify racing a revision silently
transplanted onto numbers the verifier never saw, inverting the "a corrected card is
unverified until someone re-verifies it" rule.

`fieldTest.spec.ts` upkeep: `beforeAll` gains `ensureCourse("Fixture Links 18",
fixtureLinks18)` (`e2e/support.ts`) — search the public API by exact name, create-if-absent —
since `CreateRoundPage`'s fixture `<select>` is gone (M6 Task 5, commit `8d8d1ba`: search is
now the only picker); step 1 searches and taps the one result instead of selecting an option.
Idempotent across the gate's three runs: the course is created once, found by the other two.

Debugging finding (a real, deterministic bug, not a flake): that same Task 5 commit replaced
`ResultsView.tsx`'s own per-game `<ul>` (a direct sibling of the "Final results" `<h1>`) with
the SAME `StandingsHeader` tablist a live round renders — "the archive gets the same
chip-selected active game as a live round" (that commit's own message) — so
`fieldTest.spec.ts`'s finalize-step locator (an xpath `following-sibling::ul[1]` off that
heading) could never match again. Confirmed via a failed run's own ARIA snapshot, which showed
the tablist rendering the exact expected text right where the stale locator was looking past —
the product was correct; the test's own selector had gone stale. `pnpm e2e:field` hadn't been
re-run since that commit landed (by design it's excluded from `pnpm validate`), so nothing
caught it until this gate. Fixed to read the same tablist `chip()`/`getByRole("tablist", { name:
"Games" })` a live round already asserts against — the expected values themselves (still
derived from the deck via `describeFourballAt`/`describeSkinsAt`) are untouched.

A second, genuinely intermittent flake was also observed early in this gate's own debugging
runs (the hole-16 digest, and separately the pre-fix finalize step, each timed out waiting on
context B once, on different runs) — consistent with the M5 "as executed" note's own
documented risk ("a proxied connection was...observed to occasionally die silently late in a
run"). Not reproduced in any of the three official consecutive runs below; flagged here as a
standing risk, not something this task's scope covers fixing.

Gate met: `pnpm e2e:field` green three consecutive runs, 16/16 (7 `courseEntry.spec.ts` + 9
`fieldTest.spec.ts`) each time, ~18-19s per run — logs at
`.superpowers/sdd/m6-e2e-run-{1,2,3}.log`.

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
