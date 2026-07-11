import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { GolferId, GolferRoundLine } from "@swng/domain";
import type { ProjectionStore } from "@swng/application";
import { golferPk, historySk, historySkPrefix, projectionIndexSk } from "./keys.js";
import { queryAllPages } from "./paginate.js";

type HistoryLine = GolferRoundLine & { readonly finalizedAtMs: number };
type IndexSnapshot = { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };

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
      // Unconditional upsert (mirrors createDynamoRoundStore.putArchive): each finalize
      // recomputes the whole snapshot from history, never patches it incrementally.
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

    // M8 Task 2 STOPGAP: ProjectionStore grew the season-ledger methods
    // (ports/projectionStore.ts) so application's projector could be written and tested
    // against the port; the real `projections` table layout for LEDGER#crew#season /
    // H2H#crew#a#b (architecture.md's persistence sketch) is M8 Task 3's job, not built
    // here. These throw rather than silently no-op so a crew-tagged archive landing on a
    // live stack before Task 3 fails loudly (retries via the stream trigger's no-DLQ policy)
    // instead of quietly losing its ledger contribution forever.
    putCrewRound: (): Promise<void> => {
      throw new Error("createDynamoProjectionStore.putCrewRound: not implemented yet (M8 Task 3)");
    },
    listCrewRounds: () => {
      throw new Error("createDynamoProjectionStore.listCrewRounds: not implemented yet (M8 Task 3)");
    },
    putSeasonRecords: (): Promise<void> => {
      throw new Error("createDynamoProjectionStore.putSeasonRecords: not implemented yet (M8 Task 3)");
    },
    getSeasonRecords: () => {
      throw new Error("createDynamoProjectionStore.getSeasonRecords: not implemented yet (M8 Task 3)");
    },
    wipeCrew: (): Promise<void> => {
      throw new Error("createDynamoProjectionStore.wipeCrew: not implemented yet (M8 Task 3)");
    },
  };
};
