import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundId } from "@swng/domain";
import type { Connection, ConnectionRepository } from "@swng/application";
import { roundPk, CONNECTION_SK_PREFIX, connectionSk } from "./keys";
import type { DynamoConfig } from "./config";
import {
  ConnectionItem,
  toConnectionItem,
  fromConnectionItem,
} from "./connectionItems";

export function createDynamoConnectionRepository(
  config: DynamoConfig
): ConnectionRepository {
  const { tableName, docClient } = config;

  async function addConnection(
    connection: Connection,
    ttlSeconds?: number
  ): Promise<void> {
    const item: ConnectionItem = toConnectionItem(connection, ttlSeconds);

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function removeConnection(
    roundId: RoundId,
    connectionId: string
  ): Promise<void> {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: roundPk(roundId),
          SK: connectionSk(connectionId),
        },
      })
    );
  }

  async function listConnections(roundId: RoundId): Promise<Connection[]> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": roundPk(roundId),
          ":skPrefix": CONNECTION_SK_PREFIX,
        },
      })
    );

    const items = (result.Items ?? []) as ConnectionItem[];
    return items.map(fromConnectionItem);
  }

  return {
    addConnection,
    removeConnection,
    listConnections,
  };
}
