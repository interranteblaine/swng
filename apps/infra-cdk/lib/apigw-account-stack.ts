import { Stack, StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigwv1 from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

/**
 * One-per-account/region stack that enables API Gateway account-level
 * CloudWatch logging by creating the service role and wiring it via
 * AWS::ApiGateway::Account.
 *
 * Deploy this stack once per account/region before stacks that
 * enable accessLogSettings on API Gateway stages (REST/HTTP/WebSocket).
 */
export class ApiGwAccountStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Role assumed by API Gateway to push logs to CloudWatch Logs
    const cwRole = new iam.Role(this, "ApiGatewayCloudWatchRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonAPIGatewayPushToCloudWatchLogs"
        ),
      ],
      description:
        "Role for API Gateway to publish execution/access logs to CloudWatch Logs",
    });

    // Account-wide setting for API Gateway to use the role above
    new apigwv1.CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: cwRole.roleArn,
    });
  }
}
