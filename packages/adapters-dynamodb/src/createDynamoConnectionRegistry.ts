import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundId } from "@swng/domain";
import type { ConnectionRegistry } from "@swng/application";
import { connPk } from "./keys.js";

export const createDynamoConnectionRegistry = (config: { client: DynamoDBDocumentClient; tableName: string }): ConnectionRegistry => {
  const { client, tableName } = config;

  return {
    register: async (connectionId: string, roundId: RoundId) => {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: connPk(connectionId), connectionId, roundId },
        }),
      );
    },

    deregister: async (connectionId: string) => {
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { pk: connPk(connectionId) },
        }),
      );
    },

    listByRound: async (roundId: RoundId): Promise<readonly string[]> => {
      const connectionIds: string[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const result = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "gsi1",
            KeyConditionExpression: "roundId = :roundId",
            ExpressionAttributeValues: { ":roundId": roundId },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        for (const item of result.Items ?? []) connectionIds.push((item as { connectionId: string }).connectionId);
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);

      return connectionIds;
    },
  };
};
