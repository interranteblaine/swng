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

**M7 gate — as executed (Task 8):** `docs/superpowers/plans/2026-07-10-m7-identity.md`'s eight
tasks, real code: `domain/golfer` (`Golfer`/`HandicapProfile`/`effectiveIndex`,
`archiveGolferLine`, `combineNineHoleDifferentials`'s 2020 published 9-hole pairing rule) and
`game-terminated` in the round log (a set-union fold — commutative, order-independent, tolerant
of arriving before its own `game-added`; `settleRound` excludes terminated games from the
must-resolve set and records `terminatedGameIds` on the archive) (T1); `contracts`/
`application` golfer and terminate use cases plus the ONE projector implementation
(`projectArchive` — stream trigger and manual `rebuildProjections` both call it, "no forked
math") (T2); `adapters-dynamodb` golfer store (sub-claiming via
`attribute_not_exists(sub)`, a real two-claimant race resolved to exactly one winner) and
projection store (T3); Cognito user pool + SPA client (authorization-code+PKCE for the real
app, `USER_PASSWORD_AUTH` enabled beta-grade purely so e2e can mint JWTs without the Hosted
UI), `adapters-cognito`'s `createCognitoVerifier`, the stream-triggered `ProjectorFunction` and
manual-invoke-only `RebuildFunction` (T4); the routes + the milestone's deploys (T5); web
sign-in/claim/profile/termination affordances and the finalize-error rewrite (T6); AddCoursePage
legibility + EditCoursePage (I2, approved) (T7); this gate (T8).

Two controller amendments landed mid-plan, both still true of the shipped system: **GET /me
never creates** (`getMyGolfer.ts`) — the plan's original get-or-create bound a sub to a
freshly-minted golfer the instant any screen called GET /me (e.g. on sign-in), so by the time a
golfer reached a claim button their own sub was already bound and every `claimGolfer` call hit
the "already claimed" collision arm; PUT /me (`updateMyGolfer.ts`) is now the one get-or-create
path, and `claimGolfer` creates the target ghost's row directly. **`differentialsUsed` is WHS
Rule 5.2a's `use` count** (`computeIndexDetail`'s own `differentialsUsed`, not the window size)
— e.g. 3 posted differentials → the lowest 1 is averaged → `differentialsUsed: 1`, wired through
`GetMyRecordResponse.index` unchanged since. Task 5b landed **ghost continuity** alongside
these: `JoinRoundRequest.golferId` is optional and, when supplied, reused as-is iff the golfer
is unclaimed (`joinRound.ts` — a claimed golferId, or one already in the round, is rejected) —
this is what lets one ghost play a whole season under one `GolferId` before anyone claims them,
and what Task 8's own gate scenario relies on to join round 1 and round 2 and round 3 as the
same `g`.

Four deploys landed real infrastructure during M7, not one: Task 5's own ("the ONE deploy" —
Cognito pool/client/domain, the stream + both new functions, the five golfer/terminate routes)
plus a same-task corrective redeploy (the route table shipped `PUT /me` but the HTTP API's CORS
preflight only allowed GET/POST, so a browser PUT was blocked until a one-line CORS fix landed
and redeployed); Task 5b's lambda-code-only redeploy for the `JoinRoundRequest.golferId`
change; Task 6's redeploy correcting the pool client's `callbackUrls` to carry the
`/auth/callback` path the web app's `authConfig.ts` actually redirects to (Cognito requires an
exact match — the bare `WEB_ORIGINS` default would have failed every real Hosted-UI round trip).
Task 8 itself deploys nothing (constraint: beta already had everything the gate needed).

Task 8's own gate: `apps/web/e2e/identityRecord.spec.ts` (new) mints a throwaway Cognito user
(`AdminCreateUser`/`AdminSetUserPassword`/`InitiateAuth` `USER_PASSWORD_AUTH`, `@aws-sdk/client-
cognito-identity-provider`, tokens injected into `localStorage["swng:auth"]` pre-navigation via
`page.addInitScript` — never the Hosted UI), plays three rounds as one ghost `g` (a fresh UUID
`GolferId`, reused across all three joins per Task 5b) on a throwaway rating-71.6/slope-128
course, all-pars-and-bogeys so no net-double-bogey cap bites: gross 82/85/88 → differentials
9.18125/11.8296875/14.478125 → three-differential small-sample row (use 1, adjustment −2.0) →
index **7.2**, `differentialsUsed` **1** — the live system agreed with the hand-pinned
computation exactly, no BLOCKED trace needed. Round 1 is created and finalized through the real
UI (the browser needs to open it *live* to claim `g` — `ResultsView` carries no roster at all,
so the claim has to land before that round's own finalize); rounds 2 and 3 are pure API, no
browser reason for one. `pnpm e2e:field`'s `invokeRebuild` helper resolves the `RebuildFunction`'s
physical name off the live stack's own CloudFormation resources (a hash-suffixed logical id,
looked up by prefix rather than hardcoded) and invokes it synchronously; the parity assertion
deep-equals `GET /me/record` before and after, deliberately excluding `index.computedAtMs` (a
fresh wall-clock stamp `projectArchive` takes on every recompute) — and separately asserts that
timestamp *changed*, the positive proof the rebuild actually recomputed rather than reading a
stale snapshot back untouched. **Debugging finding** (a real race, not a flake): a first
official run failed with `record.index` still `undefined` after `record.history` had already
reached 3 lines — `projectArchive`'s two writes per golfer (`putHistoryLine`, then a separate
later `putIndex` once the bootstrap is met) aren't transactional, and the test's own poll was
gated on history length alone, catching the gap between them. Fixed in the test (gate on both
conditions), not the product — nothing in the plan promises that pair is atomic. Termination
coverage lives in `fieldTest.spec.ts` as its own `describe.serial` block (the plan's own
suggestion, kept out of the M5 deck's numbered steps so a termination bug can never perturb
those assertions): a singles match closes 10&8 in 10 holes (the opponent picked up every hole,
losing each outright regardless of the actual score entered) while a stableford over the same
two players — which needs every hole decided for every player to resolve — sits at holes
11–18 unscored; the finalize dialog names it by exactly that clause, "End unfinished games &
finalize" terminates it and finalizes, and the finalize response itself (captured via
`page.waitForResponse`, parsed through `finalizeRoundResponseSchema`) has exactly one result
(the singles match) — `ResultsView` renders that result and the stableford chip's "Ended"
badge. Gate met: `pnpm e2e:field` green three consecutive runs, 27/27 (7 `courseEntry.spec.ts` +
9 `fieldTest.spec.ts` + 5 termination + 6 `identityRecord.spec.ts`) each time, ~50-53s per run —
logs at `.superpowers/sdd/task8-e2e-run-{1,2,3}.log`. Legibility screenshots (papercuts.md §4)
at `.superpowers/sdd/screenshots/` (gitignored, never committed): ProfilePage with a real
3-round record (index, trend, distribution), the signed-in header chrome alongside a fresh
claim confirmation, and the finalize dialog's own unresolved-games list — alongside Task 7's
already-captured Add/Edit course pages.

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

**M8 gate — as executed (Task 7):** `docs/superpowers/plans/2026-07-10-m8-crews-ledger.md`'s
seven tasks, real code: `domain/crew` — `Crew`/`CrewMember`/`StandingGame`, `addMember`
(duplicate-member `DomainError`), `applyStandingGame` (a game survives iff EVERY golferId it
references is present, preset order kept — mirrors `scoreGame`'s own per-kind dispatch) —
plus `round-created`'s optional `crewId`, carried through `RoundState`/`RoundArchive`
unchanged, and `crew/ledger.ts` (`crewContribution`/`aggregateSeason`, a pure commutative fold
over one archive's contribution) (T1); `contracts`/`application` crew use cases
(`createCrew`/`getCrew`/`listMyCrews`/`addCrewMember`/`joinCrewByCode`/`saveStandingGame`) plus
`rounds/golferIdentity.ts`'s ONE shared `resolveSuppliedGolfer` (four arms — unclaimed reuse,
as-self via matching sub, standing crew consent, else `golfer-claimed`) backing
`startRound`/`joinRound`/`addParticipant` alike, and the projector's crew extension
(upsert-by-roundId, then recompute+replace the whole `(crew, season)` aggregate — never `+=`)
(T2); `adapters-dynamodb`'s crew store (a transactional root+member-item write, a join-code GSI
partition namespaced apart from course search's own) and crew projections (`CREWROUNDS#`/
`RECORDS#` keyspaces, `wipeCrew` over caller-supplied seasons) (T3); 8 new routes (route parity
17→25) and `optional-golfer` auth (`POST /rounds`/`POST /rounds/join` take a Bearer when
offered, proceed anonymously when not, 401 on a token that's presented but fails verification)
(T4); the web identity wave — `CreateRoundPage`'s `asSelf` swap ("Playing as `<name>`" replaces
free-text entirely; signed-in-with-no-golfer PUTs `/me` THEN creates as-self, strictly in that
order), `SetupPanel`'s "Add player" (crew quick-adds ahead of a free-text ghost form), and
`ClaimAffordance` sending the roster row's own name with a claim (T5); crew home —
`CrewCreatePage`/`CrewPage` (join code, roster with claimed badges, `StandingGameEditor`,
season records: a ledger table sorted wins-then-points plus an H2H list) and "Play the usual"
(one tap into `CreateRoundPage`, pre-filled roster/games via `applyStandingGame` against
whoever's actually present) (T6); this gate (T7).

Two defects surfaced live during the milestone, both fixed and redeployed before their own
task closed, not carried forward:

- **T4's crewId defect.** `archive.ts`/`state.ts` used a bare `crewId: state.crewId`
  object-literal property instead of a conditional spread, so every NON-crew round's archive
  and state carried an explicit `crewId: undefined` key. DynamoDB's `marshall()` (this repo
  never sets `removeUndefinedValues`) threw on that key in `putArchive`, 500ing a non-crew
  round's first finalize live on beta — and the idempotent retry then false-200'd without ever
  persisting the archive, silently stranding the round from the projector and any later
  rebuild. `pnpm e2e:beta`'s own T4 gate caught the live 500 before it shipped further; the fix
  (conditional spreads, matching `startRound.ts`'s own idiom, pinned at the type level too since
  `toBeUndefined()` can't distinguish an explicit `undefined` key from an absent one) landed and
  redeployed the SAME task, then `pnpm e2e:beta` reconfirmed 16/16. Two `UPDATE_COMPLETE`
  deploys in T4, not one: the base crew-routes deploy, then this narrowly-scoped corrective
  redeploy.
- **T5's loading-window defect.** `auth.golfer` is actually three-state — `undefined` while
  signed in means GET /me is still in flight, `null` means signed in with no profile yet, a
  real `GolferView` means as-self — and T5's first pass collapsed `undefined` into the
  "no golfer yet" branch. A submit during that in-flight window fired `PUT /me` with an
  empty/stale free-text value over a profile that might already be real once the fetch landed:
  a silent rename race. Fixed same-task (`70495a9`) with an explicit
  `isIdentityLoading = auth.signedIn && auth.golfer === undefined` branch — a quiet "Loading
  your profile…" placeholder (neither free-text nor "Playing as"), the submit button disabled,
  and the submit handler itself guarding on it too (covers Enter-to-submit).
- **T6's seed-notice defect.** "Play the usual"'s per-game `addGame` seed loop (after the round
  itself is created) caught and dropped a failed game COMPLETELY silently — review finding:
  "exactly wrong for one-tap Saturday, where the golfer is least likely to double-check Setup on
  their own." Fixed same-task (`912f86a`): failed labels (via `describeStandingGame`, never a
  raw server string) carry to `RoundPage` as router state and render a dismissible amber
  `SeedFailureNotice`; navigation to the round still happens regardless (the round already
  exists — stranding the golfer risks a duplicate round on re-submit).

Two plan gaps surfaced during implementation and were resolved, not deferred:
`CrewStore`'s port sketch specified only `put`/`get`/`listByGolfer` with no join-code lookup,
but `POST /crews/join` and every crew read need one and domain's `Crew` type carries no
`joinCode` field — Task 2 added `findByJoinCode` (mirrors `RoundStore`'s own) and moved
`joinCode` to store-level metadata, which is what T3's crew store's own join-code GSI partition
(`crewGsi1pk = "CREW"`, namespaced apart from course search's `"COURSE"` partition on the SAME
gsi1) exists to serve. `GET /crews/{crewId}/records` was never named as its own use case in the
plan (only the route, pointing at the projection-store method `getSeasonRecords` as if that
were the whole thing) — `application/src/crews/getCrewRecords.ts` is the real wrapper
(member-only via `requireCrewMember`, defaults `?season=` to the current UTC year, and treats
"no finalized crew rounds yet" as an empty `{ledger: [], headToHead: []}` rather than a 404).

Task 7's own gate (this task): `apps/web/e2e/crewSeason.spec.ts` (new) plays a full 12-round
crew season entirely over the API (brief: "browser only where the thing gated is UI" — nothing
in crew setup, 12 rounds, the ledger read, rebuild parity, or a mid-season claim is itself a UI
behavior) against a hand-designed, FROZEN deck (`e2e/crewSeasonDeck.ts`): singles Al-Bo
(allowance 1, inconsequential since every course handicap is 0 all season) wins Al rounds 1-5,
halves 6-7, Bo wins 8-12 (season H2H exactly 5W-5L-2H); 4-way skins (Al, Bo, Cy, Dee) halve
holes 1-17 every round (Cy and Dee hold flat par on every one of those holes, which alone ties
the 4-way low regardless of what Al/Bo do) with an outright hole-18 winner rotating
Al,Bo,Cy,Dee,... across the 12 rounds (season skins 54 each, 3 rounds × 18); 4-way stableford
points hand-derived hole-by-hole from that same deck and frozen BEFORE the first live call —
Al/Bo 430, Cy/Dee 435 (task-7-report.md carries the full per-round derivation table). The deck
is verified against the REAL domain engines first (`playGoldenRoundLog` → `settleRound` →
`crewContribution` → `aggregateSeason`, entirely in-process, no network — crewSeason.spec.ts's
own step 1) — this passed on the first attempt, and the first LIVE run against beta also
agreed with the frozen numbers exactly: no BLOCKED trace was ever needed. Rebuild parity
(`invokeRebuild`, M7's own precedent) reproduces the identical ledger; a second throwaway user
claims Bo's stable ghost mid-season and `GET /me/record` shows all 12 history lines in one
claim — crews' whole promise (`Crew ghosts have STABLE GolferIds`, the plan's own fixed
decision) holding end to end. `apps/web/e2e/primaryPath.spec.ts` (new) is the process-law
gate from M7's close (papercuts.md §4): a fresh Cognito user's token is minted via
`USER_PASSWORD_AUTH` and injected (the Hosted UI form is the user's own separate manual smoke),
and EVERY step after that runs through rendered UI, no `*Direct` API substitutions anywhere —
the golfer names themselves once through the real Profile form (the one name entry in the whole
file — CreateRoundPage's "Playing as" line only replaces the free-text field once
`auth.golfer` is a real `GolferView`, so this has to happen before "Start a round" for that
step to show zero typed names, matching the brief's own parenthetical exactly), then Start a
round shows "Playing as `<name>`" with no name field anywhere, 18 holes score on the real grid,
finalize goes through the real confirm dialog, and Profile shows the round's history line
(polled via `page.reload()` inside Playwright's own `toPass`, never a `*Direct` fetch standing
in for the wait). `apps/web/e2e/support.ts` gained the crew + as-self `*Direct` helpers
(`updateMeDirect`, `createCrewDirect`, `addCrewMemberDirect`, `saveStandingGameDirect`,
`getCrewRecordsDirect`, `claimGolferDirect`, `addGameDirect`, `startRoundDirect` widened to
accept `golferId`/`crewId`/`players`/an optional Bearer token) plus a shared `pollUntil` (the
same "poll on shape, assert on content" idiom `identityRecord.spec.ts`'s own `pollRecord`
established, now used by both specs instead of a second hand-rolled copy) and `ensureCourse`
widened to return the seeded course's own `CourseId` (every prior caller only used it for its
side effect, so this is additive).

**Field finding, fixed in the SAME task:** re-running the full suite surfaced a real,
deterministic (not flaky — 2/2 in isolation) failure in `identityRecord.spec.ts` (M7's own
gate, untouched since `29606f5`) at its claim step — "Already claimed by another account,"
even though the claimed golferId was a fresh UUID this run minted. Root cause, confirmed by
reproducing the exact sequence over a raw `fetch` (bypassing the UI) both with and without the
complication: M8's own T5 `CreateRoundPage` (commit `236809c`) made round-creation sensitive to
sign-in state for the FIRST time — ANY signed-in caller typing a free-text name now auto-binds
their account to that name (`PUT /me` then as-self `StartRound`). `identityRecord.spec.ts`
predates that behavior and signs its browser in from `beforeAll`, before round 1's own
creation — so typing "Host1" while already signed in as user A silently consumed user A's
one-account-one-golfer slot on "Host1" instead of leaving it free, and the later claim on ghost
`g` legitimately 409'd (`golfer-already-claimed`) every time, not intermittently. Fixed in the
TEST, not the product (M8's as-self behavior is correct and intended): `injectAuthTokens` moved
out of `beforeAll` into test 3 itself (immediately followed by a `page.reload()`, since
`addInitScript` only takes effect on navigations after it's registered), restoring this gate's
original narrative — Host1 (test 1) is a genuinely separate, anonymous identity from user A,
who signs in only to claim ghost `g`'s history starting at test 3. Confirmed both in isolation
and inside the full six-spec suite afterward.

Gate met: `pnpm e2e:field` green three consecutive runs, 39/39 each time (7 `courseEntry.spec.ts`
+ 7 `crewSeason.spec.ts` + 9 `fieldTest.spec.ts` + 5 termination + 6 `identityRecord.spec.ts` +
5 `primaryPath.spec.ts`), ~2.5-2.7 min per run — logs at
`.superpowers/sdd/m8-e2e-run-{1,2,3}.log` (a fourth, pre-fix run with the single
`identityRecord.spec.ts` failure above is kept too, as the failure evidence).

**Post-gate controller flow-walk finding, fixed in a follow-up commit (W1).** Live-driving the
primary create/join flow as a brand-new sign-up (no automated gate reproduces this — it needs a
real, cold `auth.golfer` in a running browser) surfaced a sibling of T5's loading-window defect
above: `CreateRoundPage`/`JoinRoundPage`'s PUT-/me-first arm calls `updateMe` (minting the
account's golfer) then creates/joins as-self, but never told the `useAuth` context about the
new golfer — `auth.golfer` stayed `null` in memory until a full reload, so the round page's own
roster row for that very golfer failed `ClaimAffordance`'s own-row check and rendered "This is
me" instead of "You" (tapping it then hit the confusing already-claimed 409 copy). Fixed by
calling `auth.refetch()` — the exact re-fetch-on-success seam `ClaimAffordance`'s own claim
success already uses, not a parallel one — right after `updateMe` succeeds in both pages'
submit paths, before navigating to the round.

### M9 — Share & harden

> **Amended 2026-07-11 (owner decision):** prod is out of M9. The app is still rough —
> hardening comes before any new stack exists. Prod deploy, web publish to prod, and the
> v1-bar field Saturday moved to M10 below, which is **user-triggered only**.

**Goal:** share links exist, the hardening ledger below is burned down or explicitly
re-accepted with a dated record, and the app runs from a phone (hosted beta web) — all on
the existing `swng-beta` stack. No new stack is deployed.

**Tasks:**
1. Spectator/share tokens + read-only live round view; shareable archived-card link
   (one URL, live → archived).
2. Backend correctness hardening: finalize archive repair-on-replay, real sub-uniqueness
   (SUB# pointer), claim proof-of-context, crew join-code uniqueness, hosted-session
   sign-out (papercut 6).
3. Hardening: error surfaces, empty states, reconnect edge QA, the web papercut batch,
   basic rate limiting, monitoring/alarms on the beta stack, e2e user teardown.
4. Hosted beta web: S3+CloudFront added to the existing `swng-beta` stack, strict CSP.

**Gate:** all suites green ×3 at close; every ledger item below landed or
re-accepted-with-dated-record; a share link proven by a no-auth browser; controller
flow-walk clean. No field test — casual dogfooding on hosted beta is available but gates
nothing.

### M10 — Ship (user-triggered; not scheduled)

**Goal:** the v1 bar (`roadmap.md`) met on prod. This milestone begins only when the owner
says the app has stopped being a toy — it is never entered by default.

**Tasks:**
1. Prod stack (`swng-prod`) + web publish; prod pool without `USER_PASSWORD_AUTH`;
   anonymous-only prod smoke.
2. Remaining security hardening judged prod-blocking at that time (token-storage redesign,
   share-link revocation, whatever the M9 re-acceptance records say).
3. **Field test against the v1 bar:** a real crew, real course, a real Saturday — zero paper,
   ≤20s/hole, handicaps trusted, ghost fully represented. Fix list burned down; bar re-run.

**Gate:** the four v1-bar bullets verified in the field, not in test.

**M9 hardening ledger (carried forward from M7's own closing review):** every item below was
accepted, deliberately, as beta-grade during M3–M7 — each has an in-code why-comment at the
cited spot, this is just the one consolidated list Task 2 works from.

- **`USER_PASSWORD_AUTH` removal** (`apps/infra-cdk/lib/swngStack.ts`'s `UserPoolClient`): the
  real web app only ever drives authorization-code+PKCE; the password flow exists solely so
  `pnpm e2e:beta`/`e2e:field` can mint a JWT via `InitiateAuth` without a browser. Narrow or
  remove it once the e2e gates have another way to authenticate (a Hosted-UI-driving Playwright
  flow, or a dedicated test-only token-mint endpoint gated off in prod).
- **localStorage token storage** (`apps/web/src/auth/tokenStore.ts`): plaintext Cognito
  tokens (id + refresh) in `localStorage`, no rotation beyond the one-shot 401-triggered
  refresh `useAuth.ts` drives. An XSS on the web app reads them directly. Accepted for beta's
  threat model (no third-party script surface); prod hardening is an httpOnly-cookie session or
  short-lived-token-in-memory-only design.
- **Claim capability = knowledge of the golferId, nothing more** (`claimGolfer.ts` /
  `SetupPanel.tsx`'s `ClaimAffordance`): the only thing standing between "browsing a round" and
  "claiming that ghost's whole history" is the golferId's own secrecy — there's no server-side
  check that the claimant was ever actually IN that round, no OTP/email confirmation, no
  time-boxing. M9 needs a real challenge (e.g. a code the round's other participants can see,
  or a server-checked "was this sub ever a WS/HTTP participant on this round" test) before prod.
  The honest copy this milestone shipped for the 409 arm (`SetupPanel.tsx`: "Your account
  already has a profile — claiming another ghost isn't supported yet" vs. "Already claimed by
  another account.") is a UX mitigation, not a security one — it stops the common accidental
  case (a new user hasn't Saved their own profile yet) from reading as a hack attempt, but does
  nothing about a deliberate golferId-guessing claim.
- **Join-vs-claim race** (`joinRound.ts`, the `boundElsewhere`/`existing?.sub` check): a claim
  can land between `joinRound`'s golferStore read and its `participant-joined` append, letting a
  golferId get joined into a round moments after being claimed elsewhere. Narrow window, needs
  advance knowledge of the golferId mid-claim, and grants nothing beyond what an unclaimed
  ghost's participant token already carries (M4: ghost tokens carry no auth) — accepted, not
  revisited until identity hardening needs the same claim-atomicity work anyway.
- **`GolferStore.put` can silently drop a `sub`** (`createDynamoGolferStore.ts`): `put`'s `sub`
  field is a plain overwrite, not conditional or merged — a caller that reconstructs a `Golfer`
  without re-passing `found.sub` clears the claim on save. Every real call site today
  (`updateMyGolfer.ts`) re-passes it correctly, so this is a discipline invariant, not a
  structural one; M9 should either make `put` sub-preserving by default or add a lint/test that
  pins every call site.
- **gsi2 eventual-consistency duplicate-golfer window** (`getOrCreateGolfer`,
  `getMyGolfer.ts`): sub-uniqueness is enforced by querying gsi2 (`getBySub`), and GSIs are
  never strongly consistent — two near-simultaneous first-ever PUT /me calls for the same sub
  can both read "no existing golfer" and each mint and `put` its own fresh golferId, landing
  two separate golfer rows bound to one sub. Design note for M9: a base-table `SUB#<sub>`
  pointer item (consistent-readable, created via a real conditional `put`) would make
  sub-uniqueness a true invariant instead of a race that merely self-heals on the next GET /me
  picking one winner.
- **Projector staleness — per-shard, not per-golfer, serialization** (`projectArchive.ts`):
  DynamoDB Streams order per shard, and shards partition by round, not golfer — two rounds
  finalizing near-simultaneously that share a participant can land on different shards and race
  `projectArchive`'s `listHistory` → `computeIndexDetail` → `putIndex` sequence, momentarily
  storing an index short one differential. Self-heals on that golfer's next finalize or a
  `rebuildProjections` pass. The crew season ledger shares the identical shape: `putCrewRound`
  → `listCrewRounds` → `putSeasonRecords` (same file) is a read-modify-write over the whole
  `(crewId, season)` bucket, last-writer-wins under two near-simultaneous finalizes for the
  same crew/season — same self-heal path (next finalize or rebuild).
- **Rebuild-vs-live-finalize wipe window** (`rebuildProjections.ts`): the manual rebuild's
  archive Scan (`createDynamoArchiveSource`) necessarily predates its own wipe step; a round
  that finalizes (and runs the live stream-triggered `projectArchive`) after the Scan but before
  the wipe has its fresh projection wiped and never restored by that same rebuild run. Operator
  note: don't invoke `RebuildFunction` while rounds are actively finalizing, or just invoke it
  again.
- **Non-atomic `putHistoryLine` upsert** (`projectArchive.ts`'s `putHistoryLine` +
  `listHistory` + `putIndex` sequence): three separate writes/reads per golfer per finalize, no
  transaction across them. A crash or throw between them leaves a history line posted without
  an updated index (the real race M7's own `identityRecord.spec.ts` gate first caught, fixed in
  the test's poll condition, not the product). Acceptable for a projection (rebuild is the
  general-purpose repair path); would need real atomicity if projections ever became a source
  of truth.
- **`RebuildFunction`'s global full-table replay** (`packages/lambda/src/entries/rebuild.ts`):
  no pagination or partial-range replay — every invocation Scans and replays every archive in
  the table, unconditionally. Fine at today's "a few thousand events across an afternoon" scale
  (`architecture.md` §3); as the archive count grows this eventually blows the Lambda's memory
  (materializing every archive in one array) and its 5-minute timeout before hardening does.
  M9 should add either incremental/windowed rebuild or a streaming (non-materializing) pass.
- **Throwaway e2e Cognito users/data accretion on beta**: `identityRecord.spec.ts`'s
  `mintThrowawayUser` (`AdminCreateUser`/`AdminSetUserPassword`) and its own throwaway courses
  (`Identity Record Course ${Date.now()}`) are never deleted after the run — every `e2e:beta`/
  `e2e:field` invocation leaves permanent rows in the beta User Pool and courses table. Fine for
  now (beta is disposable, not prod), but unbounded over the project's lifetime; M9 should add
  teardown (`AdminDeleteUser` in an `afterAll`, or a periodic beta-only sweep) before beta data
  volume itself becomes a hardening concern.
- **Finalize false-200 on a `putArchive` failure** (`finalizeRound.ts`): the `round-finalized`
  event append and the archive write (`deps.store.putArchive`) are two separate calls, not one
  transaction. If `putArchive` throws after the event has already landed, the round is now
  final-but-archiveless — and the idempotent-replay branch this same function takes on retry
  (`state.status === "final"` → recompute from the log and return, no `putArchive` call) means
  that retry returns 200 without ever repairing the missing archive row, or the projections a
  stream trigger off that write would have produced. Observed live during M8 Task 4: two
  throwaway rounds wedged on beta this exact way. M9 needs either a single-transaction
  append+archive write, or the idempotent-replay branch to re-attempt `putArchive` when the
  archive is found missing.
- **Cross-season re-finalize strands the old season's crew contribution + RECORDS**
  (`createDynamoProjectionStore.ts`'s `putCrewRound` dedupe and `rebuildProjections.ts`'s
  `touchedCrewSeasons`): both are scoped to `(crewId, season)` — a reopen-and-refinalize whose
  new `finalizedAtMs` lands in a different UTC year (season = `seasonOf(finalizedAtMs)`,
  `projectArchive.ts`) never finds, and so never deletes, the OLD season's `CrewRoundEntry`; it
  strands there forever, and a full rebuild can't reach it either (`touchedCrewSeasons` is
  collected from the CURRENT archive set the same season-scoped way, so it never re-wipes a
  season nothing currently finalizes into). Unreachable in v1 (nothing reopens a finalized
  round yet); latent once something does. See `createDynamoProjectionStore.ts`'s `putCrewRound`
  comment for the corrected (non-claiming-it's-handled) version of this note.
- **Crew join codes: permanent, no uniqueness condition, arbitrary winner on collision**
  (`createCrew.ts`'s `deps.ids.newJoinCode()` + `createDynamoCrewStore.ts`'s `put`/
  `findByJoinCode`): unlike a round's own join code (scoped to that round's lifetime), a crew's
  join code is permanent — minted once at creation with no conditional check against an
  existing code, and `findByJoinCode`'s `Limit:1` GSI query would silently resolve to whichever
  of two colliding crews the (eventually-consistent) index happens to return first. A
  consent-boundary miss more than a correctness one (whoever holds a stale or leaked code can
  join that crew forever) — negligible at the join-code alphabet's real collision odds today,
  but accumulates as the crew count grows.
- **Triaged-M9 web/UX papercuts** (full detail in the M8 close-out review, not reproduced
  here): `startRound`'s `players[]` roster has no duplicate-golfer guard; the `parseSeason`
  family parses an empty string as if it were a real season (`Number("")` is 0, an integer, so
  `?season=` resolves to season 0 instead of the current-year default); `AddPlayerForm` wipes
  its tee/course-handicap fields back to defaults after every successful add, so seating
  several same-tee players means retyping the tee each time; `onAddGame` is missing a
  post-call sync on one outlier path; "play the usual" hides itself rather than showing
  disabled-with-an-explainer when the crew has no saved preset; a signed-in golfer's own
  roster row transiently shows the "This is me" claim affordance while identity is still
  loading (`auth.golfer` undefined skips the "You" branch); `SeedFailureNotice` can render on
  a round that's already landed final; `saveStandingGame` doesn't validate a preset's
  golferIds against the current roster; crew names aren't validated in the domain layer the
  way member names are (a whitespace-only crew name persists — contrast fix #1 above);
  `addCrewMember` can leave an orphaned ghost row if the crew write retries out after the
  golfer row is already created; departed-member ledger lines render a truncated raw golferId
  instead of "Former member" copy.

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
