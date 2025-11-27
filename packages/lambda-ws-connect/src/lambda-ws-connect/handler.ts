import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
  Context,
} from "aws-lambda";
import {
  createDynamoConnectionRepository,
  createDynamoDocClient,
} from "@swng/adapters-dynamodb";
import { createPowertoolsLogger } from "@swng/adapters-powertools-logger";

const tableName = process.env.DYNAMO_TABLE;
const region = process.env.AWS_REGION;
const logLevel =
  (process.env.LOG_LEVEL as "DEBUG" | "INFO" | "WARN" | "ERROR" | undefined) ||
  "INFO";

if (!tableName) {
  throw new Error("Missing required env: DYNAMO_TABLE");
}

let coldStart = true;
const baseLogger = createPowertoolsLogger({
  serviceName: "ws-connect",
  logLevel,
});
const docClient = createDynamoDocClient({ region });

interface WsAuthContext {
  roundId: string;
  playerId: string;
}

interface WsAuthorizerEnvelope {
  authorizer?: {
    roundId?: string;
    playerId?: string;
  };
}

function readAuthorizerContext(
  event: APIGatewayProxyWebsocketEventV2
): WsAuthContext | null {
  // Expect the REQUEST authorizer to place values at requestContext.authorizer
  const ctxWithAuth = event.requestContext as unknown as WsAuthorizerEnvelope;
  const roundId = ctxWithAuth.authorizer?.roundId;
  const playerId = ctxWithAuth.authorizer?.playerId;

  if (typeof roundId === "string" && typeof playerId === "string") {
    return { roundId, playerId };
  }
  return null;
}

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> => {
  const invocationLogger = baseLogger.with({
    awsRequestId: context.awsRequestId,
    functionName: context.functionName,
    coldStart,
    routeKey: event.requestContext?.routeKey,
  });

  try {
    const connectionId = event.requestContext?.connectionId;
    if (!connectionId) {
      invocationLogger.warn("WS $connect missing connectionId");
      return { statusCode: 400, body: "Missing connectionId" };
    }

    const auth = readAuthorizerContext(event);
    if (!auth) {
      invocationLogger.warn("WS $connect missing authorizer context", {
        connectionId,
      });
      return { statusCode: 401, body: "Unauthorized" };
    }

    const connectionRepo = createDynamoConnectionRepository({
      tableName,
      docClient,
      logger: invocationLogger,
    });

    const ttlSeconds = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24h

    await connectionRepo.addConnection(
      {
        roundId: auth.roundId,
        connectionId,
        playerId: auth.playerId,
        connectedAt: new Date().toISOString(),
      },
      ttlSeconds
    );

    invocationLogger.info("WS $connect: connection added", {
      roundId: auth.roundId,
      playerId: auth.playerId,
      connectionId,
    });

    return { statusCode: 200 };
  } catch (err: unknown) {
    invocationLogger.error("WS $connect failed", { err });
    return { statusCode: 500, body: "Internal Server Error" };
  } finally {
    coldStart = false;
  }
};
