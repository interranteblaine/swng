import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { OpId, RoundEvent, RoundId } from "@swng/domain";
import type { AppendResult, EventJournal } from "@swng/application";
import { evtSk, evtSkMax, opIdSk, roundPk } from "./keys.js";

// Each Query page is capped well under DynamoDB's natural ~1MB boundary so `read` always
// exercises its own pagination loop rather than relying on payload size — a round's log is
// a few thousand events at outing scale (architecture.md), never remotely 1MB.
const READ_PAGE_SIZE = 50;

// A seq race or an opId race can each cost one round-trip; this bounds the retry loop so a
// pathological hot round fails loudly instead of spinning forever.
const MAX_APPEND_ATTEMPTS = 10;

const headSeq = async (client: DynamoDBDocumentClient, tableName: string, roundId: RoundId): Promise<number> => {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :evtPrefix)",
      ExpressionAttributeValues: { ":pk": roundPk(roundId), ":evtPrefix": "EVT#" },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const head = result.Items?.[0] as { event: RoundEvent } | undefined;
  return head?.event.seq ?? 0;
};

// Stamps `batch` starting at `head + 1` and attempts to land every event + its OPID marker
// in one transaction. Returns the events that need retrying (either because their own EVT
// slot lost a seq race, or because a sibling in the same transaction did and rolled the
// whole batch back) alongside any opIds now confirmed as permanent duplicates.
const attemptCommit = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  roundId: RoundId,
  batch: readonly RoundEvent[],
  head: number,
): Promise<{ committed: readonly RoundEvent[] } | { retry: readonly RoundEvent[]; duplicateOpIds: readonly OpId[] }> => {
  const stamped = batch.map((event, i) => ({ ...event, seq: head + 1 + i }));

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: stamped.flatMap((event) => [
          {
            Put: {
              TableName: tableName,
              Item: { pk: roundPk(roundId), sk: evtSk(event.seq), event, opId: event.opId },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: { pk: roundPk(roundId), sk: opIdSk(event.opId) },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
        ]),
      }),
    );
    return { committed: stamped };
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;
    const reasons = error.CancellationReasons ?? [];
    const retry: RoundEvent[] = [];
    const duplicateOpIds: OpId[] = [];
    batch.forEach((event, i) => {
      // Reasons parallel TransactItems 1:1: [evtPut0, opidPut0, evtPut1, opidPut1, ...].
      // An OPID collision means this exact opId already landed — permanent, no retry. Any
      // other outcome (its own EVT slot lost a seq race, or it was rolled back only because
      // a sibling in the batch failed) needs a fresh seq on the next attempt.
      const opidReason = reasons[i * 2 + 1];
      if (opidReason?.Code === "ConditionalCheckFailed") {
        duplicateOpIds.push(event.opId);
      } else {
        retry.push(event);
      }
    });
    return { retry, duplicateOpIds };
  }
};

export const createDynamoEventJournal = (config: { client: DynamoDBDocumentClient; tableName: string }): EventJournal => {
  const { client, tableName } = config;

  return {
    append: async (roundId: RoundId, events: readonly RoundEvent[]): Promise<AppendResult> => {
      let pending = events;
      const duplicateOpIds: OpId[] = [];

      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt >= MAX_APPEND_ATTEMPTS) {
          throw new Error(`createDynamoEventJournal: append to round ${roundId} did not converge after ${MAX_APPEND_ATTEMPTS} attempts`);
        }

        const head = await headSeq(client, tableName, roundId);
        const outcome = await attemptCommit(client, tableName, roundId, pending, head);

        if ("committed" in outcome) return { appended: outcome.committed, duplicateOpIds };

        duplicateOpIds.push(...outcome.duplicateOpIds);
        pending = outcome.retry;
      }

      return { appended: [], duplicateOpIds };
    },

    read: async (roundId: RoundId, sinceSeq: number): Promise<readonly RoundEvent[]> => {
      const events: RoundEvent[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;

      do {
        const result = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
            ExpressionAttributeValues: { ":pk": roundPk(roundId), ":lo": evtSk(sinceSeq + 1), ":hi": evtSkMax },
            Limit: READ_PAGE_SIZE,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        for (const item of result.Items ?? []) events.push((item as { event: RoundEvent }).event);
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);

      return events;
    },
  };
};
