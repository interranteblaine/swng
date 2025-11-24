import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionRepository, Session } from "@swng/application";
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

  return { getSession, createSession };
}
