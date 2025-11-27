import type {
  APIGatewayAuthorizerResult,
  APIGatewayRequestAuthorizerEvent,
  APIGatewayRequestAuthorizerHandler,
  Context,
} from "aws-lambda";
import {
  createDynamoDocClient,
  createDynamoSessionRepository,
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
  serviceName: "ws-authorizer",
  logLevel,
});
const docClient = createDynamoDocClient({ region });

function extractSessionId(
  event: APIGatewayRequestAuthorizerEvent
): string | null {
  const qs = event.queryStringParameters?.session;
  if (typeof qs === "string" && qs.trim().length > 0) {
    return qs.trim();
  }
  return null;
}

function allowPolicy(
  principalId: string,
  context: Record<string, string>
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: "Allow",
          Resource: "*",
        },
      ],
    },
    context,
  };
}

function denyPolicy(principalId = "unauthorized"): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: "Deny",
          Resource: "*",
        },
      ],
    },
  };
}

export const handler: APIGatewayRequestAuthorizerHandler = async (
  event: APIGatewayRequestAuthorizerEvent,
  context: Context
): Promise<APIGatewayAuthorizerResult> => {
  const invocationLogger = baseLogger.with({
    awsRequestId: context.awsRequestId,
    functionName: context.functionName,
    coldStart,
    routeKey: event?.requestContext?.routeKey,
  });

  try {
    const sessionId = extractSessionId(event);
    if (!sessionId) {
      invocationLogger.warn("Missing or invalid session querystring");
      return denyPolicy();
    }

    const sessionRepo = createDynamoSessionRepository({
      tableName,
      docClient,
      logger: invocationLogger,
    });

    const session = await sessionRepo.getSession(sessionId);
    if (!session) {
      invocationLogger.info("Session not found", { sessionId });
      return denyPolicy();
    }

    const result = allowPolicy(session.playerId, {
      roundId: session.roundId,
      playerId: session.playerId,
    });

    invocationLogger.debug("Authorizer allow", {
      sessionId,
      roundId: session.roundId,
      playerId: session.playerId,
    });

    return result;
  } catch (err: unknown) {
    // On authorizer failure, deny by default
    invocationLogger.error("Authorizer error", { err });
    return denyPolicy();
  } finally {
    coldStart = false;
  }
};
