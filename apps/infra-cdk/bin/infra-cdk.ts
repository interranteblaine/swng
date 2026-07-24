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

const app = new App();
new SwngStack(app, `swng-${stage}`, {
  stage,
  ...STAGE_CONFIG[stage],
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
