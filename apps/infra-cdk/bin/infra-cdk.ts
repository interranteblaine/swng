import { App } from "aws-cdk-lib";
import { SwngStack } from "../lib/swngStack.js";

// Stage is fixed to "beta" until a real prod pipeline lands (CLAUDE.md: stages beta and
// prod, region us-east-1) — parameterized via STAGE so a future prod deploy is a one-line
// env change here, not a rewrite. The stack id (`swng-${stage}`) is what `cdk deploy
// swng-beta` targets by name — see package.json's deploy:beta script.
const stage = process.env.STAGE ?? "beta";

const app = new App();
new SwngStack(app, `swng-${stage}`, {
  stage,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
