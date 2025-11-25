#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { InfraCdkStack } from "../lib/infra-cdk-stack.js";

const app = new App();
new InfraCdkStack(app, "InfraCdkStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
