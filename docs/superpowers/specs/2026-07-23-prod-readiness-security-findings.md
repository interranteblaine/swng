# swng pre-production security review — findings ledger

Reviewed 2026-07-23 (controller, direct — agent budget exhausted). Read-only audit of the
`swng-beta` surface toward the first prod deployment. Overall: **strong fundamentals** (token
crypto, JWT verification, IAM scoping, error hygiene all done right), with a handful of
real prod gaps — several the code itself flags as "beta-grade, M9 hardens" and never got
hardened.

Severity = {Critical, High, Medium, Low, Info}. "Prod-blocker" = should close before or as
part of cutting the ribbon.

---

## Prod-blockers

### [Medium] TOKEN_SECRET resolves into a plaintext Lambda env var (corrected 2026-07-23 — was over-rated High)
- **Where:** `apps/infra-cdk/lib/swngStack.ts:425` — `TOKEN_SECRET: tokenSecret.secretValue.unsafeUnwrap()`; consumed at `packages/lambda/src/compositionRoot.ts:228`.
- **Correction:** The original finding claimed the plaintext lands in the CloudFormation template / synth artifacts. **Verified false** — the synthesized `swng-beta.template.json` renders `TOKEN_SECRET` as a `{{resolve:secretsmanager:...}}` dynamic reference (a generated secret has no value at synth); the template and `cdk.out` carry the reference, not the secret.
- **Vulnerability (actual):** CloudFormation resolves that reference into a **literal environment variable on the deployed Lambda**, so `lambda:GetFunctionConfiguration`/`GetFunction` returns the plaintext. That is a broad read permission (in `ReadOnlyAccess`, most auditor/CI/monitoring roles). This one secret signs ALL participant/spectator/crew-invite tokens — the master forge-key for the whole HMAC tier.
- **Exploit:** A principal with `lambda:GetFunctionConfiguration` (a common read-only grant, NOT admin) reads the secret and forges any token — impersonate any participant, mint any crew invite. Against an admin / RCE-in-the-Lambda attacker it is the same either way (they get it regardless), so this is about narrowing the read population, not stopping a full compromise.
- **Prod-blocker:** no (downgraded — the template-leak claim that made it High was disproven).
- **Fix:** Move to a runtime Secrets Manager fetch (cached at cold start; env carries the ARN, not the value) — narrows the read population to an explicit, CloudTrail-audited `GetSecretValue` grant AND enables key rotation without a redeploy (the real incident-response value on a signing key). Cheaper alternative: a customer-managed KMS key on the Lambda env vars (scopes `kms:Decrypt`) — no code change, narrows the read population, but no rotation.

### [High] USER_PASSWORD_AUTH enabled on the user pool
- **Where:** `apps/infra-cdk/lib/swngStack.ts:355` — `authFlows: { userPassword: true }`.
- **Vulnerability:** Direct username/password auth against `InitiateAuth`, enabled "solely so e2e can mint a token." On a PUBLIC prod pool it permits credential brute-forcing that bypasses the Hosted UI's own protections, and it's unnecessary in prod (e2e runs against beta).
- **Exploit:** Scripted password spraying / brute force straight at the Cognito API.
- **Prod-blocker:** yes — the prod pool must not carry this flow. Make it per-stage (beta-only) config.
- **Fix:** Omit `userPassword` for the prod stage; keep it only on beta for e2e.

### [Medium→High] User-facing strings and arrays have no upper bound
- **Where:** `packages/contracts/src/*.ts` throughout — e.g. `createCrewRequestSchema` name `z.string().min(1)` (crews.ts:42), `updateMeRequestSchema` name (golfers.ts:67), course/tee names + `holes`/`teeSets` arrays (courses.ts:33-43), `recordScoreRequestSchema` hole (commands.ts:67). All bound BELOW (min 1) but none bound ABOVE (no `.max()`).
- **Vulnerability:** A caller can submit multi-MB strings or huge arrays (a course with thousands of holes/tees, a megabyte crew/golfer name). These persist to DynamoDB — and for the event-sourced round, permanently.
- **Exploit:** Storage inflation + payload DoS, amplified by the no-per-identity-rate-limit gap below. One authenticated caller inflates storage/cost cheaply.
- **Prod-blocker:** yes (cheap, mechanical to fix; leaving it open at prod scale is a standing abuse lever).
- **Fix:** Add `.max(N)` to every user-facing string (names ≤ ~80-120, codes exact) and `.max(N)` to every array (holes ≤ 18, teeSets ≤ ~10, games ≤ ~10). One pass over `packages/contracts`.

### [Medium→High] No per-identity rate limiting; global throttle is itself a DoS lever; unbounded resource creation — THE named attacker scenario
- **Where:** `apps/infra-cdk/lib/swngStack.ts:571-633` (throttling); creation routes `POST /rounds`, `POST /crews`, `POST /crews/{id}/seasons`, `POST /crews/{id}/invites`.
- **Vulnerability:** API Gateway throttling is a single account/stage-wide token bucket (50 rps / 100 burst default; 5 rps / 10 burst on the 8 anon routes) — NOT per-caller. There is no app-level cap on accounts-per-IP, rounds-per-golfer, crews-per-golfer, seasons-per-crew, or invites.
- **Exploit (the owner's scenario, walked):** Cognito self-sign-up is free and self-service (only Cognito's own per-IP limits gate it) → mint N accounts. Each account can `POST /rounds` up to the 5 rps anon ceiling = ~18k rounds/hour, every one a PAY_PER_REQUEST write (+ a snapshot on finalize) — a billed cost-DoS, not a capacity outage (PAY_PER_REQUEST absorbs it, your invoice does not). Separately, because the throttle is GLOBAL, one attacker saturating the 5 rps anon bucket 429s every legitimate peek/join/course-read at once — the throttle is a shared-fate DoS lever.
- **Prod-blocker:** this is the gap the owner named; close it or consciously accept-with-monitoring before prod.
- **Fix:** (a) per-identity quotas (a usage-plan-style counter, or a WAF rate rule keyed on the JWT sub / source IP); (b) AWS WAF on the HTTP API + CloudFront (rate-based rules, per-IP); (c) app-level caps (rounds/day/golfer, crews/golfer); (d) the abuse-shape alarm from the monitoring workstream as the backstop.

---

## Should-fix for prod (hardening / defense-in-depth)

### [Medium] Join codes use Math.random(), not a CSPRNG
- **Where:** `packages/lambda/src/compositionRoot.ts:88-89` — `Math.floor(Math.random() * ...)`.
- **Vulnerability:** The join code is a capability (join a round → see live scores, record scores for anyone). Math.random() is not cryptographically secure; V8's PRNG state is recoverable from observed outputs, and the 30^6 (~729M) space is only bounded against brute force by the 5 rps anon throttle.
- **Prod-blocker:** no (throttle blunts brute force), but easy to fix and it's a security token.
- **Fix:** `crypto.randomInt`/`randomBytes` over the same alphabet. Also alphabet-validate `code` on the wire (currently `z.string().length(6)` accepts any 6 chars).

### [Medium] CORS allowOrigins: ["*"]
- **Where:** `apps/infra-cdk/lib/swngStack.ts:555`.
- **Vulnerability:** Any origin may call the API. Blunted because auth is Bearer-in-header (no cookies → no ambient-credential CSRF), so this is defense-in-depth, not a live bypass.
- **Prod-blocker:** no, but scope it for prod.
- **Fix:** Set `allowOrigins` to the known web origins per stage (swng.golf for prod).

### [Medium] Missing security response headers (HSTS, nosniff, referrer, frame-ancestors, base-uri)
- **Where:** `apps/infra-cdk/lib/swngStack.ts:846-863` — the ResponseHeadersPolicy sets only CSP; the CSP has no `frame-ancestors` or `base-uri`.
- **Vulnerability:** No HSTS, no `X-Content-Type-Options: nosniff`, no `Referrer-Policy`; the app is framable (clickjacking) and has no `base-uri` lockdown.
- **Prod-blocker:** no, but standard prod hygiene on a custom domain.
- **Fix:** Add `strictTransportSecurity`, `contentTypeOptions`, `referrerPolicy`, `frameOptions: DENY` via `securityHeadersBehavior`; add `frame-ancestors 'none'; base-uri 'self'` to the CSP string.

### [Medium] PITR only on snapshots; no deletionProtection on RETAIN tables
- **Where:** `apps/infra-cdk/lib/swngStack.ts` — only `snapshotsTable` sets `pointInTimeRecovery: true` (line 247). rounds/core/projections are RETAIN but no PITR; no table sets `deletionProtection`.
- **Vulnerability:** roundsTable (live round source-of-truth) and coreTable (golfers/courses/crews identity) have no point-in-time recovery and no guard against a direct `DeleteTable`.
- **Prod-blocker:** no, but real for a system holding user accounts + live rounds.
- **Fix:** PITR on rounds + core (projections is rebuildable) for prod; `deletionProtection: true` on all RETAIN tables.

### [Medium] Cognito prod hardening not configured
- **Where:** `apps/infra-cdk/lib/swngStack.ts:322-337` (UserPool).
- **Vulnerability:** No explicit `passwordPolicy`, no MFA, no threat-protection/advanced-security (compromised-credential + impossible-travel detection — available under the Essentials plan already set), and `PreventUserExistenceErrors`/user-enumeration posture unverified.
- **Prod-blocker:** no, but a public prod pool wants these.
- **Fix:** Explicit strong password policy; MFA optional (or required); enable threat protection; verify user-existence-error prevention. Deliver as prod-pool config.

### [Medium] `indexHistory` is O(N²) in career length — FIX, don't monitor (owner-corrected 2026-07-23)
- **Where:** `packages/domain/src/golfer/metrics.ts:102` — `golferMetrics` builds `indexHistory` as `lines.map((line, k) => detailsOf(lines.slice(0, k + 1)))`: for each of N rounds it re-folds the whole prefix. Runs on the `GET /me/record` AND `GET /golfers/{id}` read paths (both via `recordOf` → `golferMetrics`).
- **Vulnerability:** N career rounds → N prefix-folds → O(N²) CPU per read, on the exact path a p95-latency alarm targets. A golfer with a long history (or one who inflates it) makes each of their own record reads quadratically expensive.
- **Prod-blocker:** no, but this is a real defect, not an "accept + monitor" (the review's original disposition was wrong). The projection system already stores the per-round lines; there is no reason to re-fold prefixes.
- **Fix:** Bound the computation to the display window. The chart shows only the **last 20 rounds** (the WHS window, index-chart-polish spec), and a WHS index depends only on the last 20 differentials — so compute only the last ~20 points, each over a ≤20-round window → O(1) in career length. Plan must confirm no consumer needs the full-history array.

### [Medium] Crew membership is uncapped → per-read fan-out amplifier (owner-surfaced 2026-07-23)
- **Where:** `packages/domain/src/crew/crew.ts:48` — `addMember` has no roster-size cap ("a pure roster op, doesn't care"); `getSeasonStandings` (`packages/application/src/crews/getSeasonStandings.ts`) issues ONE `listLines` query per roster member.
- **Vulnerability:** A large crew roster makes every standings read fan out to one Dynamo query per member. Reaching a huge roster requires that many accounts each accepting an invite (so it loops back to the account-creation choke), but the count directly drives read work regardless.
- **Prod-blocker:** no.
- **Fix (owner-corrected 2026-07-23 — do NOT cap membership):** a hard crew-size cap is a *product* limit that would reject a legitimate large crew (a real society), and the abuse it targets is already choked upstream by WAF on account creation (every member is an account accepting an invite). This is a **read-cost** matter, not a membership question: if a legitimate crew ever grows large enough for the per-member fan-out to bite, bound it at the read (batch/paginate `getSeasonStandings`), never by limiting who may be in the crew. Out of scope for Arc A; noted for later only if telemetry shows a real large-crew read cost.

### [Low] aws-cdk-lib < 2.260.0 — HIGH advisory, but build-time only
- **Where:** `pnpm audit`: `apps__infra-cdk>aws-cdk-lib` (GHSA-vcrf-j523-4mrf, OS command injection in NodejsFunction Docker bundling). Also `e2e>ws` (2 advisories) — test-only.
- **Vulnerability:** The advisory is a build-tool path (CDK synth/bundle of untrusted input), not a runtime exposure. **No vulnerable dependency ships to the Lambda runtime** (aws-sdk / aws-jwt-verify / zod are clean).
- **Prod-blocker:** no.
- **Fix:** Bump `aws-cdk-lib` ≥ 2.260 and `ws` ≥ 8.21 for hygiene.

---

## Confirm — product / privacy decisions for prod

### [Info] GET /golfers/{golferId} exposes a golfer's full record to any signed-in golfer
- **Where:** route `GET /golfers/{golferId}` (golfer-gated, not self-scoped); returns name, index sources, metrics, full round history.
- **Note:** golferIds are UUIDv4 (not enumerable), but any co-participant or crew-mate learns yours, then can pull your entire golf history + index. By design (navigation spec §6a). No email/PII beyond golf data is returned. Confirm this is the intended prod privacy posture.

### [Low] Permanent, unrevocable spectator/watch links
- **Where:** hmacTokenIssuer spectator scope (no `exp`), `POST /rounds/{id}/share`.
- **Note:** A leaked watch link exposes a round's live/archived scorecard forever. Data is low-sensitivity golf scores; rounds are ephemeral. Acceptable IF round data stays low-sensitivity (the CLAUDE.md tripwire). Confirm; consider revocation post-prod.

### [Low] Verify the Cognito `email` claim is never persisted or returned
- **Where:** `createCognitoVerifier.ts:22` reads `email` into AccountClaims; CLAUDE.md asserts "sub only — nothing reads claims.email into a golfer."
- **Note:** Spot-verify no use case persists or echoes `email` (low risk given the accounts-only wall; worth one confirming grep).

---

## Verified good (negative results)

- **Token HMAC** (`hmacTokenIssuer.ts`): constant-time `timingSafeEqual`, length-checked before compare; scope narrowing correct — crew-invite rejected on participant/round-read tiers, spectator gets `read-only-token` (403) on writes, `roundId` matched against the path on every round-scoped route. ✓
- **Cognito JWT** (`createCognitoVerifier.ts`): full verification via `aws-jwt-verify` (signature/iss/aud=clientId/exp/token_use="id") — not a bare decode. ✓
- **Resource IDs**: `randomUUID()` (v4) — not enumerable. ✓
- **Error hygiene** (`errorMapping.ts`): unknown errors → generic `{internal-error, "an unexpected error occurred"}`, stack to logger only; ContractError echoes only self-constructed validation messages. No internal leak. ✓
- **IAM**: `grantReadWriteData`/`grantReadData` scoped per-table, per-action — no `dynamodb:*`, no `Resource: *`. Projector/rebuild are read-only on core. ✓
- **S3/CloudFront**: bucket `BLOCK_ALL` + OAC (only the distribution reads), `enforceSSL`, viewer `REDIRECT_TO_HTTPS`. ✓
- **CSP**: `script-src 'self'`, no third-party origins; connect-src scoped to this stack's own live endpoints. ✓
- **NoSQL injection**: DynamoDB exact-match keys + parameterized ExpressionAttributeValues; client-supplied ids are used as whole pk values (not query fragments), so a `#` can't cross partitions. Low risk. (Recommend alphabet-validating the join code + bounding id lengths as defense-in-depth.) ✓
- **Dependencies shipped to runtime**: clean — all audit findings are build/test-only. ✓

---

## Monitoring workstream input (owner's alarm complaint)

Current alarms (`swngStack.ts:667-820`) — the noise the owner named:
- **REMOVE (noise):** per-function `Errors ≥ 1 / 5min` for all 5 functions; DynamoDB `Throttled ≥ 1 / 5min` for all 5 tables. Both fire on any single transient blip.
- **KEEP (real, non-transient):** Projector DLQ depth > 0 (a poisoned record); Projector IteratorAge > 5min (projections falling behind). Rebuild-duration is manual-only, low noise — keep.
- **ADD (the owner's ask):** non-transient HTTP 5xx (multi-evaluation-period, M-of-N, higher threshold — the current single-period `≥5 in 5min` still pages on one blip); **p95 latency** (no latency alarm exists today) on the HTTP API; an **abuse-shape** alarm (resource-creation-rate spike) built on the usage metrics below.

## Usage-metrics workstream input ("not in the dark")

No usage metrics today — only structured JSON logs to CloudWatch. Options: EMF (embedded
metric format) emitted from the use cases (startRound → rounds-created, finalizeRound →
rounds-finalized, ensureGolfer first-touch → signups) → auto-extracted CloudWatch metrics →
one dashboard (rounds/day, signups/day, active golfers) + the abuse alarm reads the same
metric. This is the "how many rounds/signups" answer AND the abuse-signal source in one.

## Prod-stack workstream input

`swng-prod` via the existing STAGE_WEB / per-stage-props table (`bin/infra-cdk.ts`) — separate
Cognito pool (USER_PASSWORD_AUTH off, hardened), `swng.golf` apex (CLAUDE.md: "prod gets
swng.golf as one STAGE_WEB entry"), own TOKEN_SECRET (runtime-fetched per finding #1), tables
with PITR + deletionProtection, prod throttles, prod alarm email. Prod smoke tests: a real
sign-up → create → score → finalize round-trip + a headers/CSP check. SwngStack already throws
on `InfraCdkStack*` ids; `swng-prod` is safe. Note the swng.golf apex DNS handover.
