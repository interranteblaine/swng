import { App } from "aws-cdk-lib";
import { SwngStack, type SwngStackProps } from "../lib/swngStack.js";

// Stage is fixed to "beta" until a real prod pipeline lands (CLAUDE.md: stages beta and
// prod, region us-east-1) — parameterized via STAGE so a future prod deploy is a one-line
// env change here, not a rewrite. The stack id (`swng-${stage}`) is what `cdk deploy
// swng-beta` targets by name — see package.json's deploy:beta script.
const stage = process.env.STAGE ?? "beta";

// Task D-T1 / Prod-readiness Arc C Task 2: the per-stage config table — D5's shape. Every other
// per-stage difference so far lives inside SwngStack itself (stage-suffixed resource names via
// the `stage` prop alone), but a custom domain — and now prod's hardening knobs — need data a
// stage NAME can't derive on its own, so that data lives in a table at the entry point, and
// swngStack.ts stays free of any `stage === "prod"`-shaped branch. `beta` carries ONLY `web`;
// everything else uses the stack's own beta-shaped defaults (keeps beta byte-identical to before
// this table existed). `prod` carries the full hardening set.
type StageConfig = Omit<SwngStackProps, "stage" | "env">;

// Exported so apps/infra-cdk/test/mcpCanonical.test.ts can assert what the DEPLOY actually
// carries — a stack test that supplies its own props proves the stack wires them correctly and
// says nothing about whether this table holds the right ones (or, for `mcp`, holds them for the
// right stage). Importing this module constructs the app below but never synthesizes it: CDK's
// App only auto-synths when the CLI sets CDK_OUTDIR, which no test run does.
export const STAGE_CONFIG: Record<string, StageConfig> = {
  beta: {
    web: { domainName: "beta.swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
    // swng-speaks-mcp §6/§10.4: BETA ONLY in this arc. `mcp.beta.swng.golf` lives in the same
    // already-provisioned swng.golf zone the web domain does; the canonical resource URI
    // (`https://mcp.beta.swng.golf/mcp`) is derived from this host inside the stack, so there is
    // exactly one place it is written down. prod deliberately carries no `mcp` key at all, which
    // is what keeps swng-prod synthesizing byte-identical while this ships.
    mcp: { domainName: "mcp.beta.swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
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
    preventUserExistenceErrors: true,
  },
};

const app = new App();
new SwngStack(app, `swng-${stage}`, {
  stage,
  ...STAGE_CONFIG[stage],
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
