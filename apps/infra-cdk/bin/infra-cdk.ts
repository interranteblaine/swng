#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { InfraCdkStack } from "../lib/infra-cdk-stack.js";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new InfraCdkStack(app, "InfraCdkStack-beta", {
  env,
  stage: "beta",
  wafRateLimitPer5Min: 100,
});

new InfraCdkStack(app, "InfraCdkStack-prod", {
  env,
  stage: "prod",
  wafRateLimitPer5Min: 300,
});
