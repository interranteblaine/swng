import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import {
  HttpApi,
  CorsHttpMethod,
  HttpMethod,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as logs from "aws-cdk-lib/aws-logs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Construct } from "constructs";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "../../../../");

export interface HttpApiInfraProps {
  table: Table;
  stageName: string;
  wsApiId: string;
  rateLimit?: number;
  burstLimit?: number;
  allowedOrigins?: string[];
}

export class HttpApiInfra extends Construct {
  public readonly api: HttpApi;
  public readonly apiId: string;
  public readonly stageName: string;
  public readonly url: string;
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: HttpApiInfraProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const managementEndpoint = `https://${props.wsApiId}.execute-api.${region}.amazonaws.com/${props.stageName}`;

    this.handler = new NodejsFunction(this, `HttpHandler-${props.stageName}`, {
      entry: join(
        repoRoot,
        "packages/lambda-http-handler/src/lambda-http-handler/handler.ts"
      ),
      runtime: Runtime.NODEJS_22_X,
      bundling: {
        format: OutputFormat.CJS,
        minify: true,
        sourcesContent: false,
      },
      environment: {
        DYNAMO_TABLE: props.table.tableName,
        WS_MANAGEMENT_ENDPOINT: managementEndpoint,
      },
    });

    const manageConnectionsArn = `arn:aws:execute-api:${region}:${account}:${props.wsApiId}/${props.stageName}/POST/@connections/*`;
    this.handler.addToRolePolicy(
      new PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [manageConnectionsArn],
      })
    );

    props.table.grantReadWriteData(this.handler);

    this.api = new HttpApi(this, `HttpApi-${props.stageName}`, {
      createDefaultStage: false,
      corsPreflight: {
        allowHeaders: ["content-type", "x-session-id"],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: props.allowedOrigins ?? ["*"],
      },
    });

    this.api.addRoutes({
      path: "/{proxy+}",
      methods: [
        HttpMethod.GET,
        HttpMethod.POST,
        HttpMethod.PUT,
        HttpMethod.PATCH,
      ],
      integration: new HttpLambdaIntegration(
        `HttpIntegration-${props.stageName}`,
        this.handler
      ),
    });

    const accessLogs = new logs.LogGroup(
      this,
      `HttpAccessLogs-${props.stageName}`,
      {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.RETAIN,
      }
    );

    new apigwv2.HttpStage(this, `HttpStage-${props.stageName}`, {
      httpApi: this.api,
      stageName: props.stageName,
      autoDeploy: true,
      throttle: {
        rateLimit: props.rateLimit ?? 50,
        burstLimit: props.burstLimit ?? 100,
      },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            httpMethod: "$context.httpMethod",
            path: "$context.path",
            routeKey: "$context.routeKey",
            status: "$context.status",
            ip: "$context.identity.sourceIp",
            caller: "$context.identity.caller",
            user: "$context.identity.user",
          })
        ),
      },
    });

    this.apiId = this.api.apiId;
    this.stageName = props.stageName;
    this.url = `https://${this.api.apiId}.execute-api.${
      Stack.of(this).region
    }.amazonaws.com/${props.stageName}`;
  }
}
