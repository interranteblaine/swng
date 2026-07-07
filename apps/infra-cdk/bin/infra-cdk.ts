import { App, Stack } from "aws-cdk-lib";

// Placeholder so the CDK app synthesizes while the real stacks wait for M3.
// Deliberately NOT named InfraCdkStack-{beta,prod}: deploying an empty stack
// under the deployed POC's names would delete its live resources.
const app = new App();
new Stack(app, "PlaceholderStack");
