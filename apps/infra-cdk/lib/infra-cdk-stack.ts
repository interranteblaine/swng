import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DataStore } from "./constructs/data-store.js";
import { HttpApiInfra } from "./constructs/http-api.js";
import { WebSocketInfra } from "./constructs/websocket.js";
import { WebAppInfra } from "./constructs/web-app.js";

interface InfraProps extends StackProps {
  stage: "beta" | "prod";
  httpApiRateLimit?: number;
  httpApiBurstLimit?: number;
}

export class InfraCdkStack extends Stack {
  constructor(scope: Construct, id: string, props: InfraProps) {
    super(scope, id, props);

    const stage = props.stage;

    // Data layer
    const data = new DataStore(this, `DataStore-${stage}`, {
      stage,
    });

    // WebSocket API + authorizer + connect/disconnect
    const ws = new WebSocketInfra(this, `WebSocket-${stage}`, {
      table: data.table,
      stageName: stage,
    });

    // HTTP API + Lambda + API Gateway Management API
    const http = new HttpApiInfra(this, `Http-${stage}`, {
      table: data.table,
      stageName: stage,
      wsApiId: ws.apiId,
      rateLimit: props.httpApiRateLimit,
      burstLimit: props.httpApiBurstLimit,
      allowedOrigins:
        stage === "beta"
          ? ["https://beta.swng.golf", "http://localhost:5173"]
          : ["https://swng.golf"],
    });

    // UI (S3 + CloudFront) with DNS
    new WebAppInfra(this, `WebApp-${stage}`, {
      stage: stage,
      zoneDomain: "swng.golf",
      hostName: stage === "beta" ? "beta" : undefined,
    });

    // Outputs
    new CfnOutput(this, `DynamoTableName-${stage}`, {
      value: data.tableName,
      exportName: `DynamoTableName-${stage}`,
    });

    new CfnOutput(this, `HttpApiUrl-${stage}`, {
      value: http.url,
      exportName: `HttpApiUrl-${stage}`,
    });

    new CfnOutput(this, `WsApiId-${stage}`, {
      value: ws.apiId,
      exportName: `WsApiId-${stage}`,
    });

    new CfnOutput(this, `WsWssUrl-${stage}`, {
      value: ws.wssUrl,
      exportName: `WsWssUrl-${stage}`,
    });
  }
}
