# Prod-readiness Arc B — Observability (design)

**Date:** 2026-07-24
**Status:** design — owner reacted to the proposal (relax p95 + 5xx; controller makes the
remaining judgment calls; proceed spec → plan → execute → green-light autonomously).
**Findings source:** `docs/superpowers/specs/2026-07-23-prod-readiness-security-findings.md`
(the "Monitoring workstream input" and "Usage-metrics workstream input" sections).
**Predecessor:** `docs/superpowers/specs/2026-07-23-prod-hardening-arc-a-design.md` (Arc A —
app hardening, complete). This is the SECOND of three sequential prod-readiness arcs.

## Where this sits

- **Arc A — App hardening (done).** Bounds, CSPRNG codes, O(N) index history, secret→Secrets
  Manager, WAF (two rate-based ACLs), security headers, CORS scoping, PITR/deletion-protection.
- **Arc B — Observability (this doc).** Kill the noisy beta alarms; make HTTP 5xx + latency
  non-transient; add usage metrics ("not in the dark") and one ops dashboard; consume the Arc A
  WAF metrics in an abuse-shape alarm. Everything provable on `swng-beta`; no prod stack.
- **Arc C — Prod stack + smoke tests.** `swng-prod`, hardened Cognito pool, prod secret, the
  prod alarm email + threshold re-tune (5xx as a *ratio*, not a count) live here.

Nothing in Arc B creates or touches a prod stack. All work lands on `swng-beta` and stays on
local `main` (never pushed — the standing constraint).

## Current state (mapped 2026-07-23, verified against the committed synth)

Everything observability-related is in `apps/infra-cdk/lib/swngStack.ts` (one file), plus the
structured logger in `packages/lambda/src/compositionRoot.ts`.

- **14 alarms → one SNS topic `swng-alarms-beta` → one email** (`interrante.blaine@gmail.com`).
  All 14 share `evaluationPeriods: 1`, `period: 5min`, `treatMissingData: NOT_BREACHING`, and a
  single `addAlarmAction` (no OK action). The topic's email subscription is created **pending**
  (SNS requires a human confirmation click after deploy; not trackable in code).
- The 14: **5 per-function `Errors≥1/5min`** (Http/WsConnect/WsDisconnect/Projector/Rebuild),
  **5 per-table `Throttled≥1/5min`** (Rounds/Core/Snapshots/Projections/Connections),
  **`HttpApi5xxAlarm`** (`metricServerError()` Sum ≥ 5, single period), **`ProjectorIteratorAge`**
  (> 5min), **`ProjectorDlqDepth`** (> 0), **`RebuildDuration`** (> 4min).
- **No dashboards. No custom/EMF metrics. No X-Ray.** No HTTP-API latency or 4xx alarm; no WS-API
  alarm; no API-Gateway access logging. WAF metrics (`swng-waf-cf-beta`, `swng-waf-cognito-beta`)
  are provisioned but consumed by nothing.
- Structured JSON logging exists (`createConsoleLogger`) but is emitted only from the broadcast
  adapter's error paths. Log retention is 731d (CDK-managed log groups via a cdk.json flag).

## Goal

Turn "14 blip-pagers and no idea how the app is doing" into: **quiet, meaningful alarms that
only fire on real, sustained problems; a single dashboard that answers "how's swng doing"; and
an abuse-shape alarm that reads the Arc A WAF metrics.**

## Non-goals (explicitly deferred)

- **Prod alarm email, prod thresholds, 5xx-as-a-ratio → Arc C.** Beta thresholds are count-based
  and generous; prod (real traffic) wants percentage-of-requests. That re-tune is Arc C's, on the
  prod stack.
- **X-Ray / distributed tracing.** Not needed to answer the owner's questions; a real cost/complexity
  add. Out of scope; revisit only if a latency mystery demands per-segment timing.
- **Per-account creation caps / usage plans.** Arc A's WAF + bounds are the abuse defense; Arc B
  only *observes*. Caps remain deferred (Arc A non-goal, unchanged).
- **Alarm auto-remediation / runbooks / paging escalation (PagerDuty etc.).** One email topic is
  the beta delivery; richer routing is a prod-ops concern, not this arc.
- **Log-retention change.** 731d is fine; not touched.

---

## The design

### 1. Alarm rework — delete the noise, keep the real, reshape/add the rest

**Delete (10 alarms).** All ten fire on a single transient blip (`≥1` in one 5-min window):

- the **5 per-function `Errors≥1/5min`** (`HttpErrorsAlarm`, `WsConnectErrorsAlarm`,
  `WsDisconnectErrorsAlarm`, `ProjectorErrorsAlarm`, `RebuildErrorsAlarm`). Nothing real is lost:
  the projector's genuine failure signal is **DLQ-depth + IteratorAge** (they fire *after* the
  10 retries exhaust / when it falls behind — a poisoned record, not a blip); HTTP-function
  faults surface as **5xx**; Rebuild is manual-invoke (you watch it when you run it).
- the **5 per-table `Throttled≥1/5min`** (Rounds/Core/Snapshots/Projections/Connections).
  PAY_PER_REQUEST tables rarely throttle, and when they do it manifests as **5xx / latency**,
  which the reshaped alarms below catch. A single throttled request is not an incident.

**Keep unchanged (3 alarms):** `ProjectorDlqDepth (> 0)`, `ProjectorIteratorAge (> 5min)`,
`RebuildDuration (> 4min)`.

**Reshape `HttpApi5xxAlarm` → non-transient.** `metricServerError()` (Sum), **threshold ≥ 10**
(relaxed from 5), `evaluationPeriods: 3`, `datapointsToAlarm: 2` (two of the last three 5-min
windows), `treatMissingData: NOT_BREACHING`. Add an **OK action** to the same SNS topic (learn
when it recovers).

**Add `HttpApiP95LatencyAlarm`.** `metricLatency({ statistic: "p95", period: 5min })`,
**threshold > 3000ms** (relaxed from 2000), `evaluationPeriods: 3`, `datapointsToAlarm: 2`,
`treatMissingData: NOT_BREACHING`, **OK action** on the same topic. (No latency alarm exists
today; the p95 metric is emitted for free by API Gateway.)

Thresholds are named, adjustable constants at the top of the alarm block (beta-generous; prod
re-tune is Arc C).

### 2. Usage metrics — "not in the dark" via EMF (no AWS SDK, no `PutMetricData`)

A small `Metrics` **port** in `packages/application` (a peer of the existing `Logger`), injected
into three use cases and called once on each business success:

| Emit point | Metric name | Meaning |
|---|---|---|
| `StartRound` success | `RoundsCreated` | a round was created |
| `FinalizeRound` success | `RoundsFinalized` | a round was sealed |
| `ensureGolfer` **first-touch** (a NEW golfer row is minted) | `Signups` | a new account golfer |

Only the *create* branch of `ensureGolfer` emits `Signups` — the race-loser that re-reads the
winner must NOT double-count. (This is the same branch point the accounts-only wall already
distinguishes.)

**Score-activity is derived from the access log (§3), not a 4th EMF counter** — scores are the
highest-frequency write and are already visible as `POST /rounds/{id}/scores` in the access log.

**Implementation — hand-rolled EMF in `compositionRoot`.** EMF (Embedded Metric Format) is a
specially-shaped JSON line on stdout that CloudWatch auto-extracts into metrics — **no API call,
no new IAM, no async-flush lifecycle.** A `createEmfMetrics(stage)` factory writes:

```jsonc
{ "_aws": { "Timestamp": <ms>,
    "CloudWatchMetrics": [{ "Namespace": "swng",
      "Dimensions": [["Stage"]],
      "Metrics": [{ "Name": "RoundsCreated", "Unit": "Count" }] }] },
  "Stage": "beta", "RoundsCreated": 1 }
```

- **Namespace `swng`, one `Stage` dimension** (`beta`/`prod`) — forward-compatible so prod metrics
  don't collide; Arc C passes `Stage: "prod"` and reuses everything.
- Matches the house-style hand-rolled `createConsoleLogger`. **Rejected:** the `aws-embedded-metrics`
  npm lib — heavier, an async-flush footgun under Lambda's freeze/thaw, unnecessary for three
  counters.
- **Tests** wire a no-op/spy `Metrics` (like the existing test loggers). Use-case tests assert the
  emit fires exactly once on success and NOT on the failure/idempotent-replay/race-loser paths.

The `Metrics` port is fire-and-forget and MUST NOT throw into the use case (a metrics failure
never fails a round). The EMF writer is a pure `console.log` — the only failure mode is a
serialization bug, guarded by keeping the payload to primitives.

### 3. Operational telemetry — one dispatcher access-log line

The dispatcher (`packages/lambda`) emits one structured line per HTTP request, AFTER the request
resolves:

```
logger.info("request", { route, status, sub, latencyMs })
```

- `route` = the matched route key (e.g. `POST /rounds`); `status` = the HTTP status; `sub` = the
  authenticated Cognito subject when present (omitted on `auth: "none"` routes); `latencyMs` =
  wall time for the handler. `sub` is an opaque UUID — **no email/PII** (the accounts-only wall;
  Cognito is sub-only).
- This unlocks, via **CloudWatch Logs Insights** (no pre-aggregation, queried on the dashboard):
  **unique active golfers** (`count_distinct(sub)` over 24h), **requests-by-route**, and
  **4xx/5xx-by-route** (which route is erroring/slow). It is also where score-activity volume
  comes from (`POST …/scores` count).
- One `logger.info` on an existing seam; negligible log-volume cost. The dispatcher already
  resolves the route and the auth context, so `route`/`sub` are in hand; `latencyMs` is a start
  timestamp captured at dispatch entry.

**Layering note:** the p95 *alarm* (§1) reads API Gateway's own `Latency` metric (free,
directly alarmable). The access-log `latencyMs` is for the per-route dashboard breakdown only —
different granularity, different consumer.

### 4. Abuse-shape alarm — two cheap signals, reading real inputs

- **`WafBlockedRequestsAlarm`** — `AWS/WAFV2 BlockedRequests` summed across the two Arc A ACLs
  (`swng-waf-cf-beta` CLOUDFRONT-scope + `swng-waf-cognito-beta` REGIONAL, both readable in
  us-east-1), **threshold > 100 / 5min**, `evaluationPeriods: 1`. This is "the WAF rate rule is
  actively choking a flood *right now*" — the most direct abuse signal, zero app code. Uses
  `Rule: ALL` on each ACL's metric via a metric-math sum.
- **`SignupSpikeAlarm`** — the `Signups` EMF metric (§2), **threshold ≥ 50 / 5min**,
  `evaluationPeriods: 1`. Catches distributed account-creation abuse that stays under the per-IP
  WAF rate. (Until the first signup ever, the metric is absent and the alarm sits in
  INSUFFICIENT_DATA with `treatMissingData: NOT_BREACHING` — correct: no signups is not abuse.)

Both fire to the same SNS topic. Both thresholds are named, adjustable constants.

### 5. One CloudWatch dashboard — `swng-ops-beta`

A single pane answering "how's swng doing," built in the stack. Widgets:

1. **Business** — `RoundsCreated`, `RoundsFinalized`, `Signups` (EMF, Sum, daily) as a time series.
2. **Unique active golfers (24h)** — a Logs Insights `LogQueryWidget`:
   `stats count_distinct(sub) as activeGolfers by bin(1d)` over the http log group.
3. **Requests by route** — Logs Insights `stats count(*) by route` (top routes; includes the
   score-activity volume).
4. **HTTP latency** — API Gateway `Latency` p50/p95/p99.
5. **HTTP errors** — API Gateway 4xx (`metricClientError`) + 5xx (`metricServerError`) counts;
   plus a Logs Insights `filter status >= 400 | stats count(*) by route, status` for the
   which-route breakdown.
6. **Projector health** — `IteratorAge` (Max) + DLQ `ApproximateNumberOfMessagesVisible` (Max).
7. **WAF** — `AllowedRequests` + `BlockedRequests` across both ACLs.

Dashboard name carries the stage (`swng-ops-${stage}`) so prod gets its own in Arc C.

---

## Thresholds & constants (all named, adjustable, beta-generous)

| Constant | Value | Rationale |
|---|---|---|
| HTTP 5xx threshold | `≥ 10` in a 5-min window | relaxed from 5 (owner) |
| HTTP 5xx window | 2 of 3 five-min periods | non-transient — real sustained errors |
| HTTP p95 latency | `> 3000 ms` | relaxed from 2000 (owner) |
| HTTP p95 window | 2 of 3 five-min periods | non-transient |
| WAF blocked requests | `> 100 / 5min` | a real flood; the WAF is actively blocking |
| Signup spike | `≥ 50 / 5min` | well above any real Saturday; distributed-abuse backstop |
| (retained) Projector IteratorAge | `> 5 min` | unchanged |
| (retained) Projector DLQ depth | `> 0` | unchanged — any poisoned record |
| (retained) Rebuild duration | `> 4 min` | unchanged — tripwire ahead of the 5-min timeout |

## Testing & gating

- `pnpm validate` green at every commit and at HEAD (the standing gate).
- **Application:** `Metrics` port injected into StartRound/FinalizeRound/ensureGolfer; use-case
  tests with a spy `Metrics` assert: emit fires once on success; does NOT fire on failure /
  idempotent replay; `Signups` fires ONLY on the ensureGolfer create branch (not the race-loser).
- **Lambda:** a `createEmfMetrics` unit test asserts a valid EMF envelope (namespace, Stage
  dimension, metric name/unit/value) and that the writer never throws on the happy path; a
  dispatcher test asserts the access-log line carries `{route, status, sub, latencyMs}` and omits
  `sub` on an `auth:"none"` route.
- **Stack (`swngStack.test.ts`):** the 10 noisy alarms are GONE (assert count / absence by logical
  id); the 5xx alarm now has `evaluationPeriods 3 / datapointsToAlarm 2 / threshold 10` and an OK
  action; the p95 alarm exists; `WafBlockedRequestsAlarm` + `SignupSpikeAlarm` exist; the
  `swng-ops-beta` dashboard exists with the expected widgets; DLQ/IteratorAge/RebuildDuration
  retained; SNS topic/subscription unchanged.
- `pnpm test:contract` if any adapter is touched (not expected — EMF is in the lambda composition
  root, not an adapter).
- **Close-out (controller-run, the established beta cycle):** `deploy:beta` (lambda code +
  stack) → **no `publish:web:beta`** (zero web change) → `e2e:beta` ×2 → `e2e:field` → an
  adversarial USE pass on the deployed surface: create/finalize a round and confirm `RoundsCreated`
  /`RoundsFinalized`/`Signups` appear in CloudWatch under `swng` namespace; the `swng-ops-beta`
  dashboard renders with data; `aws cloudwatch describe-alarms` shows the 10 noisy alarms gone and
  the new alarms present; the access-log line is queryable in Logs Insights.

## Deploy considerations

- **All additive / in-place.** Alarm deletes and reshapes, a new dashboard, two new alarms, EMF +
  access-log (both stdout — no new IAM, no `PutMetricData`). No DynamoDB/Cognito/secret resource is
  touched. `cdk diff` before deploy confirms no replacement.
- **Lambda code changes** (the `Metrics` port wiring + EMF + the dispatcher access-log line) ship
  in the lambda bundle → `deploy:beta` carries them. Deploy order is unconstrained (metrics are
  fire-and-forget; an old bundle emitting nothing, or a new stack with no metrics yet, both degrade
  to "no data on the dashboard," never an error).
- **No web change** → no `publish:web:beta`.
- **SNS email is still pending confirmation** (a human click after deploy). Flag it at close-out;
  it is not a code deliverable and does not gate the arc, but alarms won't reach the inbox until
  it's confirmed.

## Open items for the plan

- The exact dispatcher seam for the access-log line (where `route`/`status`/`sub`/`latencyMs` are
  all in scope) and whether the WS entries want the same line (recommendation: HTTP only — WS is
  connect/disconnect, low value; keep the arc focused).
- The precise `Metrics` port shape (`count(name, value?, dimensions?)`) and whether `dimensions`
  is needed now (recommendation: no — the three counters need only the `Stage` dimension, which the
  EMF writer bakes in; keep the port to `count(name)` and grow it if a real per-dimension need
  appears).
- The Logs Insights widget query strings (validated against the actual access-log field names once
  §3 lands) and the dashboard JSON layout.
- Confirm CDK's `HttpApi` exposes `metricLatency`/`metricClientError`/`metricServerError` at the
  pinned `aws-cdk-lib` version (Arc A bumped it) — else fall back to raw `Metric` over
  `AWS/ApiGateway`.
