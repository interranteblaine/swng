import { createPowertoolsLogger } from "@swng/adapters-powertools-logger";
import {
  createApiGatewayBroadcastPort,
  createApiGatewayManagementClient,
} from "@swng/adapters-apigw-broadcast";
import {
  createDynamoConnectionRepository,
  createDynamoDocClient,
} from "@swng/adapters-dynamodb";
import type { DynamoDBStreamHandler } from "aws-lambda";
import { processStreamEventBatch } from "./processor";

const endpoint = process.env.WS_MANAGEMENT_ENDPOINT;
const region = process.env.AWS_REGION;
const tableName = process.env.DYNAMO_TABLE;
const logLevel =
  (process.env.LOG_LEVEL as "INFO" | "DEBUG" | "WARN" | "ERROR" | undefined) ||
  "INFO";

if (!endpoint) throw new Error("Missing required env: WS_MANAGEMENT_ENDPOINT");
if (!tableName) throw new Error("Missing required env: DYNAMO_TABLE");

const baseLogger = createPowertoolsLogger({
  serviceName: "stream-handler",
  logLevel,
});

const docClient = createDynamoDocClient({ region });

const apigwClient = createApiGatewayManagementClient({
  endpoint,
  region,
});

let coldStart = true;

export const handler: DynamoDBStreamHandler = async (event, context) => {
  const invocationLogger = baseLogger.with({
    awsRequestId: context.awsRequestId,
    functionName: context.functionName,
    coldStart,
  });

  const connectionRepo = createDynamoConnectionRepository({
    tableName,
    docClient,
    logger: invocationLogger,
  });

  const broadcast = createApiGatewayBroadcastPort({
    client: apigwClient,
    connectionRepo,
    logger: invocationLogger,
  });

  await processStreamEventBatch(event, { broadcast, logger: invocationLogger });

  coldStart = false;
};
