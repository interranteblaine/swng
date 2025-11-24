import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundId } from "@swng/domain";
import type {
  Connection,
  ConnectionRepository,
  Logger,
} from "@swng/application";
import { roundPk, CONNECTION_SK_PREFIX, connectionSk } from "./keys";
import type { DynamoConfig } from "./config";
import {
  ConnectionItem,
  toConnectionItem,
  fromConnectionItem,
} from "./connectionItems";

export function createDynamoConnectionRepository(
  config: DynamoConfig,
  opts?: { logger?: Logger }
): ConnectionRepository {
  const { tableName, docClient } = config;
  const log = opts?.logger;

  async function addConnection(
    connection: Connection,
    ttlSeconds?: number
  ): Promise<void> {
    const item: ConnectionItem = toConnectionItem(connection, ttlSeconds);

    log?.debug("DDB addConnection", {
      tableName,
      roundId: connection.roundId,
      connectionId: connection.connectionId,
      ttlSeconds,
    });

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
    log?.debug("DDB removeConnection", { tableName, roundId, connectionId });
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
    const connections = items.map(fromConnectionItem);
    log?.debug("DDB listConnections", {
      tableName,
      roundId,
      count: connections.length,
    });
    return connections;
  }

  return {
    addConnection,
    removeConnection,
    listConnections,
  };
}
