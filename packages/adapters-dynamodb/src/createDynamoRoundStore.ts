import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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
      // gsi1 lookups are always eventually consistent — DynamoDB GSIs don't support
      // ConsistentRead at all, unlike the base-table reads in createDynamoEventJournal. A
      // join code minted by createRound's Put a moment ago can transiently miss here before
      // the GSI catches up. Accepted: humans read a 6-character code off one screen and type
      // it into another over several seconds, which comfortably outlasts GSI propagation.
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

    getArchive: async (roundId: RoundId) => {
      // M9 hardening: backs finalizeRound.ts's repair-on-replay check — ConsistentRead so a
      // retry landing moments after this SAME process's own putArchive can never miss what it
      // just wrote (same rationale as every other base-table read in this adapter family that
      // feeds a caller's next decision, e.g. get()'s ConsistentRead elsewhere).
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: roundPk(roundId), sk: archiveSk }, ConsistentRead: true }),
      );
      const item = result.Item as { archive: RoundArchive } | undefined;
      return item?.archive;
    },
  };
};
