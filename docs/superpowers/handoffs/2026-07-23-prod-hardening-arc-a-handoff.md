# Handoff — Prod-readiness Arc A (app hardening)

**For:** a fresh Claude Code session, started to EXECUTE this work (the prior session hit the
200-subagent-spawn cap, so execution was deferred to a fresh session with a clean budget).

**Your first action:** invoke the `superpowers:subagent-driven-development` skill and execute the
plan below task-by-task (fresh implementer subagent per task → task review → whole-branch review →
controller-run close-out). Do NOT re-brainstorm or re-spec — the design is done and was
pressure-tested by the owner (see "What the owner already decided" below).

## The three documents (read in this order)

1. `docs/superpowers/specs/2026-07-23-prod-readiness-security-findings.md` — the full pre-prod
   security audit (findings + exploit scenarios + the verified-good list + what's deferred).
2. `docs/superpowers/specs/2026-07-23-prod-hardening-arc-a-design.md` — the Arc A design (four
   hardening principles + edge hardening + explicit deferrals).
3. `docs/superpowers/plans/2026-07-23-prod-hardening-arc-a.md` — the 8-task implementation plan
   with real code. **This is what you execute.**

## Where this sits

The owner is taking swng to its first production deployment. The whole effort is **three
sequential arcs**, each its own spec → plan → build → beta-gate:
- **Arc A — App hardening (THIS handoff).** Everything provable on `swng-beta`.
- **Arc B — Observability.** Rip out the noisy beta alarms (per-function `Errors≥1`, per-table
  `Throttled≥1`), keep DLQ-depth + IteratorAge, add **non-transient 5xx + p95-latency** alarms,
  and add **usage metrics** (rounds/signups/active golfers) — the abuse-shape alarm reads those.
  NOT this arc.
- **Arc C — Prod stack + smoke tests.** `swng-prod` (`swng.golf`, a separate hardened Cognito pool
  with `USER_PASSWORD_AUTH` OFF + password/MFA/threat protection, prod secret, PITR/deletion
  config), prod smoke tests. NOT this arc.

**Do only Arc A.** When it closes, the owner drives whether Arc B or C comes next.

## What the owner already decided (do not re-open)

- **The `indexHistory` N² fix (Task 3) is DOMAIN CORRECTNESS, not a UI-coupled bound.** The owner
  explicitly rejected pushing the chart's "show 20" into the domain. The "20" that lives in the
  domain is the WHS *rule's* window (Rule 5.2a), not a display count. The fix is a single O(N)
  forward pass; a naive last-N-*lines* slice is subtly WRONG because 9-hole rounds pair into
  differentials — the plan's Task 3 has the correct algorithm and the equality test (incl. a
  9-hole fixture). Keep the display decision in the view.
- **The token-secret fix (Task 4) is Medium, not a prod-blocker.** An earlier "plaintext in the
  CloudFormation template" claim was DISPROVEN (the template carries a `{{resolve:secretsmanager}}`
  reference; the plaintext is only the deployed Lambda's env var, read via
  `lambda:GetFunctionConfiguration`). It's worth doing for rotation-without-redeploy on the master
  signing key. If it feels heavy, the plan notes a cheaper CMK-env alternative — but the plan
  prescribes the runtime fetch.
- **Bounds (Task 1) are usage + length, not just text** — the owner pushed that a crew-size cap
  (fan-out) matters as much as string maxes. The plan bounds every user-controlled count AND
  length.
- **Abuse defense is three layers, not an either/or:** managed WAF (Task 5, chokes account
  creation at the head of the chain) + bounds (Task 1) + Arc B monitoring. WAF is managed AWS WAF.

## Standing constraints (carry into every task + the close-out)

- **`pnpm validate` green at every commit AND at HEAD.** Prefix tooling with `env -u NODE_OPTIONS`.
  Single web test: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run <file>`.
  `pnpm test:contract` where an adapter/composition wiring changes (Task 4).
- **Work stays on local `main`. NEVER push.** (The whole project develops on local main, never
  pushed — CLAUDE.md.)
- **The beta deploy cycle is CONTROLLER-RUN** — you personally run `deploy:beta`,
  `publish:web:beta`, `e2e:beta`, `e2e:field`, and the adversarial USE pass. Do not hand it off.
  (One tool/permission denial ≠ a blanket block.)
- **NEVER create/deploy/destroy a stack named `InfraCdkStack-*`** (the POC stacks; SwngStack's
  constructor throws on those ids). The stack is `swng-beta`.
- **Deploy order for Task 4:** the secret VALUE is unchanged (same secret, new delivery), so live
  tokens keep verifying; one `deploy:beta` grants `GetSecretValue` + switches the env together.
  `cdk diff` must show in-place only (no table/pool/client replacement) before every deploy.
- **Layering / compute fence:** golf logic lives in `@swng/domain`; `apps/web/src` may not import
  golf-compute directly (ESLint fence). No web change here should cross that.
- **Nodenext:** relative imports carry `.js` (typecheck-only enforcement — a miss fails
  `pnpm validate`, not build/vitest).

## Close-out (controller-run, after all 8 tasks + the whole-branch review)

Per the plan's Close-out section: whole-branch review → `pnpm validate` + `test:contract` →
`cdk diff` (in-place only) → `deploy:beta` → `publish:web:beta` (if the bundle moved) →
`e2e:beta` ×2 → `e2e:field` → an adversarial USE pass on the deployed surface (forged-token still
fails, `curl -I` shows the new headers, an over-cap payload is rejected, the WAF association is
live). Then a docs sweep (update CLAUDE.md's milestone log with the Arc A close-out).

## State at handoff

- The three docs above are committed on local `main`. No code changes yet — this is the plan,
  not the implementation.
- The findings ledger's original copy is also in the session scratchpad; the committed repo copy
  (doc #1 above) is authoritative and carries the owner's corrections (N² disposition, crew
  fan-out, secret severity).
