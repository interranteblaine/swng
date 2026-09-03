import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { GolferId, GolferRoundLine, RoundId } from "@swng/domain";
import type { ProjectionStore } from "@swng/application";
import { golferPk, lineSk, lineSkPrefix, liveSk, liveSkPrefix } from "./keys.js";
import { queryAllPages } from "./paginate.js";

// `createdAtMs` (accounts-only identity spec §5) rides inside the stored `line` map like every
// other line field — putLine writes the whole object and listLines reads it back, so no per-field
// marshalling is needed. Optional: lines written before the field existed simply lack it on read.
//
// `playedAtMs` (spec 2026-08-01 §4a) is REQUIRED, unlike createdAtMs — ports/projectionStore.ts's
// own doc comment: projectArchive is the only writer and it always has a real value
// (domain's playedAtMsOf throws rather than produce undefined), so there is no legacy-line case
// to tolerate the way there is for createdAtMs. A line stored BEFORE this task landed carries no
// playedAtMs on the raw item and will read back missing it regardless of this type annotation —
// that is a close-out backfill fact (one `rebuildProjections` run replaces every stored line),
// not something this adapter's read path should paper over with a fallback.
type Line = GolferRoundLine & { readonly finalizedAtMs: number; readonly playedAtMs: number; readonly createdAtMs?: number };
type LiveEntry = { readonly roundId: RoundId; readonly courseName: string; readonly joinedAtMs: number };

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
    //
    // `item.line as Line` still CASTS where the round-event and snapshot reads now parse (spec
    // 2026-07-30 §10 / task 6). Surveyed and deliberately left, with the reason here rather than
    // only in a task report: `Line` is a domain shape with no wire schema for its STORED form, so
    // closing this needs a new schema rather than a reuse, and a bad line's blast radius is one
    // golfer's read-time stats (their average, typical 18, bests, milestones) — never a settled
    // or sealed number, which is the class the parse boundary exists to protect. It is NOT
    // justified by "a rebuild would regenerate it": task 6's own finding is that unparseable
    // stored data bricks `rebuildProjections` at page 1, so rebuild is exactly what you do not
    // have when you need it. Recommended next, on that basis.
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

    // Presence (spec §5) — a register, not a projection: no rebuild path, none needed.
    //
    // NO `ttl` attribute is written (2026-09-03 ticket, ports/projectionStore.ts): the
    // projections table has TTL enabled for other item kinds, and DynamoDB's sweep deletes only
    // items that CARRY the attribute — so omitting it is what makes a presence pointer outlive
    // everything except the round's own end. Adding `ttl` back here silently deletes live
    // golfers' only route back into their round; the contract test pins its absence.
    putLive: async (golferId: GolferId, entry: LiveEntry) => {
      const { roundId, courseName, joinedAtMs } = entry;
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: golferPk(golferId), sk: liveSk(roundId), live: { roundId, courseName, joinedAtMs } },
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
