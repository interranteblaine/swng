import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CardId, CardRecord, CourseId } from "@swng/domain";
import { courseNameKey } from "@swng/domain";
import type { CardStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { cardSk, courseCurrentSk, courseGsi1pk, courseIdFromPk, coursePk } from "./keys.js";

// Course-cards spec §5. Two item kinds under one lineage partition:
//   pk=COURSE#<courseId> sk=CURRENT        — mutable pointer {cardId, name, holeCount, gsi1 keys}
//   pk=COURSE#<courseId> sk=CARD#<cardId>  — write-once {record: CardRecord}
// Cards are immutable, so a torn read is unrepresentable: whichever pointer a reader sees
// names a complete, frozen item. One transaction shape per write; one 409 (card-superseded).
export const createDynamoCardStore = (config: { client: DynamoDBDocumentClient; tableName: string }): CardStore => {
  const { client, tableName } = config;

  const cardPut = (record: CardRecord) => ({
    Put: {
      TableName: tableName,
      Item: { pk: coursePk(record.courseId), sk: cardSk(record.cardId), record },
      // Write-once enforced by the database, not convention (spec invariant 1).
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });

  const pointerAttrs = (record: CardRecord) => ({
    cardId: record.cardId,
    name: record.card.courseName,
    holeCount: record.card.teeSets[0]!.holes.length, // uniform across tees (validateCard)
    gsi1pk: courseGsi1pk,
    gsi1sk: courseNameKey(record.card.courseName), // the ONE normalization (domain) — search's Query uses the same
  });

  return {
    create: async (record: CardRecord) => {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            cardPut(record),
            {
              Put: {
                TableName: tableName,
                Item: { pk: coursePk(record.courseId), sk: courseCurrentSk, ...pointerAttrs(record) },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    },

    supersede: async (record: CardRecord) => {
      if (record.supersedes === undefined) throw new Error("supersede: record.supersedes is required");
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              cardPut(record),
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: coursePk(record.courseId), sk: courseCurrentSk },
                  UpdateExpression: "SET cardId = :cardId, #name = :name, holeCount = :holeCount, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
                  // The one concurrency rule (spec §6): the pointer must still name the exact
                  // card the caller reviewed.
                  ConditionExpression: "cardId = :supersedes",
                  ExpressionAttributeNames: { "#name": "name" },
                  ExpressionAttributeValues: { ":supersedes": record.supersedes, ...prefixColons(pointerAttrs(record)) },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (error instanceof TransactionCanceledException && error.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")) {
          throw new ApplicationError("card-superseded", `course ${record.courseId}: the card being replaced is no longer current`);
        }
        throw error;
      }
    },

    getCurrent: async (id: CourseId) => {
      // Consistent on both hops: the pointer names an immutable item, so the second read can
      // only miss if it outraces replication of the very transaction that wrote both — and
      // startRound's freeze must never act on a pointer whose card it cannot read.
      const pointer = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: coursePk(id), sk: courseCurrentSk }, ConsistentRead: true }),
      );
      const current = pointer.Item as { cardId: CardId } | undefined;
      if (!current) return undefined;
      const card = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: coursePk(id), sk: cardSk(current.cardId) }, ConsistentRead: true }),
      );
      return (card.Item as { record: CardRecord } | undefined)?.record;
    },

    search: async (nameKeyPrefix: string, limit: number) => {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)",
          ExpressionAttributeValues: { ":gsi1pk": courseGsi1pk, ":prefix": nameKeyPrefix },
          Limit: limit,
        }),
      );
      const keys = (result.Items ?? []).map((item) => ({ pk: item.pk as string, sk: courseCurrentSk }));
      if (keys.length === 0) return [];
      // gsi1's INCLUDE projection carries `name` only (unchanged from M6 — no stack change);
      // holeCount comes from a BatchGet of the ≤25 pointer items themselves. Two hops, both
      // trivial at this scale, zero infra churn (plan's deliberate trade — spec §4's search
      // response needs holeCount to distinguish routings entered as separate lineages).
      const batch = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys } } }));
      const byPk = new Map((batch.Responses?.[tableName] ?? []).map((item) => [item.pk as string, item]));
      return keys
        .map((key) => byPk.get(key.pk))
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => ({
          courseId: courseIdFromPk(item.pk as string),
          name: item.name as string,
          holeCount: item.holeCount as 9 | 18,
        }));
    },
  };
};

// TransactWriteCommand ExpressionAttributeValues want ":"-prefixed keys — one tiny mapper
// rather than five hand-typed pairs that could drift from pointerAttrs.
const prefixColons = (attrs: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(attrs).map(([k, v]) => [`:${k}`, v]));
