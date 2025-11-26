import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketApi } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { WebSocketLambdaAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "../../../../");

export interface WebSocketInfraProps {
  table: Table;
  stageName: string;
}

export class WebSocketInfra extends Construct {
  public readonly api: WebSocketApi;
  public readonly apiId: string;
  public readonly stageName: string;
  public readonly wssUrl: string;

  public readonly authorizerFn: NodejsFunction;
  public readonly connectFn: NodejsFunction;
  public readonly disconnectFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: WebSocketInfraProps) {
    super(scope, id);

    this.authorizerFn = new NodejsFunction(
      this,
      `WsAuthorizer-${props.stageName}`,
      {
        entry: join(
          repoRoot,
          "packages/lambda-ws-authorizer/src/lambda-ws-authorizer/handler.ts"
        ),
        runtime: Runtime.NODEJS_22_X,
        bundling: {
          format: OutputFormat.ESM,
          minify: true,
          sourcesContent: false,
        },
        environment: {
          DYNAMO_TABLE: props.table.tableName,
        },
      }
    );
    props.table.grantReadData(this.authorizerFn);

    this.connectFn = new NodejsFunction(this, `WsConnect-${props.stageName}`, {
      entry: join(
        repoRoot,
        "packages/lambda-ws-connect/src/lambda-ws-connect/handler.ts"
      ),
      runtime: Runtime.NODEJS_22_X,
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        sourcesContent: false,
      },
      environment: {
        DYNAMO_TABLE: props.table.tableName,
      },
    });
    props.table.grantWriteData(this.connectFn);

    this.disconnectFn = new NodejsFunction(
      this,
      `WsDisconnect-${props.stageName}`,
      {
        entry: join(
          repoRoot,
          "packages/lambda-ws-disconnect/src/lambda-ws-disconnect/handler.ts"
        ),
        runtime: Runtime.NODEJS_22_X,
        bundling: {
          format: OutputFormat.ESM,
          minify: true,
          sourcesContent: false,
        },
        environment: {
          DYNAMO_TABLE: props.table.tableName,
        },
      }
    );
    props.table.grantWriteData(this.disconnectFn);

    this.api = new WebSocketApi(this, `WebSocketApi-${props.stageName}`, {
      routeSelectionExpression: "$request.body.action", // default; $connect/$disconnect don't use it
    });

    const authorizer = new WebSocketLambdaAuthorizer(
      `WsAuthorizer-${props.stageName}`,
      this.authorizerFn,
      {
        // Provide both Authorization and Sec-WebSocket-Protocol so our authorizer can read either
        identitySource: [
          "route.request.header.Authorization",
          "route.request.header.Sec-WebSocket-Protocol",
        ],
      }
    );

    this.api.addRoute("$connect", {
      integration: new WebSocketLambdaIntegration(
        `WsConnectIntegration-${props.stageName}`,
        this.connectFn
      ),
      authorizer,
    });

    this.api.addRoute("$disconnect", {
      integration: new WebSocketLambdaIntegration(
        `WsDisconnectIntegration-${props.stageName}`,
        this.disconnectFn
      ),
    });

    const accessLogs = new logs.LogGroup(
      this,
      `WsAccessLogs-${props.stageName}`,
      {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.RETAIN,
      }
    );

    new apigwv2.CfnStage(this, `WsStage-${props.stageName}`, {
      apiId: this.api.apiId,
      stageName: props.stageName,
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: accessLogs.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          routeKey: "$context.routeKey",
          status: "$context.status",
          ip: "$context.identity.sourceIp",
        }),
      },
    });

    this.apiId = this.api.apiId;
    this.stageName = props.stageName;
    this.wssUrl = `wss://${this.api.apiId}.execute-api.${
      Stack.of(this).region
    }.amazonaws.com/${props.stageName}`;
  }
}
