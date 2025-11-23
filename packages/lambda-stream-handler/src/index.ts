import { createPowertoolsLogger } from "@swng/adapters-powertools-logger";
import {
  createApiGatewayBroadcastPort,
  createApiGatewayBroadcastConfigFrom,
} from "@swng/adapters-apigw-broadcast";
import {
  createDynamoConnectionRepository,
  createDynamoConfigFrom,
} from "@swng/adapters-dynamodb";
import { createStreamHandler } from "./lambda-stream-handler/handler";

const endpoint = process.env.WS_MANAGEMENT_ENDPOINT;
const region = process.env.AWS_REGION;
const tableName = process.env.DYNAMO_TABLE;
const logLevel =
  (process.env.LOG_LEVEL as "INFO" | "DEBUG" | "WARN" | "ERROR" | undefined) ||
  "INFO";

if (!endpoint) throw new Error("Missing required env: WS_MANAGEMENT_ENDPOINT");
if (!tableName) throw new Error("Missing required env: DYNAMO_TABLE");

const logger = createPowertoolsLogger({
  serviceName: "stream-handler",
  logLevel,
});

const dynamoCfg = createDynamoConfigFrom({
  tableName,
  region,
});

const connectionRepo = createDynamoConnectionRepository(dynamoCfg);

const broadcastCfg = createApiGatewayBroadcastConfigFrom({
  endpoint,
  region,
  connectionRepo,
  logger,
});

const broadcast = createApiGatewayBroadcastPort(broadcastCfg);

export const handler = createStreamHandler({ broadcast, logger });
