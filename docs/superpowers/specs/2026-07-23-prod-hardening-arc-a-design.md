# Prod-readiness Arc A — App hardening (design)

**Date:** 2026-07-23
**Status:** design, pending owner spec-review → plan → subagent-driven execution (fresh session)
**Findings source:** `docs/superpowers/specs/2026-07-23-prod-readiness-security-findings.md`

## Where this sits

The owner is taking swng to its first production deployment. The whole effort is three
sequential arcs, each its own spec → plan → build → beta-gate:

- **Arc A — App hardening (this doc).** Everything that is a code change or a universally-safe
  stack change, proven on `swng-beta` before prod exists.
- **Arc B — Observability.** Replace the noisy beta alarms with non-transient 5xx + p95-latency,
  keep DLQ-depth + IteratorAge, and add usage metrics (rounds/signups/active golfers) — the
  abuse-shape alarm reads those metrics.
- **Arc C — Prod stack + smoke tests.** The `swng-prod` stack (`swng.golf`, a separate hardened
  Cognito pool, prod secret, PITR/deletionProtection config exercised per-stage) + prod smoke
  tests.

Arc A is the security-hardening arc, scoped by the findings ledger. It closes the prod-blockers
that are universally safe on beta, plus the should-fix defense-in-depth, plus two defects the
owner surfaced on review (the `indexHistory` N² and uncapped crew fan-out).

## Goal

Close the prod-blocking and should-fix security gaps that can be built and verified on beta,
leaving Arc C to carry only the config that is genuinely prod-pool-specific.

## Non-goals (explicitly deferred)

- **`USER_PASSWORD_AUTH` off + Cognito password-policy / MFA / threat-protection → Arc C.** Beta
  needs `USER_PASSWORD_AUTH` for e2e token-minting; the *prod* pool is a separate pool where
  these land and get exercised. Turning it off on beta would break e2e.
- **Alarms rework, p95, usage metrics, the abuse-shape alarm → Arc B.**
- **Per-account creation caps (rounds/day, crews/account).** NOT in Arc A. WAF-on-Cognito
  chokes the creation-flood head, bounds close the amplifiers, and Arc B's alarm gives
  visibility — per-account caps add product friction and require picking numbers before we have
  usage data. Revisit as a fast-follow only if telemetry shows single-account abuse.
- **Product/privacy confirms** (golfer-record visibility to any signed-in golfer; permanent
  watch links). Revisit when Arc C makes the prod cut; not code work.

## The four hardening principles

### 1. The token-signing secret moves out of the Lambda env (Medium — was over-rated; see findings)

**Problem (finding: Medium, should-fix — NOT a prod-blocker).** `TOKEN_SECRET`
(`swngStack.ts:425` `tokenSecret.secretValue.unsafeUnwrap()`) resolves — via a CloudFormation
`{{resolve:secretsmanager:...}}` dynamic reference, **not** a plaintext template value (verified
in the synthesized template) — into a **literal environment variable on the deployed Lambda**.
So `lambda:GetFunctionConfiguration` (a broad read permission, in `ReadOnlyAccess`) returns the
plaintext. This one secret signs ALL participant/spectator/crew-invite tokens — the master
forge-key for the whole HMAC tier.

**Honest scope:** against an admin / RCE-in-the-Lambda attacker this changes nothing (they get
the secret regardless). The win is narrowing *who* can read the master forge-key from "any
read-only/audit/CI role with `lambda:Get*`" to an explicit, CloudTrail-audited grant, and —
the property that actually matters on a signing key — enabling **rotation without a redeploy**
(roll it in an incident; it invalidates live tokens, which is the intent).

**Fix.** Runtime Secrets Manager fetch, once per cold start, cached in module scope: the Lambda's
env carries the secret **ARN**, not the value; the composition root resolves it before building
the `TokenIssuer`. Value never sits in the function config. (Cheaper alternative if the code
change isn't worth it for a Medium: a customer-managed KMS key on the Lambda env vars — no code
change, narrows the read population via `kms:Decrypt`, but no rotation. Recommendation: the
runtime fetch, for the rotation capability.)

- `compositionRoot.ts` `buildApp` becomes async (or gains an async secret-resolve step before
  the `TokenIssuer` is constructed); the entry points (`entries/http.ts` etc.) already build the
  app at module scope — they resolve the secret on first cold start and reuse it.
- The stack grants `httpFn` (and any function that mints/verifies tokens) `secretsManager:GetSecretValue`
  on the one secret's ARN, and passes `TOKEN_SECRET_ARN` (or name) instead of the value.
- Local/test wiring keeps a way to inject a literal secret (the `createHmacTokenIssuer({ secret })`
  port is unchanged — only *where the string comes from* changes).

**Note:** ws-connect/ws-disconnect also carry `TOKEN_SECRET` today (they verify tokens on
connect). They move to the same runtime-fetch path, or — if a WS entry never needs the secret —
drop it. The plan resolves which functions genuinely need it.

### 2. Bound every user-controlled count and length

**Problem (findings: Med→High input bounds; owner-surfaced crew fan-out).** User inputs are
bounded below (`min(1)`) but almost never above. Two halves:
- **Lengths:** golfer name, course name, tee names have no `.max()` (crew & season names *are*
  bounded to 60 in the domain — the pattern exists, it's just not applied everywhere).
- **Counts:** `holes`/`teeSets`/games/players arrays have no `.max()`; **crew membership has no
  cap at all**, and `getSeasonStandings` fans out one `listLines` per member — so roster size is
  a direct read-amplifier.

**Placement rule (load-bearing — owner, 2026-07-23):** bounds go at the **wire ingress** (request
schemas in `packages/contracts`) ONLY. They must never be added to response/read schemas or to any
fold/deserialization path — a limit that rejects *stored* data bricks a legitimate user's own
data, which is worse than the DoS it would prevent. Input hygiene lives at ingress; reads tolerate
whatever is already stored.

**No crew-size cap.** An earlier draft added a hard `MAX_CREW_MEMBERS` cap in the domain. It is
dropped: it is a *product* limit (it would reject a legitimate large crew — a real society — at
its next member) masquerading as a DoS defense, and the abuse it targeted is already choked
upstream by WAF on account creation (every crew member is an account accepting an invite). The
genuine concern — `getSeasonStandings` issuing one `listLines` per member — is a **read-cost**
matter: if a legitimate crew ever grows large enough for it to bite, bound it at the read
(batch/paginate the standings), never by capping membership. Out of scope for this arc.

**Fix — one principle, applied systematically at ingress:** every user-controlled string has a max
length and every user-controlled collection has a max count on its request schema. Proposed
concrete values (owner may adjust on review):

| Field | Bound |
|---|---|
| golfer name | ≤ 60 (match crew/season) |
| course name | ≤ 80 |
| tee name | ≤ 40 |
| `holes` per tee | ≤ 18 (already 9/18 in practice) |
| `teeSets` per card | ≤ 12 |
| games per round | ≤ 8 |
| players per game | ≤ 12 |
| join code (wire) | exactly 6 chars from the safe alphabet (currently any 6 chars) |

All of these surface as the existing `invalid-request` 400 at the request boundary — no new error
code, no domain change, no read-path gating.

### 3. The index-over-time series is computed faithfully to the rule (fix the N²)

**Problem (finding: Med, owner-corrected — a domain-correctness defect, not a monitor and NOT a
UI-driven bound).** `metrics.ts:102` builds `indexHistory` ("your index over time", the profile
chart's data) by recomputing the index over the *whole career-prefix* for every round —
`lines.map((line, k) => detailsOf(lines.slice(0, k + 1)))` — O(N²) in career length, on
`GET /me/record` and `GET /golfers/{id}`.

**The framing that matters (owner, 2026-07-23): this is NOT about the chart.** There are two
different "20s" and only one belongs in the backend:
- **The WHS window (golf truth).** A handicap index is *defined* as "best 8 of your last 20
  rounds" (WHS Rule 5.2a; swng extends the same window to unrated rounds). Your index as-of any
  round depends ONLY on the ≤20 rounds before it. This 20 is a domain rule — it belongs in the
  domain irrespective of any view.
- **The chart's display count (presentation).** The profile chart plots the last 20 points; that
  is a UI decision that stays in the UI (and is 20 only because the chart work matched it to the
  WHS window for honesty). Same number, different concern — do NOT let the display count leak
  into the domain computation.

**Fix — a single forward pass (domain correctness, zero UI coupling).** Scanning the whole prefix
at each round is both slower and a *less faithful* expression of the rule (the rule says "last
20," not "everything so far"). The correct O(N) fix is a **single forward pass** that maintains a
rolling window of the last 20 *combined differentials* per index stream (WHS = rated lines only;
swng = all ags-bearing lines), emitting each round's point as it goes.

**Subtlety that rules out a naive line-slice (found while planning, 2026-07-23):** the WHS window
is the last 20 *differentials*, and 9-hole rounds pair into differentials
(`combineNineHoleDifferentials`, `whs.ts:144`) — so "last 20 rounds" is NOT "last 20 lines," and
an old unpaired 9 can pair with a recent one. Slicing to the last N *lines* is therefore subtly
wrong for a 9-hole-heavy history. The forward pass maintains the pairing state correctly across
the whole record, so it is both O(N) and faithful.
- Returns the **complete, honest series** — every point, computed correctly — with no knowledge
  of the chart.
- The headline `whsIndex`/`swngIndex` is unchanged (it is definitionally the last point).

**Layering, stated cleanly:**
- **Domain** computes the full index-over-time series, O(N), each point over its WHS window (the
  "20" here is the golf rule).
- **UI** decides how much of that series to show (currently last 20) — a `slice` in the view.
  Legitimate now, because it slices a cheaply-computed complete truth, not a slow backend.
- **Only if payload size ever matters** (it won't — ~500 points is ~20KB) would a caller-supplied
  `limit` input be added — an input, never a baked constant, and not now.

No second endpoint, no duplicated logic: one algorithm computes the true series; consumers take
what they need.

**Correctness check (plan):** windowing each point to its last-20 must yield the SAME index
values the whole-prefix computation does (WHS only ever uses the last 20, so it should) — pin it
with a test that computes a point both ways over a ≥21-round fixture and asserts equality, plus
the existing "headline index equals the last series point" invariant. The full round-*history
list* is a separate field and is untouched (no visible change anywhere).

**Readability** (owner note): the current dense `map`/`slice`/`detailsOf` expression does not say
what it means — rename/comment so it reads as "the golfer's index as of each round, each over the
WHS window (Rule 5.2a)."

### 4. Abuse is layered: managed WAF + bounds + monitoring

**Problem (finding: Med→High, the owner's named scenario).** The API Gateway throttle is one
global bucket, not per-caller; there is no cap on account/crew/round creation; the attack chain
is accounts → crews → rounds.

**Fix — three layers, not alternatives:**
- **WAF (managed) — the choke.** An AWS WAFv2 web ACL with an IP rate-based rule, associated
  with (a) the **Cognito user pool** (rate-limits `SignUp`/`InitiateAuth` and the managed-login
  pages — chokes account-creation floods at the head of the chain) and (b) the **CloudFront
  distribution** (the web edge). Managed, ~$5–10/mo, zero app code. **Constraint recorded
  honestly:** API Gateway **HTTP API (v2) cannot be associated with WAF** — only REST (v1) can —
  so the HTTP API stays on its existing API Gateway throttle. That is acceptable precisely
  because every API creation route requires a Cognito account, and account creation is now
  WAF-choked. The web ACL is CLOUDFRONT-scope, created in us-east-1 (this stack's region).
- **Bounds — the amplifier removal (principle #2).** WAF stops floods; the bounds are what
  actually close crew-fan-out and giant-payload abuse regardless of rate.
- **Monitoring — the backstop (Arc B).** p95-latency + an abuse-shape alarm on the
  resource-creation-rate metric.

WAF rule tuning (rate threshold per 5-min window) is set generously above a real crew's rate and
is a stated, adjustable constant in the stack.

## Edge / transport hardening (bundled stack changes)

These ride with Arc A because they are universally-safe stack changes provable on beta:

- **Security response headers** (finding: Med). Extend the CloudFront `ResponseHeadersPolicy`
  `securityHeadersBehavior` with `strictTransportSecurity`, `contentTypeOptions` (nosniff),
  `referrerPolicy`, and `frameOptions: DENY`; add `frame-ancestors 'none'` and `base-uri 'self'`
  to the CSP string.
- **CORS scoping** (finding: Med). Replace `allowOrigins: ["*"]` with the per-stage web origins
  (the stack already computes `webOrigins`). Blunted today by header-bearer auth (no cookies),
  so this is defense-in-depth, but `*` should not go to prod.
- **Data durability** (finding: Med). Add `pointInTimeRecovery: true` to the rounds and core
  tables (projections is rebuildable; snapshots already has it), and `deletionProtection: true`
  to all RETAIN tables. Safe to apply on beta now.
- **Dependency bumps** (finding: Low). Bump `aws-cdk-lib` (≥ 2.260, build-time advisory) and
  `ws` (≥ 8.21, test-only). No runtime dep is vulnerable today; this is hygiene.
- **Verify the Cognito `email` claim is never persisted or echoed** (finding: Low). One
  confirming pass; expected a no-op given the accounts-only-sub wall.

## Testing & gating

- `pnpm validate` green at every commit and at HEAD (the standing gate).
- New/changed behavior gets its own tests: contract `.max()` rejections, the crew-size cap
  (domain + a join path), the bounded `indexHistory` (length + headline-equals-last-point), the
  runtime-secret resolution (composition-root wiring test with an injected fake secret source).
- Stack changes are pinned in `swngStack.test.ts`: the WAF web ACL + associations, the response
  headers, CORS origins, PITR/deletionProtection, and the secret-arn-not-value env.
- `pnpm test:contract` where the secret-runtime-fetch touches adapters.
- Close-out (controller-run, per the established beta cycle): `deploy:beta` →
  `publish:web:beta` (if the bundle changes) → `e2e:beta` → `e2e:field` → an adversarial USE
  pass on the deployed surface (verify a forged-token attempt still fails, headers present via
  `curl -I`, a bounded payload rejected, WAF association live).

## Deploy considerations

- **Secret runtime-fetch is the sensitive one.** It changes how every token is signed/verified.
  Deploy order and a same-secret-value migration must be handled so in-flight participant tokens
  keep verifying across the cutover (same secret string, just sourced differently — so tokens
  are unaffected as long as the value doesn't rotate during the switch). The plan spells this
  out; the field/e2e suites (which mint and use real tokens) are the proof.
- WAF, headers, CORS, PITR, deletionProtection are additive/in-place stack updates — no
  resource replacement, accounts/tables safe. `cdk diff` before deploy confirms in-place-only.
- Web-affecting changes (CSP/headers, CORS) need `publish:web:beta` only if the bundle changes;
  header/CORS are stack-only.

## Open items for the plan

- Exact list of functions that need the token secret at runtime (http vs ws entries).
- Whether the crew-size cap needs a tolerate path for any existing over-cap beta crew (beta is
  disposable — likely just enforce forward; the plan checks for any live crew over the cap).
- WAF rate-threshold starting value and the metric name Arc B's abuse alarm will read.
