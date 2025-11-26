import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DataStore } from "./constructs/data-store.js";
import { HttpApiInfra } from "./constructs/http-api.js";
import { WebSocketInfra } from "./constructs/websocket.js";
import { StreamingInfra } from "./constructs/streaming.js";

interface InfraProps extends StackProps {
  stage: "beta" | "prod";
  wafRateLimitPer5Min?: number;
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

    // HTTP API + Lambda + WAF
    const http = new HttpApiInfra(this, `Http-${stage}`, {
      table: data.table,
      stageName: stage,
      wafRateLimitPer5Min: props.wafRateLimitPer5Min,
    });

    // Stream processor -> API Gateway Management API
    new StreamingInfra(this, `Streaming-${stage}`, {
      table: data.table,
      wsApiId: ws.apiId,
      stageName: stage,
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
