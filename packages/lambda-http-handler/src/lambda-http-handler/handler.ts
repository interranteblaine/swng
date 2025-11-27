import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createRoundService } from "@swng/application";
import {
  createDynamoDocClient,
  createDynamoPlayerRepository,
  createDynamoRoundRepository,
  createDynamoScoreRepository,
  createDynamoSessionRepository,
  createDynamoConnectionRepository,
} from "@swng/adapters-dynamodb";
import { createPowertoolsLogger } from "@swng/adapters-powertools-logger";
import {
  createApiGatewayBroadcastPort,
  createApiGatewayManagementClient,
} from "@swng/adapters-apigw-broadcast";
import { clock, idGenerator } from "./runtime";
import { toHttpErrorResponse } from "./httpUtils";
import { routeRequest } from "./router";

const tableName = process.env.DYNAMO_TABLE;
const region = process.env.AWS_REGION;
const wsEndpoint = process.env.WS_MANAGEMENT_ENDPOINT;
const logLevel =
  (process.env.LOG_LEVEL as "DEBUG" | "INFO" | "WARN" | "ERROR" | undefined) ||
  "INFO";
const sessionTtlMs =
  process.env.SESSION_TTL_MS !== undefined
    ? Number(process.env.SESSION_TTL_MS)
    : 24 * 60 * 60 * 1000; // default 24h

if (!tableName) {
  throw new Error("Missing required env: DYNAMO_TABLE");
}
if (!wsEndpoint) {
  throw new Error("Missing required env: WS_MANAGEMENT_ENDPOINT");
}

let coldStart = true;

const baseLogger = createPowertoolsLogger({
  serviceName: "http-handler",
  logLevel,
});

const docClient = createDynamoDocClient({ region });
const apigwClient = createApiGatewayManagementClient({
  endpoint: wsEndpoint,
  region,
});

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const invocationLogger = baseLogger.with({
    awsRequestId: context.awsRequestId,
    functionName: context.functionName,
    coldStart,
  });

  const dynamoCfg = { tableName, docClient, logger: invocationLogger };

  const broadcast = createApiGatewayBroadcastPort({
    client: apigwClient,
    connectionRepo: createDynamoConnectionRepository(dynamoCfg),
    logger: invocationLogger,
  });

  const service = createRoundService({
    roundRepo: createDynamoRoundRepository(dynamoCfg),
    playerRepo: createDynamoPlayerRepository(dynamoCfg),
    scoreRepo: createDynamoScoreRepository(dynamoCfg),
    sessionRepo: createDynamoSessionRepository(dynamoCfg),
    idGenerator,
    clock,
    config: { sessionTtlMs },
    broadcast,
  });

  try {
    const result = await routeRequest(event, service);
    return result;
  } catch (err: unknown) {
    return toHttpErrorResponse(err, invocationLogger);
  } finally {
    coldStart = false;
  }
};
