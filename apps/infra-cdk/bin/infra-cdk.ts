#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { InfraCdkStack } from "../lib/infra-cdk-stack.js";
import { ApiGwAccountStack } from "../lib/apigw-account-stack.js";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const apiGwAccount = new ApiGwAccountStack(app, "ApiGwAccountStack", { env });

const beta = new InfraCdkStack(app, "InfraCdkStack-beta", {
  env,
  stage: "beta",
});
beta.addDependency(apiGwAccount);

const prod = new InfraCdkStack(app, "InfraCdkStack-prod", {
  env,
  stage: "prod",
});
prod.addDependency(apiGwAccount);
