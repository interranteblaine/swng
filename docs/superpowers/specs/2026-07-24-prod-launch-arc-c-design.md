# Prod-readiness Arc C — Production launch (`swng-prod`) (design)

**Date:** 2026-07-24
**Status:** design — decisions OWNED by the controller and baked here (per owner direction:
"these are your decisions, bring clear recommendations, senior-level thinking, baked into the
spec"). Owner reviews the written spec, then plan → execute for a launch **tomorrow (2026-07-25)**.
**Predecessors:** Arc A (app hardening, deployed to beta) and Arc B (observability, code-complete
on `main`, held from beta through the owner's live round). This is the THIRD and final
prod-readiness arc.
**Grounding:** a full stage-parameterization map of `apps/infra-cdk/` (2026-07-24) — cited inline.

## Where this sits, and what the goal actually is

The owner played a real round on `beta.swng.golf` today (birdie, won skins, the math matched the
paper card exactly) and wants a real go **tomorrow** with people who have large social-media
reach. The stakes are reputational: if it fails in front of them it hurts; if it goes well it
amplifies.

**The goal is a hardened launch whose only failure modes to avoid are:**
1. **Sign-in breaking** in front of people (a broken auth flow is the one unrecoverable
   first-impression failure), and
2. **A surprise bill** because someone abused the open surface.

**The goal is NOT viral-scale throughput.** The owner was explicit: "I'm not planning for a viral
moment… the task was, we don't want to hurt ourselves with a huge bill because somebody abused
what we've built." An earlier draft of this design mis-framed the work as launch-scale headroom
(raising throttles, provisioned concurrency, an auto-confirm email workaround). That is **removed**
— it solves a problem we don't have and adds complexity and cost. This arc is: turn the proven
beta app into a **hardened, separately-branded prod stack on `swng.golf`**, reusing the abuse and
durability protections Arc A/B already shipped.

## What is already done (the map's good news)

The stack is already cleanly stage-parameterized. These need **no** Arc C work — they flow to prod
from one config entry:
- Every resource NAME is `…-${stage}` (`bin/infra-cdk.ts:23` → `swng-prod`); no cross-stage
  collision. The POC-stack guard (`swngStack.ts:187-194`, `/^InfraCdkStack/`) does **not** match
  `swng-prod` — safe.
- The `web` prop already drives the ACM cert, CloudFront alias, Route53 A/AAAA, the Cognito
  callback/logout domain leg, CORS, and the `WebDomainUrl` output — all guarded so an absent
  domain synths identically. Prod needs only the `STAGE_WEB.prod` entry (apex) uncommented
  (`bin/infra-cdk.ts:18`).
- The token secret is per-stage (`swng-token-secret-${stage}`, runtime-fetched — Arc A).
- All five tables carry their RETAIN/DESTROY + PITR + deletion-protection posture per-stage
  (Arc A); prod gets real durability automatically.
- Arc A's WAF (both ACLs), security headers, CORS scaffolding, and Arc B's alarms + `swng-ops`
  dashboard + EMF metrics + access log are all in the shared stack — **prod inherits the entire
  abuse-and-observability layer** with no new code.

So Arc C is small and focused: a typed per-stage config for the few things that genuinely differ,
prod auth hardening, the apex domain, deploy tooling, and a launch runbook + smoke gate.

## Architecture: one typed `StageConfig`, zero `stage === "prod"` branching

Today the per-stage knobs that AREN'T already parameterized are hardcoded constructor constants
(`authFlows.userPassword`, the throttle numbers, the WAF limit, the CORS `CLOUDFRONT_NET_ORIGIN`
literal, the dev origins). Arc C lifts **only the ones that actually differ** into the existing
per-stage props table in `bin/infra-cdk.ts`, extending `SwngStackProps` with a typed config the
stack reads. No stage-name conditionals inside the stack — it reads config values, exactly as it
already reads `props.web`.

**The genuinely per-stage differences (everything else stays uniform/shared):**

| Knob | beta | prod | Why per-stage |
|---|---|---|---|
| `web` (domain) | `beta.swng.golf` | `swng.golf` (apex) | already a prop; uncomment prod |
| `userPasswordAuth` | `true` | **`false`** | beta needs it for e2e token-minting; prod must not expose direct password auth |
| dev/extra origins (Cognito callbacks + CORS) | `["http://localhost:5173","http://localhost:4173", beta's cloudfront.net]` | `[]` | prod must not trust localhost or beta's origin |

**Applied UNIFORMLY (not per-stage — simpler, and good hygiene everywhere):**
- Explicit `preventUserExistenceErrors: true` (already the CDK default; pinned explicitly).
- The abuse ceilings — API throttles (50/100 default, 5/10 tightened set) and WAF
  `RATE_LIMIT_PER_5MIN = 2000` — stay **identical** to beta (see Decision 2).
- The alarm SNS email (`interrante.blaine@gmail.com`) — same owner, both stages.
- Managed-login branding, CSP/security headers, tables durability posture.

**Prod-only additions (small, targeted):**
- A prod `passwordPolicy` (see Decision 5) — prod-only so beta's admin-created e2e users (fixed
  passwords) aren't rejected.
- Pool-level `deletionProtection` on the prod user pool (real accounts).

## The decisions (owned, with senior rationale)

### Decision 1 — Email verification: keep Cognito's built-in; do nothing; know the lever
Prod keeps `autoVerify: { email: true }` and Cognito's default email sender. At the real launch
scale (tens of golfers, per the owner — not thousands), the ~50-emails/day sandbox quota is **not
a binding constraint**, so there is nothing to work around. An auto-confirm PreSignUp Lambda —
proposed in the earlier draft — is **rejected**: it invents a mechanism to dodge a limit that
isn't binding, weakens verification, and adds a Cognito trigger to maintain. The **clean** way to
raise the ceiling, if signups ever approach it, is **SES production access** (a support request +
a verified `swng.golf` domain identity, then point the pool's email at SES) — a fast-follow
triggered by real volume, **not** speculative work for tomorrow. **Baked: no email change; SES
prod-access documented as the scale lever.**

### Decision 2 — Cost-abuse protection is already built; keep the ceilings TIGHT
The owner's named risk — "a huge bill because somebody abused it" — is already defended, and the
defense is to keep the ceilings **tight**, not to raise them:
- **WAF per-IP rate limit** (2000/5min) on the CloudFront edge AND the Cognito signup path (Arc A)
  — caps any single source.
- **API Gateway throttles** — a **global** token bucket (50 rps / 100 burst overall; 5 rps / 10
  burst on the 8 tightened routes). This global bucket is the **bill ceiling**: it caps total
  request rate — and therefore total PAY_PER_REQUEST spend — regardless of how many attackers or
  IPs. The earlier draft's proposal to raise these to "launch scale" (200/400) is **rejected**: it
  would *raise* the spend ceiling to solve a throughput problem the owner doesn't have. Prod keeps
  beta's tight values.
- **Input bounds** (Arc A) cap per-request storage inflation.
- **Alarms** (Arc B): WAF-blocked (>100/5min) + signup-spike (≥50/5min) page the owner if abuse
  starts.
DynamoDB is PAY_PER_REQUEST (no provisioned-capacity waste); nothing here needs a scaling change.
**Baked: prod throttles/WAF = beta's; no scaling work.**

### Decision 3 — Threat protection: NO (stay on Essentials)
Cognito threat protection (compromised-credential detection, adaptive auth) requires the **Plus**
feature plan — a per-MAU cost bump — and defends **credential-stuffing**, a different and
lower-priority threat than the **cost-abuse** the owner named (which WAF + throttles + bounds
already cover). Adding a plan cost for an orthogonal threat is the wrong trade at launch. **Baked:
prod stays `FeaturePlan.ESSENTIALS`** (also what managed login requires). Fast-follow to Plus only
if credential attacks ever materialize.

### Decision 4 — Domain: apex `swng.golf` only; no `www`
`swng.golf` is the shareable link. `www.swng.golf` is the legacy `www.` prefix — essentially
nobody types it for a new app, and handling it means a multi-name (SAN) cert, a second A/AAAA
record, and a redirect for ~zero benefit. **Baked: apex only.** A `www`→apex redirect is a trivial
fast-follow if it ever matters. **Operational precondition:** confirm the `swng.golf` **apex
A-record** in hosted zone `Z00936512AJC1HGD9M7B7` isn't still pointing at the old POC distribution;
if it is, freeing/repointing it is a launch-day step (the same handover `beta.swng.golf` got). The
CDK `ARecord` for the apex will need `deleteExisting` or a manual pre-free if a record already
occupies it.

### Decision 5 — Auth hardening (baked)
- **`USER_PASSWORD_AUTH` OFF** on the prod app client (`authFlows.userPassword: false` via the
  `userPasswordAuth` config). It exists on beta "solely so e2e can mint a token via InitiateAuth"
  (`swngStack.ts:383-386`); prod must not expose direct password auth to `InitiateAuth`
  brute-forcing. The prod smoke test drives the real Hosted UI instead (Decision 7).
- **`preventUserExistenceErrors: true`** — pinned explicitly (already the effective default) to
  stop user-enumeration.
- **Explicit prod `passwordPolicy`** — a sane strong policy (min length 8, require lower+upper+
  digit; symbols NOT required — avoids reset friction while meeting the bar). Prod-only so beta
  e2e users aren't rejected.
- **Prod pool `deletionProtection`** — real accounts must not be one `DeleteUserPool` from gone.
- **No MFA** — required MFA kills signup conversion for casual golfers and defends a threat
  (account takeover) that isn't the launch risk; available to add later.
- **Prod origins are `https://swng.golf` + prod's own CloudFront only** — the `userPasswordAuth`
  and dev-origins config removes localhost and beta's `cloudfront.net` literal
  (`swngStack.ts:601`) from prod's Cognito callback/logout lists and CORS allow-list. (Prod's own
  CloudFront domain is still added via the existing phase-2 escape hatch.)

### Decision 6 — Deploy tooling
The current scripts are single-stack (`deploy:beta` doesn't set `STAGE`; `publishWeb.mjs` and
`webEnv.mjs` read the first stack from a shared `cdk-outputs.json` via `Object.values(outputs)[0]`;
`--profile swng` hardcoded). Arc C adds:
- **`deploy:prod`** — `STAGE=prod cdk deploy swng-prod … --outputs-file cdk-outputs.prod.json`
  (a **separate** outputs file so beta and prod don't clobber each other). `STAGE=prod` is
  mandatory — the stack-id arg alone would NOT change the internal `stage` (map §9 gotcha).
- **`publish:web:prod`** — a `publishWeb.mjs` that takes the stage/outputs-file (reads
  `cdk-outputs.prod.json`, bakes prod's `VITE_*` endpoints via `webEnv.mjs`, syncs the prod bucket,
  invalidates the prod distribution). The web bundle differs from beta ONLY in the 5 baked `VITE_*`
  endpoint values (origin handling is runtime-derived — map §9), so this is purely an
  outputs-file + target swap.
- Profile stays `swng` (same AWS account for beta and prod — acceptable; a separate prod account is
  a larger isolation lift, out of scope, noted).

### Decision 7 — The go/no-go gate + launch runbook
Because prod has `USER_PASSWORD_AUTH` off, the e2e suites (which mint via InitiateAuth) **cannot**
run against prod — they stay on beta. Prod's gate is a **controller-run smoke walk** on the
deployed `swng.golf`:
1. Real Hosted-UI **sign-up** as a throwaway account (proves the branded managed login + the
   verification email + PKCE all work end-to-end on the prod pool).
2. **Create → score → finalize** a round (proves the whole wire on prod tables).
3. **Sign out** (proves logout).
4. `curl -I https://swng.golf` — the five security headers + CSP present.
5. Delete the throwaway account.
Plus the **launch runbook**:
- **Confirm the `swng-alarms-prod` SNS email** — a real click after deploy (a fresh topic → a new
  confirmation email); without it, alarms never reach the owner during the launch.
- Watch the **`swng-ops-prod`** dashboard during onboarding.
- Know the incident lever: if sign-in breaks, the fix is fast (a Cognito callback-URL or CORS
  correction is a redeploy; the app itself is proven on beta).

## Sequencing

1. **Land Arc B on beta first.** Deploy the held Arc B (`deploy:beta`, then `publish:web:beta`) —
   proves the observability + WAF-dimension-fix changes deploy cleanly on a live stack and that
   the 7 alarms/dashboard/EMF/access-log are healthy. Prod inherits exactly these. Confirm the
   beta e2e gate still passes.
2. **Build Arc C** (the `StageConfig` refactor + prod auth hardening + apex entry + deploy
   tooling) via subagent-driven development — every commit `validate`-green; beta's synth must stay
   **byte-identical** where prod-only knobs are added (the stack's existing prop-less/beta template
   tests are the guard).
3. **Free the apex DNS** if the POC holds it.
4. **Deploy prod:** `deploy:prod` (creates the pool, tables, secret, cert [DNS-validated — allow
   provisioning time], CloudFront, WAF, DNS, alarms, dashboard) → `publish:web:prod`.
5. **Confirm the alarm email**, run the **smoke walk**, watch the dashboard.
6. **Owner announces** only after the smoke walk is green.

## Testing & gating

- `pnpm validate` green at every commit and at HEAD; `pnpm test:contract` if adapters are touched
  (not expected — Arc C is infra + config).
- The stack tests (`swngStack.test.ts`) gain a **prod-config synth** case: assert the prod stack
  synthesizes with `userPassword` **absent** from the app client's `ExplicitAuthFlows`, the prod
  password policy present, pool deletion-protection on, and no `localhost`/beta-origin in the prod
  client's callback/logout URLs or CORS. The existing **beta** synth must stay **byte-identical**
  (prod-only knobs must not perturb beta) — pinned by the current template tests.
- Beta's `e2e:beta` and `e2e:field` still pass after the Arc B beta deploy AND after the Arc C code
  lands (the `userPasswordAuth` config must leave beta's flow untouched).
- Prod is gated by the controller smoke walk (Decision 7), not automated e2e.

## Explicitly deferred (named fast-follows, not launch-blockers)
- **SES production access + a verified `swng.golf` sender** — the real email-scale lever; do it if
  signups approach the daily quota (Decision 1).
- **Cognito threat protection (Plus plan)** — if credential attacks appear (Decision 3).
- **`www.swng.golf`** — a redirect to the apex, if anyone ever needs it (Decision 4).
- **MFA** — if the security posture ever warrants it (Decision 5).
- **A separate prod AWS account** — stronger blast-radius isolation than a separate stack in the
  same account; a larger lift, not needed for launch (Decision 6).

## Deploy considerations / risk
- **Cert + CloudFront provisioning time.** The prod ACM cert is DNS-validated in the imported zone
  (automatic) but issuance + the CloudFront distribution create take real minutes — this is why the
  launch is tomorrow, not a 20-minute turnaround. Sequence the deploy with margin before any
  announcement.
- **`swng-prod` is a fresh CREATE** (new pool, tables, distribution, cert) — additive by
  definition; it cannot touch `swng-beta` or the POC stacks (distinct names; the guard holds).
- **No data migration** — prod starts empty; the owner and players sign up fresh on prod (beta was
  disposable test data). Expected and correct.
- **Same AWS account** as beta — resource names are stage-suffixed, so no collision; blast-radius
  isolation is a documented deferral.
