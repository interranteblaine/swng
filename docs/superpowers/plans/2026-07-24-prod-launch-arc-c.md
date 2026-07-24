# Prod-readiness Arc C — Production launch (`swng-prod`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a hardened `swng-prod` stack on the `swng.golf` apex — `USER_PASSWORD_AUTH` off, a prod password policy, pool deletion-protection, prod-scoped origins — reusing Arc A/B's abuse + observability layer, with deploy tooling and a smoke gate, for a real launch tomorrow.

**Architecture:** The stack is already stage-parameterized (names, tables, secret, domain, WAF, alarms all `…-${stage}`). Arc C lifts the few remaining hardcoded per-stage knobs (auth flow, extra origins, password policy, pool deletion-protection) into typed `SwngStackProps` fields with **beta-shaped defaults** (so beta synthesizes byte-identical), adds a `prod` entry to the per-stage config table in `bin/infra-cdk.ts`, and adds `deploy:prod`/`publish:web:prod` tooling. No stage-name branching in the stack; no new stack code.

**Tech Stack:** AWS CDK (aws-cdk-lib 2.262), Cognito, CloudFront, ACM, Route53, DynamoDB, Node scripts, Vitest (CDK assertions).

## Execution scope (read first — the deploy IS part of this arc)

Executing this plan means **building Tasks 1–3 AND running the launch close-out below** — the
`swng-prod` deploy, the web publish, and the smoke walk are the deliverable, not a follow-up. **Do
not defer the deploy.** The full sequence is: build Tasks 1–3 (subagent-driven, each reviewed) →
whole-branch review → land the held Arc B on beta → deploy `swng-prod` → publish the prod web →
run the smoke walk on `swng.golf`. Everything through the smoke walk is **controller-run**. The
only steps that are the owner's: **clicking the `swng-alarms-prod` SNS confirmation email** (a
human action; flag it, but it does not block the deploy) and **the public announcement** (they
post only after the smoke walk is green). Deploy details: AWS profile `swng`, `STAGE=prod` for the
prod deploy, region `us-east-1`. `swng.golf` apex is confirmed free (owner, 2026-07-24).

## Current state at plan time (for a post-compaction executor)

- **Arc A** (app hardening): deployed to `swng-beta`, on `main`.
- **Arc B** (observability): CODE-COMPLETE on `main`, `validate`-green, whole-branch-reviewed,
  the WAF-dimension fix landed (commit `46b9515`) — but **held from beta** (it was deliberately not
  deployed during the owner's live round). Close-out step 3 below deploys it to beta first.
- **Arc C** (this plan): spec (`2026-07-24-prod-launch-arc-c-design.md`) + this plan committed
  (`62835c6`, `84e814b`). Branch base for the whole-branch review = the commit this plan sits on
  (`git merge-base` is unnecessary — the arc is linear on `main`; use the pre-Task-1 HEAD recorded
  in `.superpowers/sdd/progress.md`). Nothing pushed; all on local `main`.

## Global Constraints

- `pnpm validate` MUST be green at every commit and at HEAD.
- Work stays on local `main`. NEVER push. NEVER create/deploy/destroy a stack named `InfraCdkStack-*` (the guard at `swngStack.ts:187-194` enforces this; `swng-prod` is safe).
- **Beta must synthesize byte-identical** through Tasks 1-2: the existing `swngStack.test.ts` templates are constructed as `new SwngStack(new App({context:{"@aws-cdk/aws-lambda:useCdkManagedLogGroup":true}}), "swng-beta", { stage: "beta" })` (line 9-10) and `… { stage: "beta", web: WEB_BETA }` (line 1308-1309) — these must keep passing UNCHANGED. Every new config field defaults to beta's current value.
- AWS profile `swng`, region `us-east-1`, same account for beta and prod (resource names are stage-suffixed → no collision). Hosted zone `Z00936512AJC1HGD9M7B7` (`swng.golf`) — the apex is confirmed free (owner, 2026-07-24), so the prod A/AAAA records create cleanly (no POC handover).
- Prod config values (baked per the design spec `2026-07-24-prod-launch-arc-c-design.md`): `userPasswordAuth: false`; origins = `swng.golf` + own CloudFront only (no localhost, no beta cloudfront.net); password policy min-length 8 / lower+upper+digit / symbols NOT required; pool deletion-protection on; throttles + WAF + alarm email UNCHANGED from beta (tight abuse ceilings are the bill cap); Essentials plan (no threat protection); MFA off; apex only (no www).

---

### Task 1: Config-drive the auth flow + origins (beta byte-identical)

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (`SwngStackProps`; `authFlows`; `webOrigins`; CORS origins)
- Test: `apps/infra-cdk/test/swngStack.test.ts`

**Interfaces:**
- Produces on `SwngStackProps`: `userPasswordAuth?: boolean` (default `true`), `extraWebOrigins?: string[]` (default `["http://localhost:5173","http://localhost:4173"]`), `extraCorsOrigins?: string[]` (default `["https://d5qqgppnyb7y1.cloudfront.net"]`). All default to beta's current values so a `{ stage: "beta" }` construction is unchanged.

- [ ] **Step 1: Extend `SwngStackProps`.** In `swngStack.ts` (the interface at ~lines 33-46), add three fields with doc comments:

```ts
  /** Direct USER_PASSWORD_AUTH on the app client. Beta: true (e2e mints tokens via InitiateAuth).
   *  Prod: false — no direct password auth exposed to brute-forcing. Default true (beta). */
  readonly userPasswordAuth?: boolean;
  /** Non-domain origins added to BOTH the Cognito callback/logout lists and CORS (the dev/preview
   *  localhost origins). Beta: the two localhost ports. Prod: []. Default = beta's localhost pair. */
  readonly extraWebOrigins?: string[];
  /** CORS-only extra origins (beta's own cloudfront.net literal, hardcoded because CORS is computed
   *  before the distribution exists — the Arc A cycle note). Prod: []. Default = beta's cloudfront.net. */
  readonly extraCorsOrigins?: string[];
```

- [ ] **Step 2: Thread `userPasswordAuth` into the app client.** At `swngStack.ts:387`, replace:

```ts
    userPassword: true,
```
with:
```ts
    userPassword: props.userPasswordAuth ?? true,
```

- [ ] **Step 3: Thread `extraWebOrigins` into `webOrigins`.** At `swngStack.ts:369`, replace:

```ts
    const webOrigins = (this.node.tryGetContext("WEB_ORIGINS") as string[] | undefined) ?? ["http://localhost:5173", "http://localhost:4173"];
```
with:
```ts
    const webOrigins = props.extraWebOrigins ?? (this.node.tryGetContext("WEB_ORIGINS") as string[] | undefined) ?? ["http://localhost:5173", "http://localhost:4173"];
```

- [ ] **Step 4: Thread `extraCorsOrigins` into CORS.** At `swngStack.ts:601-609`, the CORS block currently hardcodes `CLOUDFRONT_NET_ORIGIN` and splices it into `corsAllowOrigins`. Replace the literal + its use so the literal becomes the DEFAULT of `extraCorsOrigins`. Change:

```ts
    const CLOUDFRONT_NET_ORIGIN = "https://d5qqgppnyb7y1.cloudfront.net";
    const corsAllowOrigins = [
      ...webOrigins,
      CLOUDFRONT_NET_ORIGIN,
      ...(webDomain ? [`https://${webDomain.domainName}`] : []),
    ];
```
to:
```ts
    // Beta's own cloudfront.net is hardcoded here (not read off the distribution) because CORS is
    // computed before the distribution exists — a token here would cycle (Arc A note). Per-stage
    // via extraCorsOrigins: prod passes [] (prod users reach it at swng.golf, not the raw CDN name).
    const extraCorsOrigins = props.extraCorsOrigins ?? ["https://d5qqgppnyb7y1.cloudfront.net"];
    const corsAllowOrigins = [
      ...webOrigins,
      ...extraCorsOrigins,
      ...(webDomain ? [`https://${webDomain.domainName}`] : []),
    ];
```

- [ ] **Step 5: Write the config-behavior test (proves the knobs bite).** In `swngStack.test.ts`, add a describe block that constructs a stack with the flags flipped and asserts the flow + origins drop:

```ts
describe("stage config knobs (Arc C — prod hardening)", () => {
  const hardened = Template.fromStack(
    new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-hardened", {
      stage: "hardened",
      userPasswordAuth: false,
      extraWebOrigins: [],
      extraCorsOrigins: [],
    }),
  );
  it("drops ALLOW_USER_PASSWORD_AUTH from the app client when userPasswordAuth is false", () => {
    const clients = hardened.findResources("AWS::Cognito::UserPoolClient");
    const flows = Object.values(clients)[0]!.Properties.ExplicitAuthFlows as string[];
    expect(flows).not.toContain("ALLOW_USER_PASSWORD_AUTH");
  });
  it("carries no localhost or beta-cloudfront origin in the app client callback URLs", () => {
    const clients = hardened.findResources("AWS::Cognito::UserPoolClient");
    const callbacks = JSON.stringify(Object.values(clients)[0]!.Properties.CallbackURLs);
    expect(callbacks).not.toContain("localhost");
    expect(callbacks).not.toContain("d5qqgppnyb7y1");
  });
});
```

- [ ] **Step 6: Run the tests — the NEW behavior test passes AND the existing beta tests are UNCHANGED-green.**

Run: `pnpm -F @swng/infra-cdk vitest run test/swngStack.test.ts`
Expected: PASS — the new block passes; the existing Cognito tests (`ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"])` at ~line 671, `CallbackURLs … "http://localhost:5173/auth/callback"` at ~667) still pass BYTE-IDENTICAL (beta defaults preserved).

- [ ] **Step 7: Validate + synth.**

Run: `pnpm validate` then `pnpm -F @swng/infra-cdk exec cdk synth --quiet`
Expected: exit 0, no synth error. (Default synth is beta — must be unchanged.)

- [ ] **Step 8: Commit.**

```bash
git add apps/infra-cdk
git commit -m "feat(infra): make auth-flow + extra origins per-stage config (beta byte-identical)"
```

---

### Task 2: Prod-only hardening knobs + the prod stage entry

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (`SwngStackProps`; `UserPool` password policy + deletion protection)
- Modify: `apps/infra-cdk/bin/infra-cdk.ts` (the per-stage config table — add `prod`)
- Test: `apps/infra-cdk/test/swngStack.test.ts`

**Interfaces:**
- Consumes: Task 1's config fields.
- Produces on `SwngStackProps`: `passwordPolicy?: { minLength: number; requireLowercase: boolean; requireUppercase: boolean; requireDigits: boolean; requireSymbols: boolean }` (default `undefined` → Cognito default, i.e. beta unchanged); `poolDeletionProtection?: boolean` (default `false` → beta unchanged).

- [ ] **Step 1: Extend `SwngStackProps` with the prod-only knobs.** Add to the interface:

```ts
  /** Explicit Cognito password policy. Prod sets a strong one; beta omits it (Cognito default) so
   *  beta's admin-created e2e users with fixed passwords aren't rejected. Default undefined. */
  readonly passwordPolicy?: {
    readonly minLength: number;
    readonly requireLowercase: boolean;
    readonly requireUppercase: boolean;
    readonly requireDigits: boolean;
    readonly requireSymbols: boolean;
  };
  /** Pool-level deletion protection (prod: real accounts). Default false (beta). */
  readonly poolDeletionProtection?: boolean;
```

- [ ] **Step 2: Apply them in the `UserPool`.** At `swngStack.ts:343-358` (the `new UserPool(...)` props), add — conditionally, so an absent policy/flag leaves the beta synth untouched:

```ts
    ...(props.passwordPolicy
      ? {
          passwordPolicy: {
            minLength: props.passwordPolicy.minLength,
            requireLowercase: props.passwordPolicy.requireLowercase,
            requireUppercase: props.passwordPolicy.requireUppercase,
            requireDigits: props.passwordPolicy.requireDigits,
            requireSymbols: props.passwordPolicy.requireSymbols,
          },
        }
      : {}),
    deletionProtection: props.poolDeletionProtection ?? false,
```

Note: `deletionProtection: false` is CDK's default for a UserPool, so adding it explicitly with the `?? false` default keeps beta's synth identical (the property renders the same as its default — verify in Step 5; if the synth gains a `DeletionProtection: "INACTIVE"` line that breaks a beta assertion, gate it behind the same `props.poolDeletionProtection ? {...} : {}` spread instead).

- [ ] **Step 3: Add the `prod` entry to the per-stage config table.** In `apps/infra-cdk/bin/infra-cdk.ts`, replace the `STAGE_WEB` table (lines 16-20) with a unified per-stage config, and pass it through. The `beta` entry carries ONLY `web` (everything else uses the stack's beta-shaped defaults, matching the byte-identical tests); `prod` carries the full hardening set:

```ts
type StageConfig = Omit<SwngStackProps, "stage" | "env">;

const STAGE_CONFIG: Record<string, StageConfig> = {
  beta: {
    web: { domainName: "beta.swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
    // userPasswordAuth / extraWebOrigins / extraCorsOrigins / passwordPolicy / poolDeletionProtection
    // all use the stack's beta-shaped defaults (keeps beta byte-identical to before this table).
  },
  prod: {
    web: { domainName: "swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
    userPasswordAuth: false,
    extraWebOrigins: [],
    extraCorsOrigins: [],
    passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
    poolDeletionProtection: true,
  },
};
```

Then update the `new SwngStack(...)` call (lines 22-27) to spread the config:

```ts
const app = new App();
new SwngStack(app, `swng-${stage}`, {
  stage,
  ...STAGE_CONFIG[stage],
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
```

(Import `SwngStackProps` in `bin/infra-cdk.ts` if not already imported.)

- [ ] **Step 4: Write the prod-config synth test.** In `swngStack.test.ts`, add a prod template (mirror the `webTemplate` pattern at line 1306) and assert the hardening:

```ts
describe("SwngStack prod config (Arc C)", () => {
  const prod = Template.fromStack(
    new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-prod", {
      stage: "prod",
      web: { domainName: "swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
      userPasswordAuth: false,
      extraWebOrigins: [],
      extraCorsOrigins: [],
      passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      poolDeletionProtection: true,
    }),
  );
  it("app client has no ALLOW_USER_PASSWORD_AUTH", () => {
    const flows = Object.values(prod.findResources("AWS::Cognito::UserPoolClient"))[0]!.Properties.ExplicitAuthFlows as string[];
    expect(flows).not.toContain("ALLOW_USER_PASSWORD_AUTH");
  });
  it("pool has an explicit password policy (minLength 8) and deletion protection", () => {
    prod.hasResourceProperties("AWS::Cognito::UserPool", {
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 8, RequireNumbers: true, RequireSymbols: false }) },
      DeletionProtection: "ACTIVE",
    });
  });
  it("callback URLs include swng.golf and exclude localhost + beta cloudfront", () => {
    const callbacks = JSON.stringify(Object.values(prod.findResources("AWS::Cognito::UserPoolClient"))[0]!.Properties.CallbackURLs);
    expect(callbacks).toContain("https://swng.golf/auth/callback");
    expect(callbacks).not.toContain("localhost");
    expect(callbacks).not.toContain("d5qqgppnyb7y1");
  });
});
```

- [ ] **Step 5: Run tests + validate + prove the prod stack synthesizes.**

Run: `pnpm -F @swng/infra-cdk vitest run test/swngStack.test.ts && pnpm validate`
Then prove the real prod stack synthesizes from `bin`: `STAGE=prod pnpm -F @swng/infra-cdk exec cdk synth swng-prod --quiet`
Expected: all green; the beta tests still pass byte-identical; `cdk synth swng-prod` produces a stack (a UserPoolClient with no USER_PASSWORD_AUTH, a `swng.golf` cert/alias/records, prod resource names). If the beta synth changed (Step 2 `deletionProtection` note), gate that property behind the conditional spread and re-run.

- [ ] **Step 6: Commit.**

```bash
git add apps/infra-cdk
git commit -m "feat(infra): prod password policy + pool deletion protection + swng-prod stage config"
```

---

### Task 3: Deploy + publish tooling for prod

**Files:**
- Modify: `apps/infra-cdk/package.json` (add `deploy:prod`)
- Modify: root `package.json` (add `deploy:prod`, `publish:web:prod`)
- Modify: `scripts/publishWeb.mjs` (accept a stage arg → per-stage outputs file)
- Modify: `.gitignore` (ignore `cdk-outputs.prod.json` if not already covered)

**Interfaces:**
- Produces: `pnpm deploy:prod` (STAGE=prod, targets `swng-prod`, writes `cdk-outputs.prod.json`) and `pnpm publish:web:prod` (reads `cdk-outputs.prod.json`, builds + syncs the prod bucket/distribution).

- [ ] **Step 1: Add the prod deploy script (infra-cdk).** In `apps/infra-cdk/package.json`, beside `"deploy:beta"` (line 13), add:

```json
    "deploy:prod": "STAGE=prod cdk deploy swng-prod --profile swng --require-approval never --outputs-file cdk-outputs.prod.json",
```

(`STAGE=prod` is mandatory — the stack-id arg alone does NOT set the internal `stage`; without it `bin` synthesizes only `swng-beta` and `cdk deploy swng-prod` errors that the stack doesn't exist. Separate `--outputs-file` so prod and beta outputs don't clobber.)

- [ ] **Step 2: Add the root passthrough scripts.** In the root `package.json`, beside `"deploy:beta"` and `"publish:web:beta"`, add:

```json
    "deploy:prod": "pnpm -F @swng/infra-cdk deploy:prod",
    "publish:web:prod": "node scripts/publishWeb.mjs prod",
```

- [ ] **Step 3: Parameterize `publishWeb.mjs` by stage.** The script and `webEnv.mjs`'s `generateEnvFile` already read a single-stack outputs file via `Object.values(outputs)[0]` — which is CORRECT per file (each stage writes its own outputs file). Only the PATH needs to be stage-aware. In `scripts/publishWeb.mjs`:
  - After `const dryRun = process.argv.includes("--dry-run");` (line 20), add stage resolution:

```js
// Optional first positional arg selects the stage (default beta). Each stage's `deploy:<stage>`
// writes its OWN outputs file (cdk-outputs.json for beta, cdk-outputs.<stage>.json otherwise), so
// the single-stack `Object.values(outputs)[0]` read below is correct per-file.
const stage = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "beta";
const outputsFile = stage === "beta" ? "cdk-outputs.json" : `cdk-outputs.${stage}.json`;
```
  - Change the `outputsPath` line (23) from the hardcoded `cdk-outputs.json` to use `outputsFile`:

```js
const outputsPath = fileURLToPath(new URL(`../apps/infra-cdk/${outputsFile}`, import.meta.url));
```
  - (The rest is unchanged: `generateEnvFile(outputsPath, ...)`, the build, and the S3 sync / CloudFront invalidation read `WebBucketName`/`DistributionId` from whichever stage's outputs file — prod's for `publish:web:prod`. Same `--profile swng`, same account.)

- [ ] **Step 4: Ignore the prod outputs file.** In `.gitignore`, confirm `cdk-outputs.prod.json` is ignored. If the existing entry is the literal `cdk-outputs.json`, add a line:

```
apps/infra-cdk/cdk-outputs.prod.json
```
(or broaden an existing `cdk-outputs*.json` if that's the current pattern — check first).

- [ ] **Step 5: Verify (no deploy).** Prod isn't deployed yet, so `publish:web:prod` can't read real outputs — verify the tooling by inspection + these checks:
  - `pnpm validate` exit 0 (no code broke).
  - `node -e "process.argv=['','','prod']"`-style is overkill; instead confirm the path logic by a dry run that fails cleanly with the RIGHT missing file: `node scripts/publishWeb.mjs prod --dry-run` should attempt `apps/infra-cdk/cdk-outputs.prod.json` and error `no stack outputs found in …/cdk-outputs.prod.json` (proving it selected the prod file), NOT `cdk-outputs.json`. Confirm the error names the prod file.
  - `node scripts/publishWeb.mjs --dry-run` (no stage) still selects `cdk-outputs.json` and builds (beta path unbroken) — if beta is currently deployed and the file exists, it builds; else it errors naming `cdk-outputs.json`.

- [ ] **Step 6: Commit.**

```bash
git add apps/infra-cdk/package.json package.json scripts/publishWeb.mjs .gitignore
git commit -m "feat(infra): deploy:prod + publish:web:prod tooling (per-stage outputs file)"
```

---

## Close-out — the launch (controller-run, sequenced with margin)

This is not a routine beta close-out; it is the production launch. Run in order, with time margin before any announcement.

1. **Whole-branch review** (superpowers:requesting-code-review) on the full Arc C diff, most-capable model. Fix Critical/Important before proceeding. Confirm beta synth byte-identical.
2. `pnpm validate` green at HEAD; `pnpm test:contract`.
3. **Land Arc B on beta first** (it's held on `main`): `pnpm deploy:beta` (carries Arc B's lambda + stack: EMF, access log, the 7 alarms, dashboard, the WAF-dimension fix — note the 2 WAF ACL replacements from the Name change, benign) → `pnpm publish:web:beta` → `pnpm e2e:beta` ×2 → confirm beta healthy. This proves the shared-stack changes deploy cleanly before prod inherits them.
4. **Confirm the apex is free** (owner says yes): `aws route53 list-resource-record-sets --hosted-zone-id Z00936512AJC1HGD9M7B7 --profile swng` — no A/AAAA for `swng.golf` bound to the POC. If one exists, free it (or set `deleteExisting` on the ARecord) before deploy.
5. **Deploy prod:** `pnpm deploy:prod`. This is a fresh CREATE — pool, tables, secret, ACM cert (DNS-validated; allow issuance + CloudFront distribution provisioning time, ~real minutes) → `WebDomainUrl` + `HostedUiDomain` etc. land in `cdk-outputs.prod.json`.
6. **Publish the prod web:** `pnpm publish:web:prod` (bakes prod's `VITE_*`, syncs the prod bucket, invalidates the prod distribution).
7. **Confirm the `swng-alarms-prod` SNS email** — the owner clicks the confirmation email (a fresh topic → new confirmation). Without this, launch alarms never arrive.
8. **Smoke walk on the DEPLOYED `swng.golf`** (the go/no-go gate):
   - Real Hosted-UI sign-up as a throwaway (branded managed login + verification email + PKCE).
   - Create → score → finalize a round (the whole wire on prod tables).
   - Sign out.
   - `curl -I https://swng.golf` — the five security headers + CSP present.
   - Delete the throwaway account.
9. **Watch `swng-ops-prod`** during onboarding. Know the incident lever (a callback-URL / CORS fix is a redeploy; the app is proven on beta).
10. **Owner announces** only after the smoke walk is green.

## Self-review notes

- Spec coverage: USER_PASSWORD_AUTH off → T1+T2; prod origins scoping → T1+T2; password policy + deletion protection → T2; apex domain → T2 (bin entry, existing web plumbing); deploy tooling → T3; abuse ceilings / WAF / alarms / tables / secret → UNCHANGED (Arc A/B, inherited); smoke gate + runbook → close-out.
- Deferred by design (NOT here — named fast-follows): SES production access (email scale lever), Cognito threat protection (Plus plan), `www.swng.golf`, MFA, a separate prod AWS account.
- Byte-identity discipline: every new field defaults to beta's current value; beta is constructed with `{ stage: "beta" }` (Task) or `{ stage: "beta", web: WEB_BETA }` and those existing tests must pass unchanged. The one risk (Task 2 explicit `deletionProtection: false`) has a stated fallback (conditional spread) if it perturbs a beta assertion.
- No data migration; prod starts empty (correct — beta was disposable test data).
