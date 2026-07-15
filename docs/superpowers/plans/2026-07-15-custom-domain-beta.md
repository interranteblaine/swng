# Custom Domain (beta.swng.golf) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** swng-beta serves at https://beta.swng.golf (owner call, 2026-07-15) — taking the hostname over from the old POC distribution — with the config shaped so prod later gets swng.golf by adding one entry, not new code.

**Architecture:** An optional per-stage `web` config prop (the first real D5-style stage config: `{ domainName, hostedZoneId, zoneName }`) drives an in-stack DNS-validated ACM cert, the CloudFront alias, and Route 53 alias records; Cognito callback/logout URLs gain the domain. The POC handover (release the alias from distribution `E2LRGWTEQIYOX9`, delete the old A record) is a controller-run live sequence, not stack code — the POC stacks themselves stay untouched.

**Tech Stack:** CDK (aws-certificatemanager, aws-route53, aws-route53-targets), existing stack tests.

## Global Constraints

- Pinned live facts: hosted zone `swng.golf.` = `Z00936512AJC1HGD9M7B7`; the alias `beta.swng.golf` is currently claimed by POC distribution `E2LRGWTEQIYOX9` (CloudFront aliases are GLOBALLY unique — our deploy fails `CNAMEAlreadyExists` until it is released); the existing issued ACM cert for beta.swng.golf belongs to the POC and is NOT reused — this stack mints its own (lifecycle independence; ACM DNS-validation records are per-account-per-domain identical and the CDK validator UPSERTs, so the pre-existing `_3a10…` CNAME satisfies the new cert immediately).
- The `web` prop is OPTIONAL: absent ⇒ the synthesized template is byte-identical to today (pinned by the existing suite continuing to pass unmodified against a no-prop synth); present ⇒ cert + alias + A/AAAA alias records + callback/logout entries. No `stage === "prod"`-style branching — the entry point's per-stage config table decides (D5's shape, starting now).
- The CloudFront-URL origin keeps working (aliases are additive); localhost dev entries stay untouched.
- CORS is `allowOrigins: ["*"]` — deliberately unchanged.
- `pnpm validate` green before commit; deploys controller-only; never touch `InfraCdkStack-*` STACKS (the alias release is an API-level distribution edit, owner-sanctioned in-chat 2026-07-15, and does not deploy/modify/destroy the POC stack itself).

---

### Task D-T1: The stack learns its domain

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (props + cert/alias/records + Cognito URLs + a `WebDomainUrl` output)
- Modify: `apps/infra-cdk/bin/infra-cdk.ts` (per-stage config table; beta → beta.swng.golf)
- Test: `apps/infra-cdk/test/swngStack.test.ts` (a new `describe` synthesizing a SECOND stack WITH the web prop; the existing shared template stays prop-less so every current pin doubles as the byte-identical-without-prop proof)

**Interfaces:**
- Produces: `SwngStackProps.web?: { readonly domainName: string; readonly hostedZoneId: string; readonly zoneName: string }`.

- [ ] **Step 1 (TDD):** failing tests in a new describe (own `Template.fromStack(new SwngStack(new App(), "swng-beta", { stage: "beta", web: WEB_BETA }))`): (a) an `AWS::CertificateManager::Certificate` for beta.swng.golf with DNS validation; (b) the distribution's `Aliases` contains beta.swng.golf and `ViewerCertificate` references the cert; (c) `AWS::Route53::RecordSet` A and AAAA for `beta.swng.golf.` alias-targeting the distribution in zone Z00936512AJC1HGD9M7B7; (d) CallbackURLs/LogoutURLs contain `https://beta.swng.golf/auth/callback` / `https://beta.swng.golf/` ALONGSIDE the distribution-domain and localhost entries.
- [ ] **Step 2:** RED for the right reasons.
- [ ] **Step 3:** implement:

```ts
// in SwngStackProps
readonly web?: { readonly domainName: string; readonly hostedZoneId: string; readonly zoneName: string };
```

```ts
// with the CloudFront section — cert/alias only when a domain is configured (per-stage
// config from bin/infra-cdk.ts, never a stage-name branch: D5's shape, starting here).
const webDomain = props?.web;
const hostedZone = webDomain
  ? HostedZone.fromHostedZoneAttributes(this, "WebZone", { hostedZoneId: webDomain.hostedZoneId, zoneName: webDomain.zoneName })
  : undefined;
const webCertificate = webDomain && hostedZone
  ? new Certificate(this, "WebCertificate", { domainName: webDomain.domainName, validation: CertificateValidation.fromDns(hostedZone) })
  : undefined;
// on the Distribution props:
//   ...(webDomain && webCertificate ? { domainNames: [webDomain.domainName], certificate: webCertificate } : {}),
// after the distribution:
if (webDomain && hostedZone) {
  const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
  new ARecord(this, "WebAliasA", { zone: hostedZone, recordName: webDomain.domainName, target });
  new AaaaRecord(this, "WebAliasAaaa", { zone: hostedZone, recordName: webDomain.domainName, target });
}
```

Cognito URLs: append `https://${webDomain.domainName}/auth/callback` and `https://${webDomain.domainName}/` to the existing L1 arrays when configured. Output `WebDomainUrl` when configured. Entry point:

```ts
const STAGE_WEB: Record<string, { domainName: string; hostedZoneId: string; zoneName: string } | undefined> = {
  beta: { domainName: "beta.swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
  // prod: { domainName: "swng.golf", ... } — lands with the prod-stack task (D5).
};
new SwngStack(app, `swng-${stage}`, { stage, web: STAGE_WEB[stage], env: { ... } });
```

- [ ] **Step 4:** `pnpm -F @swng/infra-cdk test` (both describes green), root `pnpm validate`.
- [ ] **Step 5:** Commit: `feat(infra): beta.swng.golf — per-stage web domain config, in-stack cert, CloudFront alias, Route 53 records`

---

### Task D-T2 (CONTROLLER): the handover and the live proof

- [ ] Step 1: release the alias from the POC distribution `E2LRGWTEQIYOX9` (get-distribution-config → Aliases.Quantity 0 + ViewerCertificate → CloudFrontDefaultCertificate → update-distribution). Owner-sanctioned; POC stays reachable at its own cloudfront.net URL; this is API-level drift on the frozen POC stack, not a stack operation.
- [ ] Step 2: delete the old `beta.swng.golf` A record (CLI, change-batch DELETE) so the stack can create and own it.
- [ ] Step 3: `cdk diff` (expect: +cert, +2 records, distribution alias/cert update, UserPoolClient URLs, +1 output; NOTHING stateful) → `pnpm deploy:beta` → post-deploy diff empty.
- [ ] Step 4: live proof — `dig beta.swng.golf` resolves to `d5qqgppnyb7y1.cloudfront.net` targets; `curl -sI https://beta.swng.golf/` 200 with the CSP header; browser: full PKCE sign-in/out round-trip ON the new origin (the real test of the Cognito URL append), zero console errors.
- [ ] Step 5: docs (CLAUDE.md hosted-URL mention gains beta.swng.golf; implementation-plan one-liner), proof-checks, ledger.
