import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundArchive, RoundId } from "@swng/domain";
import type { SnapshotStore } from "@swng/application";
import { snapshotPk } from "./keys.js";
import { parseStoredArchive } from "./parseStored.js";

// DynamoDB caps one BatchGetItem at 100 keys — getMany chunks its input to stay under it.
const BATCH_GET_MAX_KEYS = 100;

// A page cursor is just the DynamoDB LastEvaluatedKey, JSON-serialized and base64url-encoded so
// it survives as an opaque string a caller can hand back verbatim (SnapshotStore's port doc:
// the cursor is opaque). base64url (not base64) because these can end up in URLs/logs.
const encodeCursor = (key: Record<string, unknown>): string => Buffer.from(JSON.stringify(key)).toString("base64url");
const decodeCursor = (cursor: string): Record<string, unknown> => JSON.parse(Buffer.from(cursor, "base64url").toString());

// The read side of the snapshots table (projection-realignment spec §11: "the atom") — pk-only,
// keyed by the bare roundId (snapshotPk). There is deliberately NO write method: a snapshot is
// only ever written as one leg of createDynamoEventJournal's atomic finalize transaction, never
// through this store, so no code path can persist a snapshot whose round-finalized event never
// landed. `pageLimit` is a test injection point (the contract suite forces a tiny page to walk
// the cursor across several pages); production omits it and pages at DynamoDB's natural ~1MB.
export const createDynamoSnapshotStore = (config: { client: DynamoDBDocumentClient; tableName: string; pageLimit?: number }): SnapshotStore => {
  const { client, tableName, pageLimit } = config;

  const get: SnapshotStore["get"] = async (roundId: RoundId) => {
    // ConsistentRead: finalizeRound's idempotent branch reads this to decide "already final —
    // hand back the stored results, don't re-append"; a retry landing moments after this
    // round's own atomic finalize commit must never miss the snapshot that commit just wrote
    // (same rationale as every base-table read in this adapter family that feeds a next decision).
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk: snapshotPk(roundId) }, ConsistentRead: true }));
    if (result.Item === undefined) return undefined;
    // Absent and corrupt stay different facts. Collapsing a corrupt archive into `undefined` would
    // make finalizeRound's idempotent branch report "is final but has no snapshot — corrupt" — a
    // true-sounding sentence naming the wrong fault, since the snapshot is right there and only its
    // SHAPE is wrong — and would make getRoundArchive answer round-not-found for a round that is
    // very much on file. The throw below says which field, on which round.
    return parseStoredArchive(`createDynamoSnapshotStore.get: round ${roundId}`, result.Item["archive"]);
  };

  return {
    get,

    getMany: async (roundIds: readonly RoundId[]) => {
      // Dedupe first — BatchGetItem rejects a request that names the same key twice.
      const uniqueKeys = [...new Set(roundIds.map((id) => snapshotPk(id)))].map((pk) => ({ pk }));
      const archives: RoundArchive[] = [];

      for (let i = 0; i < uniqueKeys.length; i += BATCH_GET_MAX_KEYS) {
        let remaining: { pk: string }[] | undefined = uniqueKeys.slice(i, i + BATCH_GET_MAX_KEYS);
        // Absent ids are simply not returned (SnapshotStore's port doc); UnprocessedKeys (a
        // throttle/size backpressure signal, not an error) are re-driven until the chunk drains.
        while (remaining && remaining.length > 0) {
          const result = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: remaining } } }));
          for (const item of result.Responses?.[tableName] ?? []) {
            archives.push(parseStoredArchive(`createDynamoSnapshotStore.getMany: round ${String(item["pk"])}`, item["archive"]));
          }
          remaining = result.UnprocessedKeys?.[tableName]?.Keys as { pk: string }[] | undefined;
        }
      }

      return archives;
    },

    page: async (cursor?: string) => {
      const result = await client.send(
        new ScanCommand({
          TableName: tableName,
          Limit: pageLimit,
          ExclusiveStartKey: cursor !== undefined ? decodeCursor(cursor) : undefined,
        }),
      );
      // A page that can't be parsed stops the backfill at that page rather than projecting garbage
      // from it. `rebuildProjections` is cursor-resumable, so the operator sees exactly which
      // snapshot is bad and the walk resumes from the cursor once it's dealt with.
      const snapshots = (result.Items ?? []).map((item) => parseStoredArchive(`createDynamoSnapshotStore.page: round ${String(item["pk"])}`, item["archive"]));
      return { snapshots, cursor: result.LastEvaluatedKey !== undefined ? encodeCursor(result.LastEvaluatedKey) : undefined };
    },
  };
};
