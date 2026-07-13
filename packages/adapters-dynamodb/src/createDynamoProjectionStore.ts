import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { GolferId, GolferRoundLine, RoundId } from "@swng/domain";
import type { ProjectionStore } from "@swng/application";
import { golferPk, lineSk, lineSkPrefix, liveSk, liveSkPrefix, projectionIndexSk } from "./keys.js";
import { queryAllPages } from "./paginate.js";

// `createdAtMs` (accounts-only identity spec §5) rides inside the stored `line` map like every
// other line field — putLine writes the whole object and listLines reads it back, so no per-field
// marshalling is needed. Optional: lines written before the field existed simply lack it on read.
type Line = GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number };
type IndexSnapshot = { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };
type LiveEntry = { readonly roundId: RoundId; readonly courseName: string; readonly joinedAtMs: number; readonly expiresAtSec: number };

export const createDynamoProjectionStore = (config: { client: DynamoDBDocumentClient; tableName: string }): ProjectionStore => {
  const { client, tableName } = config;

  return {
    // The stable-key point (projection-realignment spec §3): `lineSk` embeds ONLY the roundId,
    // so a reopen-and-refinalize (a NEW finalizedAtMs, the SAME roundId) computes the SAME sk
    // both times — this ONE unconditional Put IS the whole upsert. No prior-item lookup, no
    // delete: the old query-then-delete-then-put idiom existed solely to clean up a stale sk a
    // time-embedded key could strand, and a key that never embeds time can never strand one.
    putLine: async (golferId: GolferId, line: Line) => {
      await client.send(new PutCommand({ TableName: tableName, Item: { pk: golferPk(golferId), sk: lineSk(line.roundId), line } }));
    },

    // UNORDERED (ProjectionStore's own port doc) — the sk carries no time to sort by anymore,
    // so this is a plain begins_with Query with no ScanIndexForward promise. Every caller sorts
    // by the `finalizedAtMs` each line carries itself (projections/projectArchive.ts's
    // sortLines).
    listLines: (golferId: GolferId): Promise<readonly Line[]> =>
      queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": golferPk(golferId), ":prefix": lineSkPrefix },
        },
        (item) => item.line as Line,
      ),

    putIndex: async (golferId: GolferId, snapshot: IndexSnapshot) => {
      // Unconditional upsert: each finalize recomputes the whole snapshot from every line on
      // file, never patches it incrementally.
      await client.send(new PutCommand({ TableName: tableName, Item: { pk: golferPk(golferId), sk: projectionIndexSk, snapshot } }));
    },

    getIndex: async (golferId: GolferId) => {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: golferPk(golferId), sk: projectionIndexSk },
          ConsistentRead: true,
        }),
      );
      return result.Item?.snapshot as IndexSnapshot | undefined;
    },

    // Presence (spec §5) — a register, not a projection: no rebuild path, none needed. `ttl` is
    // the item's OWN top-level attribute (DynamoDB TTL requires a top-level Number), set to
    // `expiresAtSec` — the projections table's TTL spec names this exact attribute (Task 1).
    putLive: async (golferId: GolferId, entry: LiveEntry) => {
      const { roundId, courseName, joinedAtMs, expiresAtSec } = entry;
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: golferPk(golferId), sk: liveSk(roundId), live: { roundId, courseName, joinedAtMs }, ttl: expiresAtSec },
        }),
      );
    },

    deleteLive: async (golferId: GolferId, roundId: RoundId) => {
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: golferPk(golferId), sk: liveSk(roundId) } }));
    },

    listLive: (golferId: GolferId) =>
      queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": golferPk(golferId), ":prefix": liveSkPrefix },
        },
        (item) => item.live as { roundId: RoundId; courseName: string; joinedAtMs: number },
      ),

    // The crew ledger methods are GONE (architecture-realignment Task 9, spec §4/§9): crew
    // standings are computed on read over the snapshots table (crews/getSeasonStandings), so this
    // store — and the projections table it backs — no longer holds any crew keyspace.
  };
};
