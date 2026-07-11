# M9 — Share & Harden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Scope amendment (2026-07-11, user decision):** prod is OUT of M9 — no new stack is
> deployed, period. The application is explicitly still rough; M9's job is to make it less
> rough. The prod stack, web publish to prod, prod smoke, and the v1-bar field Saturday all
> move to a future, **user-triggered** ship milestone (M10 in `implementation-plan.md`),
> which happens when the owner says the app has stopped being a toy — not before.

**Goal:** share links exist, the hardening ledger is burned down or explicitly re-accepted, and the app runs from a phone without a laptop — all on the existing beta stack.

**Architecture:** share links are read-only spectator tokens over the existing round channel (`architecture.md` §"Identity & access" — same HMAC mechanism as participant tokens, narrower capability). Hardening follows the consolidated M9 ledger (`implementation-plan.md` §M9) — each item lands, or is explicitly re-accepted with its ledger entry updated; nothing silently drops. Web hosting (S3+CloudFront) is added to the EXISTING `swng-beta` stack — a resource addition, not a new stack.

**Tech stack:** unchanged, plus CloudFront/S3 constructs from the `aws-cdk-lib` already in use (new *resources* on the existing stack, not new tools).

## Global Constraints

- Work on `main`; `pnpm validate` green at every commit (hermetic — no network/AWS); TDD; comments why-only; conventions per `docs/engineering-conventions.md`; every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Layer law (lint-enforced): web imports `client|contracts|domain` only; domain pure/zero-deps; `aws-jwt-verify` in `adapters-cognito` ONLY; ONE dispatcher, ONE error-mapping module, ONE projector implementation.
- **Deploy policy:** `pnpm deploy:beta` ONLY, targeting the existing `swng-beta` stack — beta deploys are per-task as planned below (each ends `pnpm deploy:beta` + `pnpm e2e:beta` 16/16 ×2). **NO new stack of any name is created, deployed, or synthesized against a real account.** POC stacks `InfraCdkStack-*` are NEVER touched (constructor guard stays). `cdk destroy` is never run against anything.
- **Process law (papercuts §4):** gates include the unmodified primary path in a real browser; the controller personally flow-walks before close; gate runs capture full output to a file (never piped through head/tail).
- **Design decisions fixed by this plan** (⚑ = flagged for user veto at plan review; silence = consent):
  - **⚑ Claim challenge = proof of context.** `ClaimGolferRequest` gains a required `code` — a round join code whose round contains the golfer, or a crew join code whose crew has the golfer as a member. The server verifies membership; a bare golferId no longer claims anything (403 `claim-proof-required`). The web supplies the code automatically (claiming from a round page sends that round's join code; from a crew page, the crew's) — zero added friction in every real flow. This closes the ledger's "claim capability = golferId secrecy" item.
  - **⚑ localStorage tokens are RE-ACCEPTED for now**, with a strict CSP added at the CloudFront layer as mitigation (no third-party script surface exists). The httpOnly-cookie session redesign belongs to the ship milestone; the ledger entry is updated to say so dated, not deleted.
  - **USER_PASSWORD_AUTH stays beta-only, unchanged** — it exists solely so e2e can mint JWTs; there is no prod pool in this plan for it to be absent from. The ledger entry gets the dated note.
  - **⚑ Share link semantics:** one capability URL per round — `/watch/{roundId}#<spectatorToken>` (token in the URL fragment so it never hits server logs). Deterministically derived (HMAC over `roundId` + scope `"spectator"`, same signing machinery as participant tokens) so every participant shares the SAME link; no storage, no revocation for now (revocation = a ledger line for the ship milestone). The link shows the live round while live and the archived card after finalize — it never dies.
  - **⚑ Hosted beta web on the CloudFront default domain** (`https://dxxxx.cloudfront.net`). This is a modification of the existing `swng-beta` stack (bucket + distribution + the Cognito client learning the new origin), NOT a new stack — flagged in case even that is unwanted, in which case Task 6 is dropped entirely and the app remains dev-server-only.
  - **⚑ Alarm notifications** go to an SNS topic subscribed by `interrante.blaine@gmail.com` (confirm-or-veto the address).
  - **Finalize false-200 fix = repair-on-replay**, not a mega-transaction: the idempotent `status === "final"` branch in `finalizeRound.ts` checks the archive exists and re-attempts `putArchive` when missing. Retrying a wedged finalize now heals it. (The two wedged M8 throwaway rounds on beta stay as-is — throwaway.)
  - **Sub-uniqueness becomes a real invariant:** a base-table `SUB#<sub>` pointer item on `core` (pk `SUB#<sub>`, sk `"SUB"`, attrs `{golferId}`), written with `attribute_not_exists(pk)` at first bind (PUT /me lazy-create AND claim); `getBySub` reads the pointer with a consistent read then the golfer row. gsi2 `SUB#` entries keep being written (rollback safety) but nothing reads them anymore. `GolferStore.put` becomes sub-preserving: it refuses to clear an existing bound sub (throws `sub-drop-forbidden` — a programmer-error guard, mapped 500 deliberately).
  - **Crew join codes get a uniqueness condition at mint:** `createCrew` retries `newJoinCode()` while `findByJoinCode` hits (bounded, 5 attempts → `join-code-exhausted` 500); the ledger entry closes.
  - **Deferred-with-record ⚑ (re-accepted, ledger entries updated in place, NOT silently):** projector per-shard staleness + crew RECORDS LWW (self-heal + rebuild path stands); join-vs-claim race; rebuild-vs-live-finalize wipe window (operator note stands); non-atomic putHistoryLine; cross-season re-finalize stranding (unreachable in v1); rebuild global replay — deferred but ALARMED (Task 5 adds a duration/error alarm on `RebuildFunction` so "eventually blows up" becomes a page, not a surprise).
  - **The v1-bar field test is NOT in this milestone.** `docs/field-test.md` (the checklist kit) still gets written in Task 7 so it exists when wanted, but no Saturday is scheduled, no crew is recruited, and M9's gate does not depend on one. Casual dogfooding on the hosted beta URL is available the moment Task 6 lands, entirely at the user's option.

## File Structure

```
packages/application/src/rounds/finalizeRound.ts                 # T1: repair-on-replay
packages/application/src/ports/golferStore.ts + adapters-dynamodb # T1: SUB# pointer, sub-preserving put
packages/application/src/crews/createCrew.ts                     # T1: join-code uniqueness retry
packages/contracts/src/golfers.ts + application/golfers/claimGolfer.ts  # T2: claim proof-of-context
packages/lambda (routes), apps/web/src/auth, infra logoutUrls     # T2: /logout redirect sign-out
packages/{contracts,application,lambda}/... spectator token + round-read tier  # T3
apps/web/src/watch/WatchPage.tsx + share affordance               # T3
apps/web/src/... (papercut batch)                                 # T4
apps/infra-cdk (throttling, alarms, SNS) + e2e teardown           # T5
apps/infra-cdk (S3+CloudFront on swng-beta, CSP) + scripts/publishWeb.mjs  # T6
docs/field-test.md (kit only) + docs as-executed + master-plan M10 amendment  # T7
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

### Task 6: Hosted beta web — S3+CloudFront on the EXISTING stack, CSP (beta deploy #5)

**Files:** `apps/infra-cdk/lib/swngStack.ts` (bucket + CloudFront distribution with OAC, SPA fallback 403/404→`/index.html`, ResponseHeadersPolicy with strict CSP), `scripts/publishWeb.mjs` (builds `apps/web` with beta env from stack outputs, `aws s3 sync`, CloudFront invalidation), root `package.json` (`publish:web:beta`), Cognito client callback/logout URLs gain the CloudFront origin (localhost entries STAY — dev keeps working).

**This modifies `swng-beta` only. No new stack. If the ⚑ flag on hosted beta web is vetoed, this task is DROPPED and Task 7's flow-walk runs against the dev server as before.**

- **CSP (why-commented in the stack):** `default-src 'self'; connect-src 'self' <http-api> <ws-api> <cognito-domain>; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` — Tailwind needs style inline; NO third-party script origin exists, which is the localStorage acceptance's load-bearing fact.
- [ ] **Step 1:** CDK constructs + assertion tests (CSP header present, SPA fallback, OAC, RETAIN on stateful resources pinned, `InfraCdkStack-*` guard gains a test if it lacks one); `pnpm validate`.
- [ ] **Step 2 (deploy #5):** cdk diff (bucket/distribution/client-URL additions ONLY — no table/pool replacement), `pnpm deploy:beta`, `publish:web:beta` → hosted beta web live; `pnpm e2e:beta` ×2; `pnpm e2e:field` ×1 against the LOCAL dev server (unchanged default). Manual controller pass on the hosted URL: sign-in loop (PKCE round-trip on the CloudFront origin), one round create/score, share link on a phone-sized viewport.
- [ ] **Step 3:** commit `feat(infra,web): the app runs from a phone — hosted beta web behind a strict CSP`.

---

### Task 7: Close-out — the field-test kit (shelf-ready, unscheduled), docs, the master-plan amendment

**Files:** `docs/field-test.md` (new: the v1-bar checklist + findings-ledger template — written so it's ready WHEN the user wants it; nothing in M9 schedules it); docs updates (`implementation-plan.md`: M9 as-executed + the M9→M10 split recording the user's no-prod decision; `CLAUDE.md` current-state; `papercuts.md` item 6 closed; every deferred-with-record ledger entry updated in place with its dated re-acceptance).

- **Controller close-out:** `pnpm validate`; `pnpm e2e:beta` ×2; `pnpm e2e:field` ×3 consecutive (full output captured to files); controller flow-walk in a real browser — on the hosted beta URL if Task 6 landed, else the dev server: primary path, play-the-usual, add-a-player, claim-with-proof (round code + crew code arms), share link followed from a second signed-out context, sign-out actually signs out (fresh login form on next sign-in — papercut 6 dead).
- **The user's part (optional, unscheduled):** casual dogfooding on the hosted beta URL whenever desired — solo rounds, a friend, whatever. `docs/field-test.md` sits ready for the day the v1-bar Saturday feels worth running. Neither gates M9.
- [ ] **Step 1:** field-test kit + all docs; `pnpm validate`; commit `docs: M9 as-executed — share and harden; prod and the field Saturday move to a user-triggered M10`.
- [ ] **Step 2:** controller close-out runs (above), all green, outputs captured; report to the user with the hosted URL (if any) and the milestone summary.

---

**M9 gate (amended):** all suites green ×3 at close; every hardening-ledger item either landed or re-accepted-with-dated-record; share links proven end-to-end by a no-auth browser; the controller's flow-walk clean on the six flows above. Prod deployment and the v1-bar field verification are explicitly OUT — they form M10, which only the user triggers.
