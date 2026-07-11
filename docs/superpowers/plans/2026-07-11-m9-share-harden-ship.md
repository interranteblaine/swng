# M9 — Finish Line: Share, Harden, Ship — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the v1 bar (`roadmap.md`) met on prod — spectator/share links, the hardening ledger triaged and burned down, `swng-prod` live with hosted web, and the four v1-bar bullets verified on a real Saturday with a real crew.

**Architecture:** share links are read-only spectator tokens over the existing round channel (`architecture.md` §"Identity & access" — same HMAC mechanism as participant tokens, narrower capability). Hardening follows the consolidated M9 ledger (`implementation-plan.md` §M9) — each item lands, or is explicitly re-accepted with its ledger entry updated; nothing silently drops. Prod is a second `SwngStack` stage plus S3+CloudFront web hosting in the same stack (both stages get hosting — the field test needs phones on a course, not a laptop dev server).

**Tech stack:** unchanged, plus `aws-cdk-lib` constructs already in use (CloudFront/S3 are new *resources*, not new tools).

## Global Constraints

- Work on `main`; `pnpm validate` green at every commit (hermetic — no network/AWS); TDD; comments why-only; conventions per `docs/engineering-conventions.md`; every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Layer law (lint-enforced): web imports `client|contracts|domain` only; domain pure/zero-deps; `aws-jwt-verify` in `adapters-cognito` ONLY; ONE dispatcher, ONE error-mapping module, ONE projector implementation.
- **Deploy policy:** beta deploys are per-task as planned below (each ends `pnpm deploy:beta` + `pnpm e2e:beta` 16/16 ×2 — M9 is a hardening milestone; multiple beta deploys are the point, each gated). The **prod stack (`swng-prod`) is created only in Task 6** via a new `deploy:prod` script (profile `swng`, us-east-1). POC stacks `InfraCdkStack-*` are NEVER touched (constructor guard stays). `cdk destroy` is never run against anything.
- **Prod data policy ⚑:** prod smoke tests are anonymous-flow only (round lifecycle, course read, share link) and leave at most one clearly-named smoke round; NO Cognito automation against the prod pool ever (no admin-create, no USER_PASSWORD_AUTH — it isn't enabled there). The first real prod account is the project owner's own sign-up.
- **Process law (papercuts §4):** gates include the unmodified primary path in a real browser; the controller personally flow-walks before close; gate runs capture full output to a file (never piped through head/tail).
- **Design decisions fixed by this plan** (⚑ = flagged for user veto at plan review; silence = consent):
  - **⚑ Claim challenge = proof of context.** `ClaimGolferRequest` gains a required `code` — a round join code whose round contains the golfer, or a crew join code whose crew has the golfer as a member. The server verifies membership; a bare golferId no longer claims anything (403 `claim-proof-required`). The web supplies the code automatically (claiming from a round page sends that round's join code; from a crew page, the crew's) — zero added friction in every real flow. This closes the ledger's "claim capability = golferId secrecy" item without OTP/email machinery.
  - **⚑ localStorage tokens are RE-ACCEPTED for v1 ship**, with a strict CSP added at the CloudFront layer as mitigation (no third-party script surface exists). The httpOnly-cookie session redesign is post-v1; the ledger entry is updated to say so dated, not deleted.
  - **⚑ USER_PASSWORD_AUTH exists on the beta pool only, forever.** The prod pool never enables it; e2e suites keep running against beta unchanged. Prod verification of the signed-in path is the owner's manual smoke (prod data policy above).
  - **⚑ Share link semantics:** one capability URL per round — `/watch/{roundId}#<spectatorToken>` (token in the URL fragment so it never hits server logs). Deterministically derived (HMAC over `roundId` + scope `"spectator"`, same signing machinery as participant tokens) so every participant shares the SAME link; no storage, no revocation in v1 (revocation = the ledger gets a post-v1 line). The link shows the live round while live and the archived card after finalize — it never dies.
  - **⚑ Web is served from the CloudFront default domain for v1** (`https://dxxxx.cloudfront.net`). A custom domain is a one-line follow-up iff the user provides one; nothing in v1 waits for it.
  - **⚑ Alarm notifications** go to an SNS topic subscribed by `interrante.blaine@gmail.com` (confirm-or-veto the address).
  - **Finalize false-200 fix = repair-on-replay**, not a mega-transaction: the idempotent `status === "final"` branch in `finalizeRound.ts` checks the archive exists and re-attempts `putArchive` when missing. Retrying a wedged finalize now heals it. (The two wedged M8 throwaway rounds on beta stay as-is — throwaway.)
  - **Sub-uniqueness becomes a real invariant:** a base-table `SUB#<sub>` pointer item on `core` (pk `SUB#<sub>`, sk `"SUB"`, attrs `{golferId}`), written with `attribute_not_exists(pk)` at first bind (PUT /me lazy-create AND claim); `getBySub` reads the pointer with a consistent read then the golfer row. gsi2 `SUB#` entries keep being written (rollback safety) but nothing reads them anymore. `GolferStore.put` becomes sub-preserving: it refuses to clear an existing bound sub (throws `sub-drop-forbidden` — a programmer-error guard, mapped 500 deliberately).
  - **Crew join codes get a uniqueness condition at mint:** `createCrew` retries `newJoinCode()` while `findByJoinCode` hits (bounded, 5 attempts → `join-code-exhausted` 500); the ledger entry closes.
  - **Deferred-with-record ⚑ (re-accepted, ledger entries updated in place, NOT silently):** projector per-shard staleness + crew RECORDS LWW (self-heal + rebuild path stands); join-vs-claim race; rebuild-vs-live-finalize wipe window (operator note stands); non-atomic putHistoryLine; cross-season re-finalize stranding (unreachable in v1); rebuild global replay — deferred but ALARMED (Task 5 adds a duration/error alarm on `RebuildFunction` so "eventually blows up" becomes a page, not a surprise).
  - **The field test (Task 7) is user-run and the milestone stays open across it.** The gate is the roadmap's four v1-bar bullets observed on a real Saturday; the controller cannot close M9 alone. The plan structures the checklist, the findings ledger, and the burn-down loop; the user schedules the Saturday.

## File Structure

```
packages/application/src/rounds/finalizeRound.ts                 # T1: repair-on-replay
packages/application/src/ports/golferStore.ts + adapters-dynamodb # T1: SUB# pointer, sub-preserving put
packages/application/src/crews/createCrew.ts                     # T1: join-code uniqueness retry
packages/contracts/src/golfers.ts + application/golfers/claimGolfer.ts  # T2: claim proof-of-context
packages/lambda (routes: logout URLs are CDK), apps/web/src/auth  # T2: /logout redirect sign-out
packages/{contracts,application,lambda}/... spectator token + round-read tier  # T3
apps/web/src/watch/WatchPage.tsx + share affordance               # T3
apps/web/src/... (papercut batch)                                 # T4
apps/infra-cdk (throttling, alarms, SNS) + e2e teardown           # T5
apps/infra-cdk (prod stage, S3+CloudFront both stages, CSP) + scripts/publishWeb.mjs  # T6
apps/web/e2e/prodSmoke.spec.ts (anon-only) + field-test checklist + docs  # T7
```

---

### Task 1: Backend correctness hardening (beta deploy #1)

**Files:** modify `packages/application/src/rounds/finalizeRound.ts`, `ports/golferStore.ts`, `golfers/{getMyGolfer,updateMyGolfer,claimGolfer}.ts`, `crews/createCrew.ts`, `packages/adapters-dynamodb/src/createDynamoGolferStore.ts`, `keys.ts` (+unit & contract tests); `packages/application/src/testing/fakes.ts`.

**Interfaces (produced):**

```ts
// finalizeRound.ts — the idempotent branch (status === "final") gains:
//   const archived = await deps.store.getArchive(roundId);
//   if (!archived) await deps.store.putArchive(settleRound(...));   // repair the wedge
// RoundStore port gains getArchive(roundId): Promise<RoundArchive | undefined> if absent —
// check the port first; an archive reader may already exist (projections/rebuild path).
// INVARIANT: a finalize retry NEVER returns 200 while the archive row is missing.
// Test: fake store whose putArchive throws once → first finalize throws; retry heals:
// archive present after second call, events identical, no duplicate round-finalized.

// GolferStore port:
put(golfer, opts): now REFUSES to unbind — implementations throw ApplicationError("sub-drop-forbidden")
  when the stored row has a sub and the incoming golfer would clear it. (Deliberate 500: programmer error.)
bindSub(golferId, sub): NEW — atomically writes the SUB#<sub> pointer item
  (attribute_not_exists(pk)) AND sets sub on the golfer row (TransactWriteItems);
  condition failure → ApplicationError("golfer-already-claimed") for claim,
  or return the existing binding for get-or-create (read pointer, return that golfer).
getBySub(sub): reads SUB# pointer (ConsistentRead) → golfer row; gsi2 no longer read.
// Contract tests: two concurrent bindSub for one sub → exactly one wins (allSettled, real
// clients — mirror the M7 claim-race construction); pointer + row always consistent;
// put with dropped sub throws; getBySub via pointer only (delete the gsi2 entry in the
// test fixture and getBySub must still work — pins that gsi2 is dead as a read path).

// createCrew.ts: mint loop — up to 5 newJoinCode() attempts, skipping codes where
// crewStore.findByJoinCode resolves; exhaustion → ApplicationError("join-code-exhausted").
// Test over fakes: fake store pre-seeded with 4 colliding codes → 5th mints; 5 collisions → throws.
```

- [ ] **Step 1 (RED):** the tests above (application over fakes; dynamo contract tests for bindSub race + pointer reads + sub-preserving put).
- [ ] **Step 2 (GREEN):** implement; existing suites green unchanged (claim/PUT-me behavior changes only where specified).
- [ ] **Step 3:** `pnpm validate` + `pnpm test:contract` ×2; commit `fix(application,adapters-dynamodb): finalize heals its archive on retry; sub binding is a real invariant; crew codes mint unique`.
- [ ] **Step 4 (deploy #1):** cdk diff (lambda code only — the SUB# pointer is items, not schema), `pnpm deploy:beta`, `pnpm e2e:beta` ×2 (16/16), live smokes: PUT /me twice-idempotent; a finalize wedge cannot be reproduced (score+finalize a throwaway round, verify archive via /me/record). This deploy also takes the M8 close-out's undeployed `4baa04a` fixes live (invalid-member-name 400, players cap) — smoke the 400 arm live. Paste outputs.

---

### Task 2: Identity hardening — claim proof-of-context, real sign-out (beta deploy #2)

**Files:** modify `packages/contracts/src/golfers.ts`, `packages/application/src/golfers/claimGolfer.ts` (+deps: roundStore/crewStore lookups), `packages/lambda` composition, `apps/web/src/round/ClaimAffordance.tsx`, `apps/web/src/auth/useAuth.ts` (+tests), `apps/infra-cdk/lib/swngStack.ts` (logoutUrls).

**Wire/behavior contracts:**

```ts
// ClaimGolferRequest = { golferId, name?, code }   // code REQUIRED (min 1). .strict().
// claimGolfer resolution: code → try round join code (round contains golferId as participant)
//   → else crew join code (crew has golferId as member) → else 403 "claim-proof-required".
// The two existing 409 arms are UNCHANGED and checked AFTER proof (proof failures must not
// leak whether a golfer is claimed). Order pinned by test.
// Web: ClaimAffordance on a round page sends that round's join code (it's in the session
// state); CrewPage roster rows (if any claim affordance exists there) send the crew's code.
// The 403 arm gets honest copy: "This claim needs a round or crew code that includes this
// player." (never raw server text).
```

- **Sign-out via Cognito `/logout` (papercut 6):** `swngStack.ts` `UserPoolClient.logoutUrls` gains `${origin}/` for each registered origin; `useAuth.signOut()` clears local tokens then redirects to `${HOSTED_UI_DOMAIN}/logout?client_id=...&logout_uri=<origin>/`. Component test: signOut clears tokens AND navigates to the /logout URL (assert the URL shape; the redirect itself is a window.location seam — mock it the way the PKCE redirect already is).
- [ ] **Step 1 (RED):** application tests (all proof arms: round-code proof, crew-code proof, wrong-code 403, proof-before-409 ordering, name-on-lazy-create still works); web tests (affordance sends code; 403 copy; signOut redirect).
- [ ] **Step 2 (GREEN):** implement; `pnpm validate`.
- [ ] **Step 3:** commit `feat(golfers,web): claiming requires proof of context; sign-out ends the hosted session`.
- [ ] **Step 4 (deploy #2):** cdk diff (lambda + UserPoolClient logoutUrls — NO pool replacement; the client updates in place, id unchanged, per the M7 callback-URL precedent), deploy, e2e:beta ×2. Live smokes: claim with round code (200), claim with garbage code (403 `claim-proof-required`), hosted /logout redirect round-trip (curl -I the logout URL → 302). NOTE: `identityRecord.spec.ts` + `crewSeason.spec.ts` claim steps must be updated in THIS task (they now need codes — both have them in hand from the rounds/crews they create); `pnpm e2e:field` ×1 green before the commit.

---

### Task 3: Share — spectator tokens, the watch page, the immortal link (beta deploy #3)

**Files:** modify `packages/adapters-apigateway` (or wherever participant HMAC tokens are minted/verified — find `roundToken`/HMAC in the codebase and extend THAT module: same mechanism, narrower capability, per `architecture.md`), `packages/contracts/src/round.ts`, `packages/application/src/rounds/getShareLink.ts` (new), `packages/lambda/src/http/{routes,dispatch}.ts` (+`ws` subscribe path), `apps/web/src/App.tsx`, `apps/web/src/watch/WatchPage.tsx` (new), share affordance in `RoundPage.tsx`/`ResultsView.tsx` (+tests), `apps/web/e2e/shareLink.spec.ts` (new).

**Contracts:**

```ts
// Token: scope "spectator" baked into the signed payload alongside roundId (the participant
// token's exact signing machinery, one new scope value — ONE implementation, no parallel signer).
// POST /rounds/{roundId}/share  (participant auth) → 200 { url }   // deterministic: same round → same link
// Dispatcher gains auth: "round-read": accepts participant OR spectator tokens for the
//   read-only routes (GET events / snapshot); WRITE routes stay participant-only — a
//   spectator token presented to recordScore/addGame/finalize/players → 403 "read-only-token"
//   (REAL code, mapped, tested per route class).
// WS: $connect accepts spectator tokens for subscribe; any inbound message with a spectator
//   token → closed/ignored per the existing protocol shape (find how sends are authed; pin it).
// Web /watch/{roundId}#<token>: reads token from location.hash (never a query param — fragments
//   stay out of access logs), fetches snapshot+events read-only, renders the scorecard grid +
//   game standings (reuse presentational components; NO session/outbox — a lean poll+WS view),
//   flips to the archived card (ResultsView) when status is final. No sign-in, no chrome that
//   invites edits. Share affordance: "Share round" button on RoundPage + ResultsView copies the
//   /watch URL (navigator.clipboard, with a visible fallback of the raw URL).
```

- [ ] **Step 1 (RED):** token-scope unit tests (spectator verifies for reads, rejected for writes — every write route class); dispatch tests for `round-read` arms; getShareLink determinism; WatchPage component tests (live render from fake events; final → archived card; write affordances absent structurally — assert NO score buttons render).
- [ ] **Step 2 (GREEN):** implement; `pnpm validate`.
- [ ] **Step 3:** `apps/web/e2e/shareLink.spec.ts` — participant creates+scores a round via API, spectator opens the /watch link in a REAL browser with NO auth: sees live scores appear (WS or poll), sees finalize flip to the archived card; asserts a spectator-token write attempt over HTTP gets 403. `pnpm e2e:field` ×1 (all specs incl. new).
- [ ] **Step 4 (deploy #3):** cdk diff, deploy, e2e:beta ×2 + the shareLink spec against beta. Commit `feat(share): the round has a link — read-only spectators, live to archived, one URL forever`.

---

### Task 4: Web hardening — the papercut batch, error/empty surfaces, reconnect QA

**Files:** `apps/web/src/...` per papercut (each named below); `apps/web/e2e/killNetwork.spec.ts` (or the existing offline spec — extend); component tests per fix.

The batch (each gets its own test; one commit for the batch is fine):
1. `startRound`/CreateRoundPage `players[]`: duplicate-golfer guard (same golferId twice, or matching the host) → inline validation, button disabled with copy.
2. `parseSeason` family (`routes.ts` — lambda, small backend rider): empty-string query values parse as absent, not 0 — fix the shared idiom in ONE place, all three parsers pinned. (Rides Task 5's deploy.)
3. AddPlayerForm keeps tee/CH across adds (reset name/selection only).
4. `onAddGame` gains the same post-call `session.sync()` the other mutations have.
5. "Play the usual" renders disabled-with-explainer ("Save a standing game first") when the crew has no preset.
6. Transient self-row: while identity loads, roster rows render NO claim affordance (instead of "This is me" on what may be your own row).
7. `SeedFailureNotice` suppressed when the round is already final on landing.
8. `saveStandingGame` (application, rider on T5 deploy): preset golferIds validated ⊆ roster → 400 `unknown-preset-player`.
9. Domain crew-name validation (trimmed, 1–60 chars — mirror `validateCourseName`); wire `.min(1)` unchanged (domain is the honest layer).
10. `addCrewMember` orphan ghost: create the golfer row AFTER the crew write succeeds, or why-comment the accepted orphan — decide by reading the retry structure; explain in the report.
11. Departed-member ledger lines render "Former member" + truncated id as the secondary line.
12. Empty/error surfaces sweep: crew records fetch failure shows one quiet line (not a bare heading); profile/crews/home loading and empty states audited (list every surface checked in the report; no raw `caught.message` anywhere — grep-pinned like M7).
- [ ] **Step 1 (RED→GREEN):** per-papercut tests; `pnpm -F @swng/web test` ×2; `pnpm validate`.
- [ ] **Step 2 (reconnect QA):** extend the kill-network e2e: WS dropped mid-scoring then restored (scores converge, no dupes); offline through finalize attempt (queued, honest chrome) then online finalize; token expiring mid-round (401 → one-shot refresh path exercised — force with a short-lived token if the harness allows, else document why not reachable in e2e and cover the refresh at component level).
- [ ] **Step 3:** `pnpm e2e:field` ×2 green; commit `fix(web,application): the M9 papercut batch — twenty seconds a hole with no sharp edges`.

---

### Task 5: Ops — throttling, alarms, teardown (beta deploy #4)

**Files:** `apps/infra-cdk/lib/swngStack.ts` (+tests), `apps/web/e2e/support.ts` (teardown), lambda `routes.ts` parseSeason fix + `saveStandingGame` validation ride along (from T4 riders).

- **Throttling:** HTTP API stage default throttle (rate 50 rps / burst 100) + tighter per-route throttle on the anonymous-reachable routes (`POST /rounds`, `/rounds/join`, `/rounds/peek`, the 5 course routes): rate 5 / burst 10. Why-comment the numbers (a Saturday crew is ~1 rps; these caps are abuse ceilings, not capacity planning). CDK assertions test pins them.
- **Alarms (all → one SNS topic, email subscription ⚑):** per-function Errors ≥ 1 (5-min) for the three entries + projector + rebuild; HTTP API 5xx ≥ 5 (5-min); projector stream IteratorAge > 5 min; rebuild Duration > 4 min (the 5-min-timeout tripwire — the ledger's deferred windowed-rebuild gets its page); DynamoDB throttled-requests ≥ 1 on all four tables. CDK assertions test pins alarm count + topic wiring.
- **e2e teardown:** `mintThrowawayUser` gains `afterAll` `AdminDeleteUser` (best-effort, never fails the suite); course/round/crew data accretion stays accepted (rows are inert; ledger entry updated to say users are now cleaned, data rows aren't).
- [ ] **Step 1:** CDK assertion tests RED→GREEN; teardown wired; `pnpm validate` + infra tests.
- [ ] **Step 2 (deploy #4):** cdk diff (throttle settings, alarms, SNS — no table/pool changes), deploy, e2e:beta ×2, e2e:field ×1 (proves teardown doesn't break minting), confirm the SNS subscription email arrives (user clicks confirm — note it in the report as a user action).
- [ ] **Step 3:** commit `feat(infra): rate ceilings, alarms that page, and e2e users that clean up`.

---

### Task 6: Prod — the second stage, hosted web on both stages, CSP (prod deploy #1)

**Files:** `apps/infra-cdk/{bin,lib}` (stage-parameterized: `swng-beta` + `swng-prod`), S3+CloudFront (OAC, SPA fallback 403/404→`/index.html`, ResponseHeadersPolicy with strict CSP ⚑ per the localStorage acceptance), `scripts/publishWeb.mjs` (builds `apps/web` with the stage's env from stack outputs, `aws s3 sync`, CloudFront invalidation), root `package.json` (`publish:web:beta`, `deploy:prod`, `publish:web:prod`), Cognito callback/logout URLs per stage origin (localhost STAYS on beta's client for dev; prod's client gets ONLY the prod CloudFront origin), `apps/web/e2e` config pointing at hosted beta where useful.

- **Constraints:** `SwngStack` prod stage: same shape as beta; prod pool has NO `USER_PASSWORD_AUTH`; RemovalPolicy RETAIN on stateful resources (pool + tables) both stages (verify beta already does; pin with a CDK assertion). The `InfraCdkStack-*` constructor guard stays and gains a test if it lacks one.
- **CSP (why-commented in the stack):** `default-src 'self'; connect-src 'self' <http-api> <ws-api> <cognito-domain>; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` — Tailwind needs style inline; NO third-party script origin exists, which is the localStorage acceptance's load-bearing fact.
- [ ] **Step 1:** CDK refactor to two stages + hosting constructs, assertion tests (stage names, no USER_PASSWORD_AUTH on prod client, CSP header present, SPA fallback, RETAIN policies); `pnpm validate`.
- [ ] **Step 2:** `pnpm deploy:beta` (adds hosting to beta) + `publish:web:beta` → hosted beta web live; run `pnpm e2e:field` ×1 against LOCAL dev server (unchanged default) AND one manual controller browser pass against the hosted beta URL (sign-in loop must work → beta callback URLs updated to include the CloudFront origin).
- [ ] **Step 3:** `pnpm deploy:prod` (creates `swng-prod` — expect CREATE_COMPLETE, paste the resource summary) + `publish:web:prod`.
- [ ] **Step 4:** commit `feat(infra,web): swng ships — prod stage, hosted web on both stages, CSP`.

---

### Task 7: Prod smoke, the field-test kit, docs — and the user's Saturday

**Files:** `apps/web/e2e/prodSmoke.spec.ts` (new, anon-only, runs via a new `pnpm e2e:prod` — NEVER in validate/CI); `docs/field-test.md` (new: the checklist + findings ledger template); docs updates (`implementation-plan.md` M9 as-executed, `CLAUDE.md`, `papercuts.md` item 6 closed, ledger entries updated per the deferred-with-record list).

- **prodSmoke.spec.ts (anon-only, per the prod data policy):** create round via UI on the prod web URL → score 3 holes → share link opens read-only in a second context → finalize → archived card on the share link; course search returns the seeded course (the spec seeds ONE course named "swng smoke course" once, idempotently — the single permitted prod artifact besides the smoke rounds). No Cognito anywhere.
- **Controller close-out (code-side):** `pnpm validate`; `pnpm e2e:beta` ×2; `pnpm e2e:field` ×3 consecutive (full output captured); `pnpm e2e:prod` ×2; controller flow-walk on the HOSTED beta web (primary path, play-the-usual, share link on a phone-sized viewport, claim-with-proof) and an anon walk on prod.
- **The user's part (the milestone gate — cannot be closed by the controller):**
  1. Prod sign-up smoke: fresh Hosted-UI account on the prod URL, play as yourself, record updates. (First real prod account.)
  2. **The Saturday:** real crew, real course, standing game, phones only. `docs/field-test.md`'s checklist rides along: zero paper? ≤20s/hole (time three holes)? handicaps trusted (did the first-tee negotiation end)? ghost fully represented (the non-app member sees their name in the card and ledger)?
  3. Findings land in `docs/field-test.md`'s ledger table; the controller runs a burn-down wave (subagent-driven, same review discipline); bar re-run the following Saturday if any bullet failed.
- [ ] **Step 1:** prodSmoke spec + field-test kit + docs; `pnpm validate`; commit `feat(e2e,docs): prod smoke and the field-test kit — the v1 bar goes outdoors`.
- [ ] **Step 2:** controller close-out runs (above) — all green, outputs captured.
- [ ] **Step 3:** hand the Saturday to the user. M9 (and v1) closes when the four bullets hold in the field, findings burned down.

---

**M9 gate (from `docs/implementation-plan.md`):** "the four v1-bar bullets verified in the field, not in test." As specified: Tasks 1–6 land the machinery with per-task beta gates; Task 7 stages the field test; the USER's real Saturday is the gate; findings → burn-down → re-run until the bullets hold.
