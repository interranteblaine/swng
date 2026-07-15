import { App } from "aws-cdk-lib";
import { SwngStack, type SwngStackProps } from "../lib/swngStack.js";

// Stage is fixed to "beta" until a real prod pipeline lands (CLAUDE.md: stages beta and
// prod, region us-east-1) — parameterized via STAGE so a future prod deploy is a one-line
// env change here, not a rewrite. The stack id (`swng-${stage}`) is what `cdk deploy
// swng-beta` targets by name — see package.json's deploy:beta script.
const stage = process.env.STAGE ?? "beta";

// Task D-T1: the first real per-stage config table — D5's shape, starting here. Every other
// per-stage difference so far lives inside SwngStack itself (stage-suffixed resource names via
// the `stage` prop alone), but a custom domain needs data a stage NAME can't derive on its own
// (a domain string, an already-provisioned hosted zone id) — so that data lives in a table at
// the entry point, and swngStack.ts stays free of any `stage === "prod"`-shaped branch. Adding
// prod later is one more entry here, not new stack code.
const STAGE_WEB: Record<string, SwngStackProps["web"]> = {
  beta: { domainName: "beta.swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
  // prod: { domainName: "swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" }
  // — lands with the prod-stack task (D5); same hosted zone, apex instead of the beta subdomain.
};

const app = new App();
new SwngStack(app, `swng-${stage}`, {
  stage,
  web: STAGE_WEB[stage],
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
