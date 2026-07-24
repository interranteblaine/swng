# Prod-readiness Arc B — Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace swng-beta's 14 blip-noise alarms with a quiet, meaningful alarm set; add usage metrics (EMF) + a per-request access log + one ops dashboard so the owner is "not in the dark"; and consume the Arc A WAF metrics in an abuse-shape alarm.

**Architecture:** A new fire-and-forget `Metrics` port in `@swng/application` (peer of `Logger`), emitted at three business-success branches (round created / finalized / new golfer) and implemented as a hand-rolled EMF stdout writer in the lambda composition root. The dispatcher gains one structured access-log line per request. The CDK stack deletes the noisy alarms, reshapes/adds the HTTP alarms, adds two abuse alarms, and builds one CloudWatch dashboard. No wire/contract change; no web change.

**Tech Stack:** TypeScript (ESM, nodenext), Vitest, AWS CDK (aws-cdk-lib 2.262), CloudWatch (EMF + alarms + dashboard + Logs Insights), DynamoDB, API Gateway HTTP API v2.

## Global Constraints

- `pnpm validate` (lint + typecheck + build + test) MUST be green at every commit and at HEAD.
- Work stays on local `main`. NEVER push.
- The `Metrics` port is **fire-and-forget**: it MUST NOT throw into a use case (a metrics failure never fails a round).
- EMF namespace is exactly `swng`; the sole dimension is `Stage` (`beta`/`prod`).
- Metric names are exactly: `RoundsCreated`, `RoundsFinalized`, `Signups`.
- The access-log line is exactly `logger.info("request", { route, status, sub, latencyMs })`; `sub` is the Cognito subject on `golfer` routes only (opaque UUID, no PII) and is omitted otherwise.
- Final alarm set = **7** (kept: ProjectorIteratorAge, ProjectorDlqDepth, RebuildDuration; reshaped: HttpApi5xx; added: HttpApiP95Latency, WafBlockedRequests, SignupSpike). **10 deleted** (5 per-function `Errors≥1`, 5 per-table `Throttled≥1`).
- Alarm thresholds (named constants, beta-generous): 5xx `≥10`, `2 of 3` five-min windows; p95 `>3000ms`, `2 of 3`; WAF blocked `>100/5min`; signup spike `≥50/5min`. Retained: IteratorAge `>300000ms`, DLQ depth `>0`, Rebuild duration `>240000ms`.
- No `publish:web:beta` at close-out (zero web change). Deploy is `deploy:beta` carrying lambda code + stack together; deploy order is unconstrained (no wire changes — an old bundle emits no metrics, a new stack with no data yet renders an empty dashboard; neither errors).

---

### Task 1: The `Metrics` port + business-event emission (application layer)

**Files:**
- Create: `packages/application/src/ports/metrics.ts`
- Modify: `packages/application/src/index.ts` (barrel export)
- Modify: `packages/application/src/testing/fakes.ts` (null + capturing fakes) + its barrel exports in `index.ts`
- Modify: `packages/application/src/rounds/startRound.ts` (deps + emit)
- Modify: `packages/application/src/rounds/finalizeRound.ts` (deps + emit)
- Modify: `packages/application/src/golfers/ensureGolfer.ts` (deps + emit)
- Test: `packages/application/src/rounds/startRound.test.ts`, `finalizeRound.test.ts`, `golfers/ensureGolfer.test.ts`

**Interfaces:**
- Produces: `interface Metrics { count(name: string): void }` (exported from `@swng/application`); `createNullMetrics(): Metrics` and `createCapturingMetrics(): CapturingMetrics` (where `CapturingMetrics extends Metrics { readonly calls: readonly string[] }`), exported from the testing barrel.
- The three use-case `deps` objects gain an **optional** `metrics?: Metrics` member (optional so this task stays package-local and green — the lambda composition root injects the real sink in Task 2; existing test setups that omit it keep compiling).

- [ ] **Step 1: Write the port.** Create `packages/application/src/ports/metrics.ts`:

```ts
// A fire-and-forget business-metric sink (peer of Logger). Implementations MUST NOT throw —
// a metrics failure must never fail the use case it rides along with. The lambda composition
// root backs this with an EMF (CloudWatch Embedded Metric Format) stdout writer; tests use the
// null/capturing fakes. One method today (a monotonic event counter); grow it only when a real
// per-dimension or value-bearing need appears (YAGNI).
export interface Metrics {
  count(name: string): void;
}
```

- [ ] **Step 2: Export it from the barrel.** In `packages/application/src/index.ts`, beside `export type { Logger } from "./ports/logger.js";` (line ~19), add:

```ts
export type { Metrics } from "./ports/metrics.js";
```

- [ ] **Step 3: Add the test fakes.** In `packages/application/src/testing/fakes.ts`, next to `createNullLogger`/`createCapturingLogger` (~line 459), add:

```ts
export const createNullMetrics = (): Metrics => ({ count: () => {} });

// Records every count() call by metric name — the Metrics analogue of CapturingLogger, for the
// ONE assertion createNullMetrics can't make: that a use case actually emitted (and, on the
// replay/race-loser branches, did NOT).
export interface CapturingMetrics extends Metrics {
  readonly calls: readonly string[];
}

export const createCapturingMetrics = (): CapturingMetrics => {
  const calls: string[] = [];
  return {
    calls,
    count: (name) => {
      calls.push(name);
    },
  };
};
```

Add `Metrics` to the `import type { … } from "../ports/…"` / `@swng/application` type imports at the top of `fakes.ts` as the existing `Logger` import shows (match the file's existing import style). Then export the new symbols from `packages/application/src/index.ts`: add `createNullMetrics`, `createCapturingMetrics` to the value-export block (`export { … } from "./testing/fakes.js"`) and `CapturingMetrics` to the adjacent `export type { … }` block (mirror how `createNullLogger`/`CapturingLogger` are exported, ~lines 92-109).

- [ ] **Step 4: Wire the emit into `startRound`.** In `packages/application/src/rounds/startRound.ts`: add `import type { Metrics } from "../ports/metrics.js";` beside the `Logger` type import (~line 11); add `metrics?: Metrics;` to the `deps: { … }` object (~lines 30-46). Then emit right before the final `return` (the round has fully committed by then — `journal.append` at ~line 89, and `writePresence` is best-effort/never-throws). Change:

```ts
    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: host });

    return { roundId: id, joinCode, token, golferId: host };
```

to:

```ts
    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: host });

    deps.metrics?.count("RoundsCreated");
    return { roundId: id, joinCode, token, golferId: host };
```

- [ ] **Step 5: Wire the emit into `finalizeRound`.** In `packages/application/src/rounds/finalizeRound.ts`: add the `Metrics` type import; add `metrics?: Metrics;` to the deps object (~line 46). Emit ONLY on the genuine-finalize path — after `broadcast.publish`, before the return at ~line 88 — and NOT in the idempotent-replay branch (~lines 53-61). Change:

```ts
      await deps.broadcast.publish(claims.roundId, result.appended);
      return { results: archive.results, handicapping: archive.handicapping };
```

to:

```ts
      await deps.broadcast.publish(claims.roundId, result.appended);
      deps.metrics?.count("RoundsFinalized");
      return { results: archive.results, handicapping: archive.handicapping };
```

Do NOT add an emit to the `if (state.status === "final")` replay branch.

- [ ] **Step 6: Wire the emit into `ensureGolfer`.** In `packages/application/src/golfers/ensureGolfer.ts`: add the `Metrics` type import; add `metrics?: Metrics;` to the `deps: { golferStore; idGenerator; … }` object (~line 26). Emit ONLY on the genuine first-touch create — immediately after `bindSub` succeeds, inside the `try`, so a thrown `golfer-already-claimed` (the race-loser) skips it. Change:

```ts
    try {
      await deps.golferStore.bindSub(golfer.id, claims.sub);
    } catch (error) {
```

to:

```ts
    try {
      await deps.golferStore.bindSub(golfer.id, claims.sub);
      deps.metrics?.count("Signups");
    } catch (error) {
```

Do NOT emit on the `if (existing) return existing.golfer;` branch (already exists) or the catch/re-read (race-loser) branch.

- [ ] **Step 7: Write the failing emit tests.**

For `ensureGolfer.test.ts` (setup at ~lines 12-16), thread a capturing metrics and add three cases:

```ts
import { createCapturingMetrics } from "@swng/application"; // or the local testing import path used in this file

const setupMetrics = () => {
  const golferStore = createInMemoryGolferStore();
  const idGenerator = createSequentialIds("g");
  const metrics = createCapturingMetrics();
  return { golferStore, idGenerator, metrics, ensure: ensureGolfer({ golferStore, idGenerator, metrics }) };
};

it("emits Signups once on a genuine first-touch create", async () => {
  const { ensure, metrics } = setupMetrics();
  await ensure({ sub: "sub-new" });
  expect(metrics.calls).toEqual(["Signups"]);
});

it("does NOT emit Signups when the golfer already exists", async () => {
  const { ensure, metrics } = setupMetrics();
  await ensure({ sub: "sub-a" }); // create
  await ensure({ sub: "sub-a" }); // second touch — existing branch
  expect(metrics.calls).toEqual(["Signups"]); // still one, from the first create
});
```

(If this file already has a race-loser test — a `bindSub` throwing `golfer-already-claimed` then `getBySub` returning a winner — add `expect(metrics.calls).toEqual([])` to it, asserting the race-loser does NOT emit. If it doesn't, add one using an in-memory golfer store stub whose `bindSub` throws `new ApplicationError("golfer-already-claimed")` and whose `getBySub` returns a pre-seeded winner.)

For `finalizeRound.test.ts` (setup at ~lines 57-84), add `const metrics = createCapturingMetrics();`, pass `metrics` into the `finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids, metrics })` construction, return `metrics`, and add:

```ts
it("emits RoundsFinalized once on a genuine finalize, and not again on replay", async () => {
  const h = await setup();               // whatever the file's helper is; ensure it returns `metrics` + `finalize`
  // …drive a round to a finalizable state exactly as the existing finalize tests do…
  await h.finalize(participantClaims);   // genuine
  await h.finalize(participantClaims);   // idempotent replay
  expect(h.metrics.calls).toEqual(["RoundsFinalized"]); // exactly one — replay does not re-emit
});
```

For `startRound.test.ts`, mirror the same pattern (thread a capturing `metrics` into the file's `startRound({ … })` construction) and assert:

```ts
it("emits RoundsCreated once on a successful start", async () => {
  // …construct startRound with a capturing metrics via this file's harness…
  await start(validStartCommand, validAccountClaims);
  expect(metrics.calls).toEqual(["RoundsCreated"]);
});
```

- [ ] **Step 8: Run the tests, verify they fail.**

Run: `pnpm -F @swng/application vitest run src/golfers/ensureGolfer.test.ts src/rounds/finalizeRound.test.ts src/rounds/startRound.test.ts`
Expected: the new emit tests FAIL (metric not emitted / symbol not found) before Steps 4-6 are in; after implementing, they PASS.

- [ ] **Step 9: Run the full package + validate.**

Run: `pnpm -F @swng/application test` then `pnpm validate`
Expected: PASS (existing setups that omit `metrics` still compile — the dep is optional).

- [ ] **Step 10: Commit.**

```bash
git add packages/application/src
git commit -m "feat(application): Metrics port + emit RoundsCreated/RoundsFinalized/Signups at business-success branches"
```

---

### Task 2: EMF sink + stage plumbing + composition-root wiring (lambda + infra)

**Files:**
- Modify: `packages/lambda/src/compositionRoot.ts` (`createEmfMetrics`; read `STAGE`; wire `metrics` into the three use cases)
- Test: `packages/lambda/src/compositionRoot.test.ts` (EMF envelope unit test)
- Modify: `apps/infra-cdk/lib/swngStack.ts` (`STAGE` in `sharedEnv`)
- Modify: `apps/infra-cdk/test/swngStack.test.ts` (env-key assertions for http/wsConnect/wsDisconnect)

**Interfaces:**
- Consumes: `Metrics` from `@swng/application` (Task 1); the three use cases' optional `metrics?` dep.
- Produces: `createEmfMetrics(stage: string): Metrics` (exported from `compositionRoot.ts`, beside `createConsoleLogger`).

- [ ] **Step 1: Write the failing EMF unit test.** In `packages/lambda/src/compositionRoot.test.ts`, add:

```ts
import { createEmfMetrics } from "./compositionRoot.js";
import { vi } from "vitest";

it("createEmfMetrics writes a valid EMF envelope to stdout (namespace swng, Stage dimension, Count 1)", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    createEmfMetrics("beta").count("RoundsCreated");
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(payload._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: "swng",
      Dimensions: [["Stage"]],
      Metrics: [{ Name: "RoundsCreated", Unit: "Count" }],
    });
    expect(typeof payload._aws.Timestamp).toBe("number");
    expect(payload.Stage).toBe("beta");
    expect(payload.RoundsCreated).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

it("createEmfMetrics never throws", () => {
  expect(() => createEmfMetrics("beta").count("Signups")).not.toThrow();
});
```

- [ ] **Step 2: Run it, verify it fails.**

Run: `pnpm -F @swng/lambda vitest run src/compositionRoot.test.ts`
Expected: FAIL — `createEmfMetrics` not exported.

- [ ] **Step 3: Implement `createEmfMetrics`.** In `packages/lambda/src/compositionRoot.ts`, beside `createConsoleLogger` (~line 107), add — and add `Metrics` to the `@swng/application` type imports at the top of the file:

```ts
// EMF (CloudWatch Embedded Metric Format): a specially-shaped JSON line on stdout that
// CloudWatch auto-extracts into a metric — no PutMetricData call, no IAM, no async flush. The
// house-style hand-rolled analogue of createConsoleLogger. Fire-and-forget: a serialization
// failure must never bubble into the use case, so keep the payload to primitives (name is a
// literal, value is 1, Stage is a string). One `Stage` dimension keeps beta/prod metrics apart.
export const createEmfMetrics = (stage: string): Metrics => ({
  count: (name: string) => {
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{ Namespace: "swng", Dimensions: [["Stage"]], Metrics: [{ Name: name, Unit: "Count" }] }],
        },
        Stage: stage,
        [name]: 1,
      }),
    );
  },
});
```

- [ ] **Step 4: Read STAGE and build the sink in `buildApp`.** In `buildApp` (`compositionRoot.ts`), beside `const logger = createConsoleLogger();` (~line 245), add:

```ts
    const stage = env.STAGE ?? "beta";
    const metrics = createEmfMetrics(stage);
```

(`?? "beta"` so existing `compositionRoot.test.ts` env fixtures without `STAGE` stay green.)

- [ ] **Step 5: Inject `metrics` into the three use cases.** In the `UseCases` table (~lines 280-381), add `metrics` to the deps of `startRound`, `finalizeRound`, and `ensureGolfer` wherever each is constructed. E.g.:

```ts
      startRound: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore, metrics }),
```

and likewise `finalizeRound({ …, metrics })` and `ensureGolfer({ golferStore, idGenerator: ids, metrics })` (match each call's existing deps exactly; append `metrics`). Do NOT add `metrics` to any other use case.

- [ ] **Step 6: Add STAGE to the lambda environment.** In `apps/infra-cdk/lib/swngStack.ts`, in the `sharedEnv` object (~lines 456-462), add a `STAGE` key (`stage` is already in scope from `const stage = props.stage ?? "beta";` at ~line 196):

```ts
    const sharedEnv = {
      TABLE_ROUNDS: roundsTable.tableName,
      TABLE_CONNECTIONS: connectionsTable.tableName,
      TOKEN_SECRET_ARN: tokenSecret.secretArn,
      STAGE: stage,
    };
```

(This reaches HttpFunction/WsConnectFunction/WsDisconnectFunction — the three app-building functions. ProjectorFunction/RebuildFunction don't call `buildApp` and need no STAGE.)

- [ ] **Step 7: Update the affected env-key stack tests.** In `apps/infra-cdk/test/swngStack.test.ts`, the per-function env assertions for **HttpFunction, WsConnectFunction, WsDisconnectFunction** (the `sharedEnv` consumers, ~lines 261-374, and any shared `ENV_KEYS` constant ~line 13) now include `STAGE`. Add `"STAGE"` to each of those three functions' expected key sets. Leave ProjectorFunction/RebuildFunction assertions unchanged.

- [ ] **Step 8: Run tests + validate + synth.**

Run: `pnpm -F @swng/lambda test && pnpm -F @swng/infra-cdk test && pnpm validate`
Then: `pnpm -F @swng/infra-cdk exec cdk synth --quiet` (confirm no synth error).
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add packages/lambda apps/infra-cdk
git commit -m "feat(lambda,infra): EMF metrics sink + STAGE env; wire metrics into start/finalize/ensureGolfer"
```

---

### Task 3: Per-request access-log line (dispatcher)

**Files:**
- Modify: `packages/lambda/src/http/dispatch.ts` (`createDispatcher` — hoist + single `finally`)
- Test: `packages/lambda/src/http/dispatch.test.ts`

**Interfaces:**
- Consumes: the existing `logger: Logger` already passed to `createDispatcher`.
- Produces: one `logger.info("request", { route, status, sub, latencyMs })` per request.

- [ ] **Step 1: Write the failing test.** In `packages/lambda/src/http/dispatch.test.ts`, using the file's existing route/tokens/verifier harness, add a capturing-info logger and assert the access line. (The existing `createNullLogger` swallows `info`; build an inline logger that records it.)

```ts
it("logs one structured access line per request with route, status, sub, latencyMs", async () => {
  const infos: { message: string; data?: Record<string, unknown> }[] = [];
  const logger: Logger = { info: (m, d) => infos.push({ message: m, data: d }), warn: () => {}, error: () => {} };
  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, verifier, logger);
  // …drive a successful GOLFER-authed request through the harness (a valid bearer the test's
  // `verifier` accepts, returning a known sub, e.g. "sub-123")…
  const res = await dispatcher(golferAuthedEvent);
  const line = infos.find((l) => l.message === "request");
  expect(line).toBeDefined();
  expect(line!.data).toMatchObject({ route: expect.stringMatching(/^[A-Z]+ \//), status: Number(res.statusCode) });
  expect(line!.data!.sub).toBe("sub-123");
  expect(typeof line!.data!.latencyMs).toBe("number");
});

it("omits sub on an auth:none route and logs route 'not-found' for an unmatched path", async () => {
  const infos: { message: string; data?: Record<string, unknown> }[] = [];
  const logger: Logger = { info: (m, d) => infos.push({ message: m, data: d }), warn: () => {}, error: () => {} };
  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, verifier, logger);
  await dispatcher(anAuthNoneEvent);
  await dispatcher(anUnmatchedPathEvent); // e.g. GET /no/such/route
  const noneLine = infos.find((l) => l.message === "request" && l.data!.route !== "not-found");
  expect(noneLine!.data!.sub).toBeUndefined();
  const missLine = infos.find((l) => l.message === "request" && l.data!.route === "not-found");
  expect(missLine).toBeDefined();
  expect(missLine!.data!.status).toBe(404);
});
```

(Reuse whatever `buildRoutes`, `tokens`, `verifier`, and event-builders the existing tests in this file already define; the `verifier` stub's returned `sub` is the value asserted.)

- [ ] **Step 2: Run it, verify it fails.**

Run: `pnpm -F @swng/lambda vitest run src/http/dispatch.test.ts`
Expected: FAIL — no `"request"` line is logged.

- [ ] **Step 3: Restructure `createDispatcher` for a single `finally`.** Make ONLY these surgical changes to the returned async function (`dispatch.ts:66-160`). **Preserve every existing comment and the three auth blocks verbatim** — do not rewrite them.

(a) At the top of the async function, replace:

```ts
  async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    try {
```

with:

```ts
  async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const startedAt = Date.now();
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    // Hoisted above the try so the finally's one access-log line names the matched route and the
    // authenticated subject on EVERY exit (404 / success / mapped-error). Observability (Arc B).
    let route: Route | undefined;
    let account: AccountClaims | undefined;
    let status = 500;

    try {
```

(b) Inside the try, the route-matching block currently declares `let route: Route | undefined;` (line 76) — DELETE that inner declaration (keep `let pathParams`), so the loop assigns the hoisted `route`. In the golfer block, the line `let account: AccountClaims | undefined;` (line 131) is now the hoisted one — DELETE the inner `let account: AccountClaims | undefined;` declaration line, keeping the `if (route.auth === "golfer") { … account = await verifier.verify(...) … }` block that assigns it.

(c) The 404 return — replace:

```ts
        const { statusCode, body } = jsonResponse(404, { code: "not-found", message: `no route for ${method} ${path}` });
        return { statusCode, headers: { "content-type": "application/json" }, body };
```

with:

```ts
        const notFound = jsonResponse(404, { code: "not-found", message: `no route for ${method} ${path}` });
        status = notFound.statusCode;
        return { statusCode: notFound.statusCode, headers: { "content-type": "application/json" }, body: notFound.body };
```

(d) The success return — replace:

```ts
      const result = await route.handler(ctx, body);
      return { statusCode: route.successStatus, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
```

with:

```ts
      const result = await route.handler(ctx, body);
      status = route.successStatus;
      return { statusCode: route.successStatus, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
```

(e) The catch + a new finally — replace:

```ts
    } catch (error) {
      const { statusCode, body } = toHttpError(error, logger);
      return { statusCode, headers: { "content-type": "application/json" }, body };
    }
  };
```

with:

```ts
    } catch (error) {
      const mapped = toHttpError(error, logger);
      status = mapped.statusCode;
      return { statusCode: mapped.statusCode, headers: { "content-type": "application/json" }, body: mapped.body };
    } finally {
      // One structured line per request → CloudWatch Logs Insights: DAU (count_distinct sub),
      // requests-by-route, 4xx/5xx-by-route. `sub` is the Cognito subject on golfer routes only
      // (opaque UUID, no PII); omitted elsewhere. Runs on all three exits; never throws into the
      // request path (logger.info is a plain console write).
      logger.info("request", {
        route: route ? `${route.method} ${route.path}` : "not-found",
        status,
        sub: account?.sub,
        latencyMs: Date.now() - startedAt,
      });
    }
  };
```

- [ ] **Step 4: Run the tests, verify they pass.**

Run: `pnpm -F @swng/lambda vitest run src/http/dispatch.test.ts` then `pnpm validate`
Expected: PASS (existing dispatch tests use `createNullLogger`, which swallows the new info line — none of them break).

- [ ] **Step 5: Commit.**

```bash
git add packages/lambda/src/http/dispatch.ts packages/lambda/src/http/dispatch.test.ts
git commit -m "feat(lambda): one structured access-log line per request (route/status/sub/latency)"
```

---

### Task 4: Alarm-set rework (CDK)

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (alarms block ~730-883)
- Test: `apps/infra-cdk/test/swngStack.test.ts` (alarms suite ~895-991)

**Interfaces:**
- Consumes: in-scope `alarmsTopic`, `paged`, `FIVE_MINUTES`, `httpApi` (L2 `HttpApi` — `metricServerError`/`metricLatency` available), `projectorFn`, `rebuildFn`, `projectorDlq`, `stage`; the `Signups` EMF metric name (Task 1) and the WAF metric names (`swng-waf-cf-${stage}`, `swng-waf-cognito-${stage}`, Arc A).

- [ ] **Step 1: Update the failing stack tests first.** In `swngStack.test.ts`:
  - Change the alarm-count assertion (~lines 896-897) from `14` to `7`, and update its description to `(3 retained: IteratorAge + DLQ depth + Rebuild duration; reshaped: HTTP 5xx; added: HTTP p95 latency + WAF blocked + signup spike)`.
  - Change the "every alarm targets AlarmsTopic" test's `expect(alarmEntries.length).toBe(14)` (~line 907) to `7`.
  - DELETE the table-throttle test (~lines 956-969) and any per-function `ErrorsAlarm` test (the deleted alarms).
  - Change the HTTP 5xx test (~lines 925-934) to assert the reshaped alarm: `Threshold: 10`, `EvaluationPeriods: 3`, `DatapointsToAlarm: 2` (keep `Namespace: "AWS/ApiGateway"`, `MetricName: "5xx"`, `Statistic: "Sum"`, `ComparisonOperator: "GreaterThanOrEqualToThreshold"`).
  - ADD three tests:

```ts
it("the HTTP API p95-latency alarm: AWS/ApiGateway Latency, p95, > 3000ms, 2 of 3", () => {
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    Namespace: "AWS/ApiGateway",
    MetricName: "Latency",
    ExtendedStatistic: "p95",
    Threshold: 3000,
    EvaluationPeriods: 3,
    DatapointsToAlarm: 2,
    ComparisonOperator: "GreaterThanThreshold",
  });
});

it("the WAF blocked-requests alarm: a math expression over AWS/WAFV2 BlockedRequests, threshold 100", () => {
  const alarms = template.findResources("AWS::CloudWatch::Alarm");
  const waf = Object.values(alarms).filter((a) =>
    (a.Properties.AlarmDescription as string | undefined)?.includes("blocked"),
  );
  expect(waf).toHaveLength(1);
  expect(waf[0]!.Properties.Threshold).toBe(100);
  expect(Array.isArray(waf[0]!.Properties.Metrics)).toBe(true); // math expression → Metrics[]
});

it("the signup-spike alarm: swng namespace Signups, threshold 50", () => {
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    Namespace: "swng",
    MetricName: "Signups",
    Statistic: "Sum",
    Threshold: 50,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail.**

Run: `pnpm -F @swng/infra-cdk vitest run test/swngStack.test.ts`
Expected: FAIL (count still 14; new alarms absent).

- [ ] **Step 3: Add the recovery-notifying helper.** In `swngStack.ts`, beside `paged` (~line 742), add:

```ts
    // Like paged(), but also notifies on return-to-OK — for the sustained HTTP alarms where
    // "it recovered on its own" is information the owner wants (not so for DLQ/IteratorAge, which
    // need a human-run rebuild/redrive and stay alarm-only).
    const pagedWithRecovery = (alarm: Alarm): Alarm => {
      alarm.addAlarmAction(new SnsAction(alarmsTopic));
      alarm.addOkAction(new SnsAction(alarmsTopic));
      return alarm;
    };
```

- [ ] **Step 4: Delete the 10 noisy alarms.** Remove entirely: the `alarmedFunctions` array + its `for` loop (~lines 752-770), and the `THROTTLEABLE_OPERATIONS` array + `alarmedTables` array + its `for` loop (~lines 855-883). If lint then flags an unused `Operation` import (from `aws-cdk-lib/aws-dynamodb`), remove it. Keep `alarmsTopic`, the email subscription, `paged`, `FIVE_MINUTES`, and the IteratorAge/DLQ/RebuildDuration alarms untouched.

- [ ] **Step 5: Reshape the 5xx alarm.** Replace the `HttpApi5xxAlarm` block (~lines 775-784) with:

```ts
    // Non-transient 5xx: sustained server errors, not a single deploy blip. 2 of the last 3
    // five-minute windows each at >= 10 5xx. OK-notifying so the owner learns when it recovers.
    pagedWithRecovery(
      new Alarm(this, "HttpApi5xxAlarm", {
        alarmDescription: "HTTP API: >= 10 5xx responses in 2 of the last 3 five-minute windows (sustained server errors)",
        metric: httpApi.metricServerError({ period: FIVE_MINUTES, statistic: "Sum" }),
        threshold: 10,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
```

- [ ] **Step 6: Add the p95-latency alarm.** Immediately after the 5xx alarm, add:

```ts
    // p95 latency > 3s, 2 of 3 windows. API Gateway emits Latency for free; no latency alarm
    // existed before Arc B. OK-notifying, same rationale as the 5xx alarm.
    pagedWithRecovery(
      new Alarm(this, "HttpApiP95LatencyAlarm", {
        alarmDescription: "HTTP API: p95 latency over 3000ms in 2 of the last 3 five-minute windows",
        metric: httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p95" }),
        threshold: 3000,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
```

- [ ] **Step 7: Add the two abuse alarms.** After the RebuildDuration alarm (~line 838), add — and add `MathExpression` to the `aws-cdk-lib/aws-cloudwatch` import (line 3):

```ts
    // --- Abuse-shape alarms (Arc B) -------------------------------------------------------
    //
    // Two cheap signals for the account -> crew -> round abuse chain. (1) The WAF is actively
    // blocking a flood right now (reads the Arc A rate-rule metrics — no app code). (2) A signup
    // burst that stays under the per-IP WAF rate (reads the Signups EMF metric).
    const wafBlocked = (webAcl: string, region: string): Metric =>
      new Metric({
        namespace: "AWS/WAFV2",
        metricName: "BlockedRequests",
        // Region is "Global" for the CLOUDFRONT-scope ACL, "us-east-1" for the REGIONAL one;
        // Rule "ALL" is the ACL-level aggregate. VERIFY at close-out (WAF metric dimensions are a
        // known gotcha) — if the widget/alarm shows no data under a real block, correct Region.
        dimensionsMap: { WebACL: webAcl, Region: region, Rule: "ALL" },
        period: FIVE_MINUTES,
        statistic: "Sum",
      });
    paged(
      new Alarm(this, "WafBlockedRequestsAlarm", {
        alarmDescription: "WAF: over 100 requests blocked by the rate rules in 5 minutes — a flood is in progress",
        metric: new MathExpression({
          expression: "cf + cognito",
          usingMetrics: {
            cf: wafBlocked(`swng-waf-cf-${stage}`, "Global"),
            cognito: wafBlocked(`swng-waf-cognito-${stage}`, "us-east-1"),
          },
          period: FIVE_MINUTES,
        }),
        threshold: 100,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
    paged(
      new Alarm(this, "SignupSpikeAlarm", {
        alarmDescription: "Signups: 50 or more new golfer accounts in 5 minutes — a possible account-creation abuse spike",
        metric: new Metric({
          namespace: "swng",
          metricName: "Signups",
          dimensionsMap: { Stage: stage },
          period: FIVE_MINUTES,
          statistic: "Sum",
        }),
        threshold: 50,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
```

- [ ] **Step 8: Run tests + validate + synth.**

Run: `pnpm -F @swng/infra-cdk vitest run test/swngStack.test.ts && pnpm validate`
Then: `pnpm -F @swng/infra-cdk exec cdk synth --quiet`
Expected: PASS; 7 alarms in the template.

- [ ] **Step 9: Commit.**

```bash
git add apps/infra-cdk
git commit -m "feat(infra): rework alarms — drop 10 blip-pagers, non-transient 5xx+p95, WAF+signup abuse alarms"
```

---

### Task 5: Ops dashboard (CDK)

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (dashboard, after the alarms block)
- Test: `apps/infra-cdk/test/swngStack.test.ts`

**Interfaces:**
- Consumes: `stage`, `httpApi`, `projectorFn`, `projectorDlq`, `httpFn` (its `.logGroup`), the `swng` EMF metrics, the WAF metrics.

- [ ] **Step 1: Write the failing dashboard test.** In `swngStack.test.ts`, add:

```ts
describe("ops dashboard (Arc B)", () => {
  it("creates exactly one dashboard named swng-ops-<stage>", () => {
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardName: Match.stringLikeRegexp("swng-ops-beta"),
    });
  });

  it("the dashboard body references the business metrics and the DAU query", () => {
    template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardBody: Match.stringLikeRegexp("RoundsCreated"),
    });
    template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardBody: Match.stringLikeRegexp("activeGolfers"),
    });
  });
});
```

- [ ] **Step 2: Run it, verify it fails.**

Run: `pnpm -F @swng/infra-cdk vitest run test/swngStack.test.ts`
Expected: FAIL — no dashboard.

- [ ] **Step 3: Add the dashboard imports.** Extend the `aws-cdk-lib/aws-cloudwatch` import (line 3) to include `Dashboard`, `GraphWidget`, `LogQueryWidget`.

- [ ] **Step 4: Build the dashboard.** After the abuse alarms (end of the alarms/abuse block), add:

```ts
    // --- Ops dashboard (Arc B) ------------------------------------------------------------
    //
    // One pane: "how's swng doing." Business volumes (EMF), HTTP latency/errors, projector
    // health, WAF, and a Logs Insights widget over the http access log for DAU + per-route.
    const swngCount = (name: string): Metric =>
      new Metric({ namespace: "swng", metricName: name, dimensionsMap: { Stage: stage }, period: Duration.days(1), statistic: "Sum" });

    const dashboard = new Dashboard(this, "OpsDashboard", { dashboardName: `swng-ops-${stage}` });
    dashboard.addWidgets(
      new GraphWidget({
        title: "Business — rounds & signups (daily)",
        left: [swngCount("RoundsCreated"), swngCount("RoundsFinalized"), swngCount("Signups")],
        width: 12,
      }),
      new GraphWidget({
        title: "HTTP latency (p50/p95/p99)",
        left: [
          httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p50" }),
          httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p95" }),
          httpApi.metricLatency({ period: FIVE_MINUTES, statistic: "p99" }),
        ],
        width: 12,
      }),
      new GraphWidget({
        title: "HTTP errors (4xx / 5xx)",
        left: [
          httpApi.metricClientError({ period: FIVE_MINUTES, statistic: "Sum" }),
          httpApi.metricServerError({ period: FIVE_MINUTES, statistic: "Sum" }),
        ],
        width: 12,
      }),
      new GraphWidget({
        title: "Projector health",
        left: [
          new Metric({ namespace: "AWS/Lambda", metricName: "IteratorAge", dimensionsMap: { FunctionName: projectorFn.functionName }, period: FIVE_MINUTES, statistic: "Maximum" }),
        ],
        right: [projectorDlq.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: "Maximum" })],
        width: 12,
      }),
      new GraphWidget({
        title: "WAF (blocked requests)",
        left: [wafBlocked(`swng-waf-cf-${stage}`, "Global"), wafBlocked(`swng-waf-cognito-${stage}`, "us-east-1")],
        width: 12,
      }),
      new LogQueryWidget({
        title: "Unique active golfers (24h) + requests by route",
        logGroupNames: [httpFn.logGroup.logGroupName],
        queryLines: [
          'filter message = "request"',
          "stats count_distinct(sub) as activeGolfers, count(*) as requests by route",
          "sort requests desc",
        ],
        width: 24,
      }),
    );
```

(`wafBlocked` is the helper defined in Task 4; keep it in scope — it's declared before this block. `httpFn.logGroup` references the CDK-managed log group the `useCdkManagedLogGroup` flag already creates — confirmed present in the committed synth.)

- [ ] **Step 5: Run tests + validate + synth + confirm no unexpected resource delta.**

Run: `pnpm -F @swng/infra-cdk vitest run test/swngStack.test.ts && pnpm validate`
Then: `pnpm -F @swng/infra-cdk exec cdk synth --quiet` and eyeball that the only new resources are the dashboard (and, if `httpFn.logGroup` materialized one, an `AWS::Logs::LogGroup` — additive/in-place either way). If a log group appears newly and any resource-count test breaks, update that test.

- [ ] **Step 6: Commit.**

```bash
git add apps/infra-cdk
git commit -m "feat(infra): swng-ops dashboard — business/latency/errors/projector/WAF + DAU Logs Insights"
```

---

## Close-out (controller-run, after all tasks + the whole-branch review)

1. Whole-branch review (superpowers:requesting-code-review) on the full Arc B diff — dispatched on the most capable model.
2. `pnpm validate` green at HEAD; `pnpm test:contract`.
3. `cdk diff` — confirm additive/in-place ONLY (new alarms/dashboard, `STAGE` env add, deleted alarms; no table/pool/secret/API replacement).
4. `deploy:beta` — one deploy carries the lambda code (EMF + access log) + the stack (STAGE env, alarm rework, dashboard). Deploy order unconstrained (no wire change).
5. **No `publish:web:beta`** (zero web change).
6. `e2e:beta` ×2, `e2e:field` — the field/e2e suites mint and use real tokens and drive create → score → finalize, exercising the emit points + access log against the deployed lambda (regression backstop that the dispatcher restructure preserved behavior).
7. Adversarial USE pass on the deployed surface:
   - create + finalize a round, mint a new golfer → confirm `RoundsCreated`/`RoundsFinalized`/`Signups` appear under the `swng` CloudWatch namespace (`aws cloudwatch list-metrics --namespace swng`).
   - the `swng-ops-beta` dashboard renders (and the DAU/route Logs Insights widget returns rows once traffic exists).
   - `aws cloudwatch describe-alarms` shows exactly the 7 alarms — the 10 noisy ones gone, p95 + WAF + signup present.
   - the access-log line is queryable in Logs Insights (`filter message = "request" | stats count(*) by route`).
   - **Confirm the WAF metric Region dimension** (`Global` vs `us-east-1`) resolves to real data if a block is generated; correct if the widget/alarm is empty.
8. Flag (not a code deliverable): the SNS alarm email is still **pending the owner's confirmation click** — alarms won't reach the inbox until confirmed.

## Self-review notes

- Spec coverage: alarm rework → T4; p95 → T4; usage metrics/EMF → T1+T2; access log/DAU → T3+T5; abuse alarms → T4; dashboard → T5; the `Stage` dimension + STAGE plumbing → T2.
- Deferred by design (NOT here): prod alarm email + 5xx-as-a-ratio (Arc C); X-Ray; per-account caps; log-retention change.
- The `Metrics` dep is **optional** deliberately — it decouples the application task (T1, package-local green) from the composition-root wiring (T2), and "absent" is the ultimate fire-and-forget no-throw. The composition root always injects the real EMF sink (T2); the close-out USE pass proves metrics actually flow.
- Every commit stays green: T1 optional dep keeps existing setups compiling; T2 `STAGE ?? "beta"` keeps existing env fixtures green; T3 uses `createNullLogger` (swallows the new info line) so existing dispatch tests don't break.
