import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CrewId, CrewRoundContribution, GolferId, GolferRoundLine, RoundId } from "@swng/domain";
import type { CrewSeasonRecords, ProjectionStore } from "@swng/application";
import {
  crewRoundSk,
  crewRoundSkPrefix,
  crewRoundsPk,
  golferPk,
  lineSk,
  lineSkPrefix,
  liveSk,
  liveSkPrefix,
  projectionIndexSk,
  recordsPk,
  recordsSk,
} from "./keys.js";
import { queryAllPages } from "./paginate.js";

type Line = GolferRoundLine & { readonly finalizedAtMs: number };
type IndexSnapshot = { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };
type LiveEntry = { readonly roundId: RoundId; readonly courseName: string; readonly joinedAtMs: number; readonly expiresAtSec: number };
type CrewRoundEntry = CrewRoundContribution & { readonly finalizedAtMs: number };

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

    // DELETED IN REALIGNMENT TASK 9 — UNCHANGED from before this task (ProjectionStore's own
    // doc comment: kept alive only so the still-live crew routes don't wedge mid-realignment).
    putCrewRound: async (crewId: CrewId, season: number, entry: CrewRoundEntry) => {
      const pk = crewRoundsPk(crewId, season);
      const newSk = crewRoundSk(entry.finalizedAtMs, entry.roundId);

      // Same query→delete→put idiom lineSk's own doc comment (keys.ts) documents replacing —
      // kept here verbatim because this whole keyspace dies in Task 9 rather than getting
      // patched. CORRECTION (M9 hardening ledger, still true): this dedupe only reaches entries
      // in THIS season's partition — a reopen-and-refinalize whose new finalizedAtMs lands in a
      // DIFFERENT UTC year strands the old season's entry unrepairably. Unreachable in v1
      // (nothing reopens a finalized round yet).
      const priorSks = await queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          FilterExpression: "#entry.roundId = :roundId",
          ExpressionAttributeNames: { "#entry": "entry" },
          ExpressionAttributeValues: { ":pk": pk, ":prefix": crewRoundSkPrefix, ":roundId": entry.roundId },
          ConsistentRead: true,
        },
        (item) => item.sk as string,
      );
      await Promise.all(priorSks.filter((sk) => sk !== newSk).map((sk) => client.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }))));

      await client.send(new PutCommand({ TableName: tableName, Item: { pk, sk: newSk, entry } }));
    },

    listCrewRounds: (crewId: CrewId, season: number): Promise<readonly CrewRoundEntry[]> =>
      queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": crewRoundsPk(crewId, season), ":prefix": crewRoundSkPrefix },
        },
        (item) => item.entry as CrewRoundEntry,
      ),

    putSeasonRecords: async (crewId: CrewId, season: number, records: CrewSeasonRecords) => {
      // Unconditional upsert (mirrors putIndex above): the projector always recomputes the
      // WHOLE (ledger, headToHead) snapshot from every one of that season's contributions
      // (crew/ledger.ts's aggregateSeason), never patches it incrementally.
      await client.send(new PutCommand({ TableName: tableName, Item: { pk: recordsPk(crewId, season), sk: recordsSk, records } }));
    },

    getSeasonRecords: async (crewId: CrewId, season: number) => {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: recordsPk(crewId, season), sk: recordsSk },
          ConsistentRead: true,
        }),
      );
      return result.Item?.records as CrewSeasonRecords | undefined;
    },

    wipeCrew: async (crewId: CrewId, seasons: readonly number[]) => {
      // `seasons` is supplied by the caller (rebuildProjections already collected them from
      // the archives it's about to replay) — this store never discovers its own keyspace
      // (port doc's explicit correction over the plan's stale "enumerate seasons" prose).
      await Promise.all(
        seasons.map(async (season) => {
          const pk = crewRoundsPk(crewId, season);
          const sks = await queryAllPages(
            client,
            { TableName: tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true },
            (item) => item.sk as string,
          );
          await Promise.all([
            ...sks.map((sk) => client.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }))),
            // The RECORDS item may or may not exist for this season — DeleteCommand is a
            // no-op either way, so no existence check is needed first.
            client.send(new DeleteCommand({ TableName: tableName, Key: { pk: recordsPk(crewId, season), sk: recordsSk } })),
          ]);
        }),
      );
    },
  };
};
