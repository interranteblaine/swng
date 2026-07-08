import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundArchive, RoundId } from "@swng/domain";
import type { RoundStore } from "@swng/application";
import { archiveSk, metaSk, roundPk } from "./keys.js";

export const createDynamoRoundStore = (config: { client: DynamoDBDocumentClient; tableName: string }): RoundStore => {
  const { client, tableName } = config;

  return {
    createRound: async ({ roundId, joinCode }) => {
      // Conditional on the round not already existing — StartRound always mints a fresh
      // RoundId, so a collision here means a real bug upstream, not a retry to absorb.
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: roundPk(roundId), sk: metaSk, joinCode, roundId },
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
    },

    findByJoinCode: async (code: string) => {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "joinCode = :code",
          ExpressionAttributeValues: { ":code": code },
          Limit: 1,
        }),
      );
      const item = result.Items?.[0] as { roundId: RoundId } | undefined;
      return item?.roundId;
    },

    putArchive: async (archive: RoundArchive) => {
      // Unconditional upsert (M3 plan): re-finalizing a reopened round overwrites the prior
      // archive — settlement is idempotent, not append-only, at this layer.
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: roundPk(archive.roundId), sk: archiveSk, archive },
        }),
      );
    },
  };
};
