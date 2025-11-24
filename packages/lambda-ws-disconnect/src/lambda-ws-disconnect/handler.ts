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
  serviceName: "ws-disconnect",
  logLevel,
});
const docClient = createDynamoDocClient({ region });

interface WsAuthorizerEnvelope {
  authorizer?: {
    roundId?: string;
    playerId?: string;
  };
}

function readAuthorizerContext(
  event: APIGatewayProxyWebsocketEventV2
): { roundId: string } | null {
  const ctxWithAuth = event.requestContext as unknown as WsAuthorizerEnvelope;
  const roundId = ctxWithAuth.authorizer?.roundId;
  if (typeof roundId === "string") {
    return { roundId };
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
      invocationLogger.warn("WS $disconnect missing connectionId");
      return { statusCode: 200 };
    }

    const auth = readAuthorizerContext(event);
    if (!auth) {
      // No authorizer context; rely on 410 prune during broadcast. Still 200.
      invocationLogger.info(
        "WS $disconnect: no authorizer context; skipping delete",
        { connectionId }
      );
      return { statusCode: 200 };
    }

    const connectionRepo = createDynamoConnectionRepository({
      tableName,
      docClient,
      logger: invocationLogger,
    });

    await connectionRepo.removeConnection(auth.roundId, connectionId);

    invocationLogger.info("WS $disconnect: connection removed", {
      roundId: auth.roundId,
      connectionId,
    });

    return { statusCode: 200 };
  } catch (err: unknown) {
    // We don't want retries on disconnect. Log and return 200.
    invocationLogger.warn("WS $disconnect encountered error; ignoring", {
      err,
    });
    return { statusCode: 200 };
  } finally {
    coldStart = false;
  }
};
