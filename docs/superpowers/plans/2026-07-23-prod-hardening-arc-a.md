# Prod-readiness Arc A — App hardening: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the prod-blocking and should-fix security gaps that can be built and verified on
`swng-beta`, per the design at
`docs/superpowers/specs/2026-07-23-prod-hardening-arc-a-design.md` and the findings at
`docs/superpowers/specs/2026-07-23-prod-readiness-security-findings.md`.

**Architecture:** swng is a pnpm monorepo (Node 20, ESM). Golf/domain logic lives in
`@swng/domain`; wire schemas in `@swng/contracts`; use cases in `@swng/application`; the Lambda
dispatcher + composition root in `@swng/lambda`; the CDK stack in `apps/infra-cdk`. This arc
touches contracts (bounds), domain (crew cap, index-history algorithm), lambda (join codes,
secret fetch), and the CDK stack (WAF, headers, CORS, PITR, secret plumbing).

**Tech Stack:** TypeScript (nodenext — relative imports carry `.js`), Zod, Vitest (happy-dom for
web), aws-cdk-lib, aws-jwt-verify, @aws-sdk/* (server only, never imported by web).

## Global Constraints

- **`pnpm validate` green at every commit AND at HEAD** (lint + typecheck + build + test — the CI
  gate). `pnpm test:contract` where an adapter changes. Run tooling with `env -u NODE_OPTIONS`.
- **TDD:** every behavior change lands test-first (write failing test → run it fails → implement →
  run it passes → commit).
- **nodenext:** relative imports MUST carry the `.js` extension (typecheck enforces; build/vitest
  do not — a missing `.js` fails `pnpm validate` only).
- **The compute fence:** `apps/web/src` may not import golf-compute from `@swng/domain` directly
  (ESLint `no-restricted-imports`). No web change in this arc should reach past `@swng/client`.
- **Tolerate old stored data:** deserialization must not throw on pre-existing beta rows. Beta is
  disposable (no prod pool yet), so a *forward-only* bound (reject new over-cap input) needs no
  migration — but confirm no live beta row already violates a new cap before enforcing (Task 1).
- **Layering:** golf rules live in `@swng/domain`; the UI renders. Do NOT push a presentation
  constant into the domain (see the index-history task).
- **Deploy is controller-run** (the established beta cycle): `deploy:beta`, `publish:web:beta`,
  `e2e:beta`, `e2e:field`. Work stays on local `main`; NEVER push. NEVER touch stacks named
  `InfraCdkStack-*` (the SwngStack constructor throws on those).
- **Deploy order (Task 4):** the token secret's VALUE is unchanged (same Secrets Manager secret) —
  only its delivery changes — so live participant tokens keep verifying across the cutover. The
  Lambda must have `secretsmanager:GetSecretValue` before it first fetches; a single `deploy:beta`
  grants + switches together. `cdk diff` before deploy must show in-place updates only (no table,
  pool, or client replacement).

**Task order:** 1 → 8 are independent enough to review separately; recommended order is pure-code
first (1, 2, 3, 8), then stack (4, 5, 6, 7). Task 4 (secret) is the one with deploy-order care.

---

### Task 1: Usage & length bounds — contracts `.max()` at the wire ingress ONLY

**Files:**
- Modify: `packages/contracts/src/commands.ts`, `packages/contracts/src/courses.ts`,
  `packages/contracts/src/golfers.ts`, `packages/contracts/src/round.ts` (games/players arrays)
- Test: co-located `*.test.ts` beside each

**Interfaces:**
- Produces: no signature changes — every field keeps its type; only its REQUEST-schema validation
  tightens.

**Placement rule (load-bearing — owner, 2026-07-23):** these bounds go on **request** schemas
only (the wire ingress). They must NOT be added to response/read schemas and must NOT gate any
fold/deserialization path — a limit that rejects *stored* data bricks a legitimate user's own
data, which is worse than the DoS it would prevent. Input hygiene lives at ingress; reads tolerate
whatever is already stored.

**NO crew-size cap.** An earlier draft added a hard `MAX_CREW_MEMBERS` cap in the domain
(`addMember`). It is dropped: it is a *product* limit (it would reject a legitimate large crew's
next member) masquerading as a DoS defense, and the abuse it targeted — a giant crew — is already
choked upstream by WAF on account creation (every member is an account accepting an invite). The
real concern, `getSeasonStandings` issuing one query per member, is a **read-cost** matter; if a
legitimate crew ever grows large enough to matter, bound it at the read (batch/paginate the
standings), never by capping membership. Not in scope for this arc.

**The bounds to apply** (every user-supplied string gets `.max()`; every user-supplied array gets
`.max()` — the principle is "bound every user-controlled count and length"):

| File / schema | Field | Change |
|---|---|---|
| commands.ts `startRoundRequestSchema` | `host.tee` | `.min(1)` → `.min(1).max(40)` |
| commands.ts | `host.courseHandicap` | `.int()` → `.int().min(-10).max(54)` |
| commands.ts `joinRoundRequestSchema` | `code` | `.length(6)` → `.length(6).regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)` |
| commands.ts | `tee` | `.min(1)` → `.min(1).max(40)` |
| commands.ts | `courseHandicap` | `.int()` → `.int().min(-10).max(54)` |
| commands.ts `recordScoreRequestSchema` | `hole` | `.min(1)` → `.min(1).max(18)` |
| commands.ts `setHandicapRequestSchema` | `courseHandicap` | `.int()` → `.int().min(-10).max(54)` |
| round.ts (holeResult strokes) | stroke count | bound to `.min(1).max(30)` (read the schema) |
| round.ts (game config) | players arrays per game | `.max(12)` |
| courses.ts `newTeeInputSchema` | `name` | `.min(1).max(40)` |
| courses.ts `newTeeInputSchema` | `holes` array | `.min(1)` → `.min(1).max(18)` |
| courses.ts create/supersede | top-level `name` | `.min(1).max(80)` |
| courses.ts create/supersede | `teeSets` array | `.min(1)` → `.min(1).max(12)` |
| golfers.ts `updateMeRequestSchema` | `name` | `.min(1)` → `.min(1).max(60)` |

(Crew and season names are ALREADY bounded to 60 in the domain — `crew.ts:34`,
`createSeason.ts`/`updateSeason.ts` — leave those; they are the pattern this task extends. Those
existing domain name-validators run on WRITE only, not on the crew store's read path, so they are
the safe kind — do not add anything analogous on a read/fold.)

- [ ] **Step 1: Write failing tests** for representative rejections — e.g. in
  `packages/contracts/src/commands.test.ts`:

```ts
it("rejects an over-long tee name", () => {
  expect(() => parse(startRoundRequestSchema, {
    course: { courseId: "c", cardId: "d" },
    host: { tee: "x".repeat(41), courseHandicap: 10 },
  })).toThrow();
});

it("rejects a join code with a character outside the safe alphabet", () => {
  expect(() => parse(joinRoundRequestSchema, { code: "ABC0O1", tee: "White", courseHandicap: 10 }))
    .toThrow(); // 0/O/1 are excluded from the join-code alphabet
});

it("rejects a course-handicap outside [-10, 54]", () => {
  expect(() => parse(setHandicapRequestSchema, { golferId: "g", courseHandicap: 99 })).toThrow();
});
```

- [ ] **Step 2: Run the tests, verify they fail.**
  `env -u NODE_OPTIONS pnpm -F @swng/contracts vitest run src/commands.test.ts` (and the courses/
  golfers/round schema test files for their fields).

- [ ] **Step 3: Apply the bounds table** across the four contract files. Read each request schema,
  add the `.max()`/`.regex()` per the table above. Nothing in the domain or on any response/read
  schema changes (see the placement rule — no read-path gating, no crew cap).

- [ ] **Step 4: Run the tests, verify they pass**, then `pnpm validate`.

- [ ] **Step 5: Commit.** `git commit -m "feat(contracts): bound every user-controlled request length and count at the wire ingress"`

---

### Task 2: Cryptographic join codes

**Files:**
- Modify: `packages/lambda/src/compositionRoot.ts` (`createRandomIds`)
- Test: `packages/lambda/src/compositionRoot.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: `newJoinCode()` unchanged signature; only the RNG source
  changes from `Math.random()` to `crypto.randomInt`.

The wire-side alphabet validation on `code` already landed in Task 1 (the regex). This task fixes
the *generator*.

- [ ] **Step 1: Write a failing test** asserting the generator draws only from the safe alphabet
  and (as a proxy for "not Math.random") is a fixed length from the known alphabet:
```ts
it("mints a 6-char join code from the unambiguous alphabet only", () => {
  const ids = createRandomIds();
  for (let i = 0; i < 200; i += 1) {
    const code = ids.newJoinCode();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  }
});
```
  (`createRandomIds` is module-private today — export it for the test, mirroring how
  `createConsoleLogger` is already exported for `compositionRoot.test.ts`.)

- [ ] **Step 2: Run it** — it passes for format already, so ALSO add a guard test that the
  generator does not call `Math.random` (spy on it):
```ts
it("does not use Math.random for join codes", () => {
  const spy = vi.spyOn(Math, "random");
  createRandomIds().newJoinCode();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
```
  Run: this fails against the current `Math.random` implementation.

- [ ] **Step 3: Switch to a CSPRNG:**
```ts
import { randomInt, randomUUID } from "node:crypto";

const createRandomIds = (): IdGenerator => ({
  newId: () => randomUUID(),
  // crypto.randomInt is a CSPRNG — a join code is a capability (it lets someone onto a round),
  // so it must not come from Math.random's predictable PRNG.
  newJoinCode: () =>
    Array.from({ length: JOIN_CODE_LENGTH }, () => JOIN_CODE_ALPHABET.charAt(randomInt(JOIN_CODE_ALPHABET.length))).join(""),
});
```

- [ ] **Step 4: Run the tests, verify they pass**, then `pnpm validate`.

- [ ] **Step 5: Commit.** `git commit -m "fix(lambda): mint join codes with a CSPRNG, not Math.random"`

---

### Task 3: Bound the index-over-time series to O(N) — a single forward pass

**Files:**
- Modify: `packages/domain/src/golfer/metrics.ts` (`golferMetrics`'s `indexHistory`)
- Test: `packages/domain/src/golfer/metrics.test.ts`

**Interfaces:**
- Produces: `golferMetrics` unchanged signature/return shape; `indexHistory` is the SAME values,
  computed in O(N) instead of O(N²). The headline `whsIndex`/`swngIndex` is unchanged.

**Why (see spec §3):** today `indexHistory` re-derives the index over the whole career-prefix for
every round (`lines.slice(0, k + 1)` per round) — O(N²) on `GET /me/record` and `GET /golfers/{id}`.
The index only ever uses the last 20 *combined differentials*; the fix is one forward pass keeping
a rolling window. **A naive last-N-lines slice is wrong** because 9-hole rounds pair into
differentials (`whs.ts:144`) and a pending 9 can reach back across any window — so the pass must
maintain the pairing state across the whole record.

- [ ] **Step 1: Write failing/guard tests** in `metrics.test.ts`:
```ts
// Behavior-preserving: the new O(N) indexHistory must equal the old per-prefix computation,
// INCLUDING a 9-hole-heavy record where a naive line-window would diverge.
it("indexHistory matches a per-prefix recompute, including 9-hole pairing", () => {
  const lines = /* build ≥25 lines: a mix of 18s and 9s, incl. an unpaired 9 early that pairs late */;
  const viaPass = golferMetrics(lines).indexHistory;
  const viaPrefix = lines.map((line, k) => {
    const d = detailsOfForTest(lines.slice(0, k + 1)); // the OLD prefix computation, kept in the test only
    return { roundId: line.roundId, ...(d.swng ? { swngIndex: d.swng.value } : {}), ...(d.whs ? { whsIndex: d.whs.value } : {}) };
  });
  expect(viaPass).toEqual(viaPrefix);
});

it("the headline index equals the last indexHistory point", () => {
  const m = golferMetrics(lines);
  const last = m.indexHistory.at(-1);
  expect(m.swngIndex?.value).toBe(last?.swngIndex);
  expect(m.whsIndex?.value).toBe(last?.whsIndex);
});
```
  (Keep a small `detailsOfForTest` helper in the test file that reproduces the current
  whole-prefix `detailsOf` — it is the oracle the O(N) pass is verified against.)

- [ ] **Step 2: Run the tests** — the equality test passes today (same result), so this task is a
  refactor guarded by equality. Add a shape assertion that FAILS today only if you also assert the
  algorithm doesn't re-slice the prefix — skip that; rely on the equality oracle + a perf note.
  Confirm the oracle tests are green against the current code first (they must be, since the values
  don't change), so any regression the refactor introduces turns them red.

- [ ] **Step 3: Rewrite `indexHistory` as a single forward pass.** Replace the
  `lines.map((line, k) => detailsOf(lines.slice(0, k + 1)))` with a pass that maintains, per
  stream, a running list of combined differentials and the 9-hole pairing state, and emits each
  round's point from the current last-20:
```ts
// One forward pass over the rounds (oldest → newest). The index only ever uses the last 20
// COMBINED differentials (WHS Rule 5.2a; combineNineHoleDifferentials, whs.ts), so we keep a
// running combined-differential list per stream and read its last 20 at each round — O(N) total,
// and correct across 9-hole pairing (a pending 9 is carried forward, never dropped by a window).
// WHS stream = rated lines only (differential !== undefined); swng stream = every ags line
// (differential ?? ags - par). This is the honest complete series; how much a view SHOWS (the
// chart's last 20 points) is the view's concern, not this function's.
const indexHistory: IndexPoint[] = [];
const whs = createCombinedStream(); // {pending?: number, combined: number[]}
const swng = createCombinedStream();
for (const line of lines) {
  if (line.differential !== undefined) feed(whs, line.differential, line.holes);
  if (line.ags !== undefined) feed(swng, line.differential ?? line.ags - line.par, line.holes);
  const w = computeIndexDetail(whs.combined);   // computeIndexDetail already takes .slice(-20)
  const s = computeIndexDetail(swng.combined);
  indexHistory.push({
    roundId: line.roundId,
    ...(s !== undefined ? { swngIndex: s.value } : {}),
    ...(w !== undefined ? { whsIndex: w.value } : {}),
  });
}
```
  with `feed` applying the SAME pairing rule as `combineNineHoleDifferentials` (18 → push;
  first 9 → pend; second 9 → push pending+this). Factor the pairing so it is provably the same
  rule as `combineNineHoleDifferentials` (either call a shared helper or add a test asserting the
  streamed combine equals `combineNineHoleDifferentials` over the same entries). Keep `detailsOf`
  for the headline (it still folds the full set once — O(N), fine). Rename/comment so the code
  reads as "the golfer's index as of each round."

- [ ] **Step 4: Run the tests, verify they pass** (equality oracle + headline-equals-last), then
  `pnpm validate`. Confirm the field-oracle decks (identityRecord/crewSeason via `e2e:field` later)
  still agree — they are the end-to-end backstop.

- [ ] **Step 5: Commit.** `git commit -m "perf(domain): compute index-over-time in one O(N) pass, not an O(N²) per-prefix recompute"`

---

### Task 4: Move TOKEN_SECRET to a runtime Secrets Manager fetch

**Files:**
- Modify: `packages/lambda/src/compositionRoot.ts` (`buildApp` → async; fetch secret by ARN)
- Modify: `packages/lambda/src/entries/http.ts`, `entries/wsConnect.ts`, `entries/wsDisconnect.ts`
  (lazy cached-promise init)
- Modify: `apps/infra-cdk/lib/swngStack.ts` (env carries `TOKEN_SECRET_ARN`, not the value; grant
  `secretsManager:GetSecretValue`)
- Test: `packages/lambda/src/compositionRoot.test.ts`, `apps/infra-cdk/test/swngStack.test.ts`

**Interfaces:**
- Produces: `buildApp` becomes `async (env) => Promise<App>`. Entries await a cached promise.

**Deploy-order note (Global Constraints):** the secret VALUE is unchanged (same
`swng-token-secret-<stage>` secret) — only delivery changes — so live tokens keep verifying. One
`deploy:beta` grants `GetSecretValue` + switches the env together.

- [ ] **Step 1: Write failing tests.** In `compositionRoot.test.ts`, drive `buildApp` with a
  fake secret source (inject a `readSecret` seam rather than calling the real SDK):
```ts
it("builds the token issuer from the resolved secret, not a plaintext env var", async () => {
  const app = await buildApp({ ...baseEnv, TOKEN_SECRET_ARN: "arn:...", /* no TOKEN_SECRET */ },
    { readSecret: async (arn) => { expect(arn).toBe("arn:..."); return "resolved-secret"; } });
  // a token minted by app.tokens verifies with the resolved secret
});
```
  In `swngStack.test.ts`, assert the http function's env has `TOKEN_SECRET_ARN` (a Ref to the
  secret) and NOT a `TOKEN_SECRET` resolve-reference, and that a `secretsmanager:GetSecretValue`
  policy on the secret is attached to the function role.

- [ ] **Step 2: Run the tests, verify they fail.**

- [ ] **Step 3: Implement.** In `compositionRoot.ts`, add an injectable secret reader (default =
  the real Secrets Manager client), make `buildApp` async, resolve the secret before building the
  `TokenIssuer`:
```ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const defaultReadSecret = async (arn: string): Promise<string> => {
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) throw new Error("buildApp: TOKEN_SECRET_ARN resolved no SecretString");
  return out.SecretString;
};

export const buildApp = async (
  env: NodeJS.ProcessEnv,
  deps: { readSecret?: (arn: string) => Promise<string> } = {},
): Promise<App> => {
  const tokenSecret = await (deps.readSecret ?? defaultReadSecret)(requireEnv(env, "TOKEN_SECRET_ARN"));
  // ...rest unchanged, using tokenSecret for createHmacTokenIssuer
};
```
  Entries use a cached-promise lazy init (avoids top-level await / bundler-format concerns):
```ts
// entries/http.ts
import { buildApp } from "../compositionRoot.js";
let appPromise: ReturnType<typeof buildApp> | undefined;
export const handler = async (event: Parameters<Awaited<typeof appPromise>["dispatcher"]>[0]) => {
  appPromise ??= buildApp(process.env);
  return (await appPromise).dispatcher(event);
};
```
  (Same lazy pattern for `wsConnect`/`wsDisconnect`, awaiting the app then delegating to
  `app.registry`/`app.tokens` as they do today.) In `swngStack.ts`, replace
  `TOKEN_SECRET: tokenSecret.secretValue.unsafeUnwrap()` in `sharedEnv` with
  `TOKEN_SECRET_ARN: tokenSecret.secretArn`, and add `tokenSecret.grantRead(fn)` for every function
  that builds the app (http, wsConnect, wsDisconnect).

- [ ] **Step 4: Run the tests + `pnpm validate` + `pnpm test:contract`** (the adapter surface is
  untouched, but run it since composition wiring changed). `cdk synth` and grep the template to
  confirm `TOKEN_SECRET` is gone and `TOKEN_SECRET_ARN` is a `Ref`, not a resolve-reference.

- [ ] **Step 5: Commit.** `git commit -m "fix(lambda,infra): resolve the token-signing secret at runtime from Secrets Manager, out of the Lambda env"`

---

### Task 5: AWS WAF rate-limiting on Cognito + CloudFront

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (add `CfnWebACL` + associations)
- Test: `apps/infra-cdk/test/swngStack.test.ts`

**Interfaces:** Produces: a CLOUDFRONT-scope `CfnWebACL` (us-east-1, this stack's region) with an
IP rate-based rule, associated with the CloudFront distribution and the Cognito user pool.

- [ ] **Step 1: Write a failing stack test** asserting the synthesized template has an
  `AWS::WAFv2::WebACL` with a `RateBasedStatement`, and `AWS::WAFv2::WebACLAssociation` /
  the distribution's `WebACLId` wiring.

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement.** Add a rate-based web ACL and associate it. Use `aws-cdk-lib/aws-wafv2`
  L1s (`CfnWebACL`, `CfnWebACLAssociation`); set the distribution's `webAclId` via the
  `Distribution` prop. Concrete shape:
```ts
const RATE_LIMIT_PER_5MIN = 2000; // generous vs a real crew (~1 rps); tune down if telemetry shows floods
const webAcl = new CfnWebACL(this, "WebAcl", {
  scope: "CLOUDFRONT", // CLOUDFRONT-scope ACLs are created in us-east-1 (this stack's region)
  defaultAction: { allow: {} },
  visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `swng-waf-${stage}`, sampledRequestsEnabled: true },
  rules: [{
    name: "RateLimit", priority: 0,
    action: { block: {} },
    statement: { rateBasedStatement: { aggregateKeyType: "IP", limit: RATE_LIMIT_PER_5MIN } },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `swng-waf-rate-${stage}`, sampledRequestsEnabled: true },
  }],
});
```
  Wire `webAclId: webAcl.attrArn` onto the `Distribution` (add the prop to the existing
  distribution construct). Associate the SAME rate discipline with the Cognito user pool via a
  separate REGIONAL web ACL + `CfnWebACLAssociation` on the user pool ARN (a user pool is a
  REGIONAL WAF resource — note: CLOUDFRONT-scope and REGIONAL-scope ACLs are distinct; the Cognito
  association needs its own REGIONAL `CfnWebACL`). The implementer confirms the current
  aws-cdk-lib version's WAFv2 L1 prop names against `cdk synth`.

- [ ] **Step 4: Run the test + `pnpm validate` + `cdk synth`** (verify no synth error and the ACLs
  render).

- [ ] **Step 5: Commit.** `git commit -m "feat(infra): rate-limit account creation and the web edge with AWS WAF"`

---

### Task 6: Security response headers + CORS scoping

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (ResponseHeadersPolicy; HttpApi corsPreflight; CSP)
- Test: `apps/infra-cdk/test/swngStack.test.ts`

- [ ] **Step 1: Write a failing stack test** asserting the ResponseHeadersPolicy carries HSTS,
  `X-Content-Type-Options: nosniff`, a Referrer-Policy, and `frameOptions` DENY; the CSP string
  contains `frame-ancestors 'none'` and `base-uri 'self'`; and the HttpApi's CORS `allowOrigins`
  is the scoped web origins, not `*`.

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement.** Extend `securityHeadersBehavior` on `webResponseHeadersPolicy`:
```ts
securityHeadersBehavior: {
  contentSecurityPolicy: { contentSecurityPolicy, override: true },
  strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
  contentTypeOptions: { override: true },
  referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
  frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
},
```
  Add `"frame-ancestors 'none'"` and `"base-uri 'self'"` to the `contentSecurityPolicy` array.
  Replace the HttpApi `corsPreflight.allowOrigins: ["*"]` with the stack's `webOrigins`
  (plus the distribution + custom-domain origins, mirroring how the Cognito callback list is
  built) — or, if a per-stage origin list is cleaner, thread it the same way `webOrigins` is
  resolved. Import `HeadersReferrerPolicy`/`HeadersFrameOption` from `aws-cdk-lib/aws-cloudfront`.

- [ ] **Step 4: Run the test + `pnpm validate` + `cdk synth`.**

- [ ] **Step 5: Commit.** `git commit -m "feat(infra): add HSTS/nosniff/referrer/frame headers and scope CORS off '*'"`

---

### Task 7: Data durability — PITR + deletion protection

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (rounds + core tables)
- Test: `apps/infra-cdk/test/swngStack.test.ts`

- [ ] **Step 1: Write a failing stack test** asserting the rounds and core tables have
  `PointInTimeRecoverySpecification` enabled, and that the RETAIN tables (rounds, snapshots, core,
  projections) have `DeletionProtectionEnabled: true`.

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement.** Add `pointInTimeRecovery: true` to `roundsTable` and `coreTable`
  (snapshots already has it; projections is rebuildable — leave it, or add for symmetry per the
  test). Add `deletionProtection: true` to the four RETAIN tables (rounds, snapshots, core,
  projections). Leave `connectionsTable` DESTROY/no-protection (rebuildable WS state).

- [ ] **Step 4: Run the test + `pnpm validate` + `cdk synth`** (in-place property adds — confirm
  `cdk diff` shows no replacement).

- [ ] **Step 5: Commit.** `git commit -m "feat(infra): enable PITR on rounds+core and deletion protection on the RETAIN tables"`

---

### Task 8: Dependency bumps + confirm the email claim is never persisted

**Files:**
- Modify: `apps/infra-cdk/package.json` (aws-cdk-lib), `e2e/package.json` (ws) + lockfile
- Test/verify: a grep-level assertion that no use case reads `claims.email` into stored or returned
  data (findings §"Confirm").

- [ ] **Step 1: Bump.** `env -u NODE_OPTIONS pnpm -F @swng/infra-cdk up aws-cdk-lib@latest` (≥
  2.260.0) and `env -u NODE_OPTIONS pnpm -F swng-e2e up ws@latest` (≥ 8.21). Re-run
  `env -u NODE_OPTIONS pnpm audit --prod` and record the result (expect the 3 high / 1 moderate to
  clear).

- [ ] **Step 2: Confirm the email claim is inert.** Grep for `\.email` across
  `packages/application/src` and `packages/lambda/src`; confirm `AccountClaims.email` is never
  written to a golfer row or returned on the wire (the accounts-only wall says sub-only). If it is
  genuinely unused, DELETE the `email` field from `AccountClaims` / `createCognitoVerifier` so the
  authenticator truly reads sub only (the cleanest outcome); add/adjust a test pinning that
  `getMyGolfer`/`updateMyGolfer` responses carry no email. If removal is out of scope, leave a
  test that pins no response includes an email field.

- [ ] **Step 3: Run `pnpm validate`** (+ `cdk synth` since aws-cdk-lib moved).

- [ ] **Step 4: Commit.** `git commit -m "chore: bump aws-cdk-lib + ws off known advisories; drop the unused email claim"`

---

## Close-out (controller-run, after all tasks + the whole-branch review)

1. Whole-branch review (superpowers:requesting-code-review) on the full Arc A diff.
2. `pnpm validate` green at HEAD; `pnpm test:contract`.
3. `cdk diff` — confirm in-place only (no table/pool/client replacement); Task 4's secret switch
   and Task 5-7's stack changes are all additive/in-place.
4. `deploy:beta` (one deploy carries the secret grant+switch and the WAF/headers/CORS/PITR).
5. `publish:web:beta` only if the web bundle changed (headers/CORS are stack-only; Task 3's domain
   change ships in the lambda + is re-exported to the web via `@swng/client` — no web behavior
   change, but rebuild/republish if any web-consumed package version moved).
6. `e2e:beta` ×2, `e2e:field` (mints + uses real tokens — the proof the secret switch preserved
   verification; the field decks are the index-history regression backstop).
7. Adversarial USE pass on the deployed surface: a forged-token attempt still fails; `curl -I`
   shows the new headers; an over-cap payload (long name / 101st crew member / bad-alphabet code)
   is rejected; the WAF association is live (console or `aws wafv2 list-resources-for-web-acl`).

## Self-review notes

- Spec coverage: every principle in the spec maps to a task (secret→T4, bounds→T1, N²→T3,
  WAF→T5; edge hardening→T6/T7; deps+email→T8; join-code CSPRNG→T2).
- Deferred by design (NOT in this plan): `USER_PASSWORD_AUTH`-off + Cognito password/MFA/threat
  protection (Arc C prod pool); alarms/p95/usage metrics (Arc B); read-fold caches beyond T3.
- Bounds placement (Task 1): request-schema ingress ONLY — never a response/read schema, never a
  fold/deserialization gate (a limit that rejects stored data bricks a legitimate user, worse than
  the DoS it prevents). The crew-size cap an earlier draft carried is DROPPED (a product limit, not
  a DoS defense; abuse is choked by WAF, and the standings fan-out is a read-cost matter to solve
  at the read if a legitimate crew ever grows large enough).
