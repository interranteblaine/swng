import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionRepository, Session } from "@swng/application";
import type { IsoDateTime } from "@swng/domain";
import { toSessionItem, fromSessionItem, SessionItem } from "./sessionItems";
import { SESSION_SK, sessionPk } from "./keys";
import { DynamoConfig } from "./config";

export function createDynamoSessionRepository(
  config: DynamoConfig
): SessionRepository {
  const { tableName, docClient, logger } = config;

  async function getSession(sessionId: string): Promise<Session | null> {
    logger?.debug("DDB getSession", { tableName, sessionId });
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: sessionPk(sessionId),
          SK: SESSION_SK,
        },
      })
    );

    if (!result.Item) return null;

    return fromSessionItem(result.Item as SessionItem);
  }

  async function createSession(session: Session): Promise<void> {
    const item = toSessionItem(session);

    logger?.debug("DDB createSession", {
      tableName,
      sessionId: session.sessionId,
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function updateSessionExpiry(
    sessionId: string,
    newExpiresAt: IsoDateTime
  ): Promise<void> {
    logger?.debug("DDB updateSessionExpiry", { tableName, sessionId, newExpiresAt });

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: sessionPk(sessionId),
          SK: SESSION_SK,
        },
        UpdateExpression: "SET expiresAt = :ea, #ttl = :ttl",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":ea": newExpiresAt,
          ":ttl": Math.floor(new Date(newExpiresAt).getTime() / 1000),
        },
      })
    );
  }

  return { getSession, createSession, updateSessionExpiry };
}
