import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundId } from "@swng/domain";
import type { ConnectionRegistry } from "@swng/application";
import { connPk } from "./keys.js";
import { queryAllPages } from "./paginate.js";

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

    listByRound: (roundId: RoundId): Promise<readonly string[]> =>
      queryAllPages(
        client,
        {
          TableName: tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "roundId = :roundId",
          ExpressionAttributeValues: { ":roundId": roundId },
        },
        (item) => (item as { connectionId: string }).connectionId,
      ),
  };
};
