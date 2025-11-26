import { Stack } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "../../../../");

export interface StreamingInfraProps {
  table: Table;
  wsApiId: string;
  stageName: string;
}

/**
 * DynamoDB stream processor that broadcasts events using the
 * API Gateway Management API.
 */
export class StreamingInfra extends Construct {
  public readonly fn: NodejsFunction;
  public readonly managementEndpoint: string;

  constructor(scope: Construct, id: string, props: StreamingInfraProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    this.managementEndpoint = `https://${props.wsApiId}.execute-api.${region}.amazonaws.com/${props.stageName}`;

    this.fn = new NodejsFunction(this, `StreamProcessor-${props.stageName}`, {
      entry: join(
        repoRoot,
        "packages/lambda-stream-handler/src/lambda-stream-handler/handler.ts"
      ),
      runtime: lambda.Runtime.NODEJS_22_X,
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        sourcesContent: false,
      },
      environment: {
        DYNAMO_TABLE: props.table.tableName,
        WS_MANAGEMENT_ENDPOINT: this.managementEndpoint,
      },
    });

    // Allow Lambda to call Management API: POST @connections/*
    // arn:aws:execute-api:{region}:{account}:{api-id}/{stage}/POST/@connections/*
    const manageConnectionsArn = `arn:aws:execute-api:${region}:${account}:${props.wsApiId}/${props.stageName}/POST/@connections/*`;
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [manageConnectionsArn],
      })
    );

    this.fn.addEventSource(
      new DynamoEventSource(props.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        bisectBatchOnError: true,
        retryAttempts: 3,
      })
    );
  }
}
