import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CrewId, CrewRoundContribution, GolferId, GolferRoundLine } from "@swng/domain";
import type { CrewSeasonRecords, ProjectionStore } from "@swng/application";
import { crewRoundSk, crewRoundSkPrefix, crewRoundsPk, golferPk, historySk, historySkPrefix, projectionIndexSk, recordsPk, recordsSk } from "./keys.js";
import { queryAllPages } from "./paginate.js";

type HistoryLine = GolferRoundLine & { readonly finalizedAtMs: number };
type IndexSnapshot = { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };
type CrewRoundEntry = CrewRoundContribution & { readonly finalizedAtMs: number };

export const createDynamoProjectionStore = (config: { client: DynamoDBDocumentClient; tableName: string }): ProjectionStore => {
  const { client, tableName } = config;

  return {
    putHistoryLine: async (golferId: GolferId, line: HistoryLine) => {
      const pk = golferPk(golferId);
      const newSk = historySk(line.finalizedAtMs, line.roundId);

      // Upsert BY ROUND ID (architecture.md §4: "projections treat finalize as an idempotent
      // upsert by roundId and recompute") — not by sk. The sk encodes finalizedAtMs so
      // listHistory's oldest-first order falls out of the base Query for free, but that means
      // a reopen-and-refinalize (a NEW round-finalized event, a DIFFERENT finalizedAtMs, the
      // SAME roundId) computes a DIFFERENT sk for the SAME logical line. A plain Put at the
      // new sk alone would leave the old sk's line behind as a second, stale entry — so any
      // prior line for this roundId (found by a consistent scan of the golfer's own,
      // partition, cheap at a career's scale) is deleted first. The common case (a stream
      // retry or rebuild replay landing the exact SAME archive twice) computes the SAME sk
      // both times, so this finds nothing to delete and the Put below is the only write.
      const priorSks = await queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          FilterExpression: "#line.roundId = :roundId",
          ExpressionAttributeNames: { "#line": "line" },
          ExpressionAttributeValues: { ":pk": pk, ":prefix": historySkPrefix, ":roundId": line.roundId },
          ConsistentRead: true,
        },
        (item) => item.sk as string,
      );
      await Promise.all(priorSks.filter((sk) => sk !== newSk).map((sk) => client.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }))));

      await client.send(new PutCommand({ TableName: tableName, Item: { pk, sk: newSk, line } }));
    },

    listHistory: (golferId: GolferId): Promise<readonly HistoryLine[]> =>
      queryAllPages(
        client,
        {
          TableName: tableName,
          // Ascending (default ScanIndexForward) over a zero-padded-finalizedAtMs sk IS
          // oldest→newest — no ScanIndexForward:false, no client-side sort (keys.ts's
          // historySk doc comment).
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": golferPk(golferId), ":prefix": historySkPrefix },
        },
        (item) => item.line as HistoryLine,
      ),

    putIndex: async (golferId: GolferId, snapshot: IndexSnapshot) => {
      // Unconditional upsert: each finalize recomputes the whole snapshot from history, never
      // patches it incrementally (same idempotent-write posture as the snapshots-table put).
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

    wipeGolfer: async (golferId: GolferId) => {
      const pk = golferPk(golferId);
      // One pk-wide Query catches both HISTORY# lines and the INDEX snapshot (same partition,
      // no prefix filter) — rebuildProjections' contract is wipe-then-replay-everything, and a
      // surviving INDEX from before the wipe would stand in for a value the replay never
      // actually recomputed (e.g. if the rebuild's differential count no longer clears
      // computeIndexDetail's bootstrap threshold).
      const sks = await queryAllPages(
        client,
        { TableName: tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true },
        (item) => item.sk as string,
      );
      await Promise.all(sks.map((sk) => client.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }))));
    },

    // M8 Task 3: the crew season ledger's real `projections` table layout — one partition per
    // (crewId, season) holding contribution entries, upserted by roundId exactly like
    // putHistoryLine above.
    putCrewRound: async (crewId: CrewId, season: number, entry: CrewRoundEntry) => {
      const pk = crewRoundsPk(crewId, season);
      const newSk = crewRoundSk(entry.finalizedAtMs, entry.roundId);

      // Same query→delete→put idiom as putHistoryLine above, and for the identical reason:
      // the sk encodes finalizedAtMs, but the upsert key is roundId (port doc: "a repeat put
      // for the same round replaces, never accumulates") — a reopen-and-refinalize computes a
      // DIFFERENT sk for the SAME roundId, so any prior entry for this roundId is deleted
      // before the new one lands, or the old sk would survive as a second, stale entry.
      // CORRECTION (M8 close-out review, M9 hardening ledger): this dedupe only reaches
      // entries in THIS season's partition (pk = crewRoundsPk(crewId, season)). A
      // reopen-and-refinalize whose new finalizedAtMs lands in a DIFFERENT UTC year (season =
      // seasonOf(finalizedAtMs), projectArchive.ts) never finds — and so never deletes — the
      // OLD season's entry: it strands there forever, unrepairable even by rebuildProjections
      // (its touchedCrewSeasons is collected the same season-scoped way). Unreachable in v1
      // (nothing reopens a finalized round yet), latent once M9 or later adds it.
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
