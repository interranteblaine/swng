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
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Construct } from "constructs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "../../../../");

export interface HttpApiInfraProps {
  table: Table;
  stageName: string;
  wafRateLimitPer5Min?: number; // requests per 5 minutes per IP, default 300
}

export class HttpApiInfra extends Construct {
  public readonly api: HttpApi;
  public readonly apiId: string;
  public readonly stageName: string;
  public readonly url: string;
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: HttpApiInfraProps) {
    super(scope, id);

    this.handler = new NodejsFunction(this, `HttpHandler-${props.stageName}`, {
      entry: join(
        repoRoot,
        "packages/lambda-http-handler/src/lambda-http-handler/handler.ts"
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

    props.table.grantReadWriteData(this.handler);

    this.api = new HttpApi(this, `HttpApi-${props.stageName}`, {
      createDefaultStage: false,
      corsPreflight: {
        allowHeaders: ["*"],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ["*"],
      },
    });

    this.api.addRoutes({
      path: "/{proxy+}",
      methods: [HttpMethod.ANY],
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

    new apigwv2.CfnStage(this, `HttpStage-${props.stageName}`, {
      apiId: this.api.apiId,
      stageName: props.stageName,
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: accessLogs.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          httpMethod: "$context.httpMethod",
          path: "$context.path",
          routeKey: "$context.routeKey",
          status: "$context.status",
          ip: "$context.identity.sourceIp",
          caller: "$context.identity.caller",
          user: "$context.identity.user",
        }),
      },
    });

    // WAFv2 Web ACL (rate limiting)
    const webAcl = new wafv2.CfnWebACL(this, `HttpWebAcl-${props.stageName}`, {
      name: `http-waf-${props.stageName}`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `http-waf-${props.stageName}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimit",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: props.wafRateLimitPer5Min ?? 300,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimit",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    const stageArn = `arn:aws:apigateway:${Stack.of(this).region}::/apis/${
      this.api.apiId
    }/stages/${props.stageName}`;

    new wafv2.CfnWebACLAssociation(
      this,
      `HttpWafAssociation-${props.stageName}`,
      {
        webAclArn: webAcl.attrArn,
        resourceArn: stageArn,
      }
    );

    this.apiId = this.api.apiId;
    this.stageName = props.stageName;
    this.url = `https://${this.api.apiId}.execute-api.${
      Stack.of(this).region
    }.amazonaws.com/${props.stageName}`;
  }
}
