import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Crew, CrewId, CrewMember, GolferId, RoundId } from "@swng/domain";
import { golferId as toGolferId } from "@swng/domain";
import type { CrewSeason, CrewStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { countedRoundSkMarker, crewPk, crewSk, golferPk, memberSk, memberSkPrefix, seasonSk, seasonSkPrefix } from "./keys.js";
import { queryAllPages } from "./paginate.js";

// One item per season (keys.ts's seasonSk) — the WHOLE CrewSeason nested under `season`, same
// nest-the-whole-domain-value idiom CrewItem's own `crew` attribute uses above. `season` here is
// the RAW stored shape, which may predate `startsAtMs` (legacy rows) — `seasonOf` below is the
// ONE place that normalizes a raw item into a current CrewSeason on every read path.
interface SeasonItem {
  readonly pk: string;
  readonly sk: string;
  readonly season: Omit<CrewSeason, "startsAtMs"> & { readonly startsAtMs?: number };
}

// The one item->season mapping (crew-scoreboard spec §2's legacy fold): a stored row without
// `startsAtMs` (written before this field existed) reads as `startsAtMs = createdAtMs` — no
// migration, no wipe. `closedAtMs` needs no fold — it was always optional, so an absent stored
// value already reads back as `undefined` through the spread.
const seasonOf = (item: SeasonItem): CrewSeason => ({ ...item.season, startsAtMs: item.season.startsAtMs ?? item.season.createdAtMs });

// A crew root item's shape on the core table (keys.ts's crewPk/crewSk): unlike
// createDynamoGolferStore's flattened attrs, the WHOLE domain Crew is nested under `crew` —
// same idiom as createDynamoCourseStore's `course` attribute — because Crew's shape (just a
// members array) has nothing to gain from hand-flattening the way Golfer's two scalar handicap
// fields did. A crew is a grouping/competition ONLY (owner ruling, spec §11a): stored items on
// beta may still carry a stray `standingGame` attribute from before that ruling — `get` below
// tolerates it (reconstructs a clean `Crew` from only the fields the current type declares,
// never spreads the raw stored value), so it never leaks into anything this store returns, and
// the next `put` (a whole-document write of a caller-supplied Crew, which can no longer even
// TYPE a standingGame field) naturally never writes it back. Never a migration script.
//
// Crew membership (invited in, accountable out): `joinCode`/`gsi1pk`/`gsi1sk` are GONE — the
// permanent join code they backed is deleted outright, not tolerated on read the way
// standingGame is (spec §4, owner amendment: "delete, don't migrate" — beta crew data is test
// data, wiped by C-T5 before this ships, so there is nothing legacy to tolerate here).
interface CrewItem {
  readonly pk: string;
  readonly sk: string;
  readonly revision: number;
  readonly crew: Crew;
}

// One MEMBER item per roster member (keys.ts's memberSk) — a denormalized index ONLY:
// listByGolfer's gsi2 query reads these, but get/put never reconstruct a Crew from them (the
// root item's own embedded `crew.members` is the single source of truth for that).
interface MemberItem {
  readonly pk: string;
  readonly sk: string;
  readonly name: string;
  readonly role: CrewMember["role"];
  readonly gsi2pk: string;
  readonly gsi2sk: string;
}

const memberItemOf = (crewId: CrewId, member: CrewMember): MemberItem => ({
  pk: crewPk(crewId),
  sk: memberSk(member.golferId),
  name: member.name,
  role: member.role,
  gsi2pk: golferPk(member.golferId), // "GOLFER#<id>" — a DIFFERENT namespace than a claimed golfer's own gsi2pk ("SUB#<sub>")
  gsi2sk: crewPk(crewId), // "CREW#<id>"
});

const golferIdFromMemberSk = (sk: string): GolferId => toGolferId(sk.slice(memberSkPrefix.length));

// Guard: seasonId MUST NOT contain "#" (the store's key vocabulary composites it under the
// shared "SEASON#" prefix — legacy orphaned counted-round items use the SAME prefix plus
// "#ROUND#"; a "#" in seasonId would create a key collision, breaking listSeasons' ability to
// filter those orphans out). This is a programming-error guard (crewStore.ts port doc's caller
// contract), not a business-logic error, so we throw plain Error like the journal's
// missing-snapshotsTableName guard, never ApplicationError.
const validateSeasonId = (seasonId: string): void => {
  if (seasonId.includes("#")) {
    throw new Error(`seasonId contains "#" — key vocabulary collision: "${seasonId}"`);
  }
};

export const createDynamoCrewStore = (config: { client: DynamoDBDocumentClient; tableName: string }): CrewStore => {
  const { client, tableName } = config;

  return {
    put: async (crew: Crew, expectedRevision: number | undefined) => {
      const pk = crewPk(crew.id);
      const revision = expectedRevision === undefined ? 1 : expectedRevision + 1;

      // Reconcile MEMBER items against the crew's OWN embedded roster (the port doc: put
      // "reconciles" them, not "replaces" them) — read what's currently stored first so only
      // CHANGED members are (re)written and REMOVED members are deleted, keeping the
      // transaction bounded by roster churn rather than roster size on every single put.
      const existingMembers = await queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": memberSkPrefix },
          ConsistentRead: true,
        },
        (item) => item as unknown as MemberItem,
      );
      const existingByGolferId = new Map(existingMembers.map((item) => [golferIdFromMemberSk(item.sk), item]));
      const nextGolferIds = new Set(crew.members.map((member) => member.golferId));

      const toDelete = existingMembers.filter((item) => !nextGolferIds.has(golferIdFromMemberSk(item.sk)));
      const toPut = crew.members.filter((member) => {
        const existing = existingByGolferId.get(member.golferId);
        return existing === undefined || existing.name !== member.name || existing.role !== member.role;
      });

      const item: CrewItem = { pk, sk: crewSk, revision, crew };
      const condition =
        expectedRevision === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": expectedRevision } };

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: tableName, Item: item, ...condition } },
              ...toPut.map((member) => ({ Put: { TableName: tableName, Item: memberItemOf(crew.id, member) } })),
              ...toDelete.map((existing) => ({ Delete: { TableName: tableName, Key: { pk: existing.pk, sk: existing.sk } } })),
            ],
          }),
        );
      } catch (error) {
        // Only the crew item (TransactItems[0]) carries a ConditionExpression — a
        // TransactionCanceledException here can only mean ITS condition failed (member
        // Put/Delete items are unconditional), same "one conditional item in the batch"
        // shape createDynamoEventJournal's attemptCommit reasons about, just without needing
        // to inspect which reason index tripped.
        if (error instanceof TransactionCanceledException) {
          const detail = expectedRevision === undefined ? "already exists" : `revision mismatch (expected ${expectedRevision})`;
          throw new ApplicationError("crew-conflict", `crew ${crew.id} ${detail}`);
        }
        throw error;
      }
    },

    get: async (crewId: CrewId) => {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: crewPk(crewId), sk: crewSk },
          // Same rationale as courseStore.get/golferStore.get: callers (crews/retryOnConflict
          // call sites) base their next mutation's expectedRevision on this read.
          ConsistentRead: true,
        }),
      );
      const item = result.Item as CrewItem | undefined;
      if (!item) return undefined;
      // Reconstructed field-by-field (never `item.crew` spread verbatim): a legacy item may
      // still carry a stray `standingGame` attribute (this interface's own doc comment above) —
      // this is where that gets tolerated-and-ignored, so every caller of this store only ever
      // sees a clean Crew, no matter what the stored document actually holds.
      const crew: Crew = { id: item.crew.id, name: item.crew.name, members: item.crew.members };
      return { crew, revision: item.revision };
    },

    listByGolfer: async (golferId: GolferId) => {
      const memberItems = await queryAllPages(
        client,
        {
          TableName: tableName,
          IndexName: "gsi2",
          KeyConditionExpression: "gsi2pk = :gsi2pk",
          ExpressionAttributeValues: { ":gsi2pk": golferPk(golferId) },
        },
        (item) => item as unknown as MemberItem,
      );
      if (memberItems.length === 0) return [];

      // Batch-get the crew ROOT items (the plan's stated approach) for `name`/`memberCount` —
      // a MEMBER item carries only the member's OWN name/role, not the crew's.
      const keys = memberItems.map((item) => ({ pk: item.pk, sk: crewSk }));
      const crews: CrewItem[] = [];
      let pending = keys;
      while (pending.length > 0) {
        const result = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: pending } } }));
        crews.push(...((result.Responses?.[tableName] ?? []) as CrewItem[]));
        // BatchGetItem can return UnprocessedKeys under throttling even for a small request —
        // retry only those (mirrors queryAllPages' own exhaust-the-pagination-token loop).
        pending = (result.UnprocessedKeys?.[tableName]?.Keys ?? []) as { pk: string; sk: string }[];
      }

      return crews.map((item) => ({ crewId: item.crew.id, name: item.crew.name, memberCount: item.crew.members.length }));
    },

    putSeason: async (crewId: CrewId, season: CrewSeason) => {
      validateSeasonId(season.seasonId);
      // Unconditional upsert — create, rename, close, and reopen are all the SAME put keyed by
      // seasonId (the port doc's own contract): a PutCommand replaces the WHOLE item, so
      // whichever CrewSeason a caller supplies wins outright — an absent closedAtMs on the
      // caller's value (reopenSeason.ts) really leaves storage, not just this call's echo.
      // Built field-by-field (never spread `season`) so an absent closedAtMs never becomes an
      // explicit `undefined` key, which DynamoDB's marshall() rejects (the M8 lesson).
      const stored: CrewSeason = {
        seasonId: season.seasonId,
        name: season.name,
        status: season.status,
        createdAtMs: season.createdAtMs,
        startsAtMs: season.startsAtMs,
        ...(season.closedAtMs !== undefined ? { closedAtMs: season.closedAtMs } : {}),
      };
      const item: SeasonItem = { pk: crewPk(crewId), sk: seasonSk(season.seasonId), season: stored };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },

    getSeason: async (crewId: CrewId, seasonId: string) => {
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: crewPk(crewId), sk: seasonSk(seasonId) }, ConsistentRead: true }),
      );
      const item = result.Item as SeasonItem | undefined;
      return item ? seasonOf(item) : undefined;
    },

    listSeasons: async (crewId: CrewId) => {
      // One Query over the shared "SEASON#" prefix returns BOTH a season's own item AND every
      // legacy orphaned counted-round entry filed under it (the now-deleted counting
      // apparatus' own item shape, keys.ts's own doc comment) — so this filters OUT anything
      // whose sk carries the "#ROUND#" marker client-side rather than running a second,
      // narrower Query. The ORPHAN TOLERANCE (crew-scoreboard spec §2b, the standingGame
      // precedent): those items are never written anymore, but old ones still on beta must
      // never resurface as a "season" — forever, never a migration.
      const items = await queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": crewPk(crewId), ":prefix": seasonSkPrefix },
          ConsistentRead: true,
        },
        (item) => item as unknown as SeasonItem,
      );
      return items.filter((item) => !item.sk.includes(countedRoundSkMarker)).map((item) => seasonOf(item));
    },

    // The counting apparatus (addCountedRound/removeCountedRound/listCountedRounds) is deleted
    // whole (crew-scoreboard spec §2b) — countsRound survives it, unused by any use case today,
    // querying only the legacy orphaned items listSeasons above tolerates: one Query over every
    // season-namespaced item this crew has (season items AND orphaned counted-round entries
    // alike — begins_with(sk, "SEASON#") catches both) FILTERED on the entry's own roundId
    // attribute; a season item carries no `entry.roundId` at all, so it never matches the filter
    // and is excluded for free — no separate exclusion step needed here the way listSeasons
    // above needs one. Paginated to exhaustion (queryAllPages): a filter can produce empty pages
    // with more left to scan, so a naive single-page check could false-negative.
    countsRound: async (crewId: CrewId, roundId: RoundId) => {
      const matches = await queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          FilterExpression: "#entry.roundId = :roundId",
          ExpressionAttributeNames: { "#entry": "entry" },
          ExpressionAttributeValues: { ":pk": crewPk(crewId), ":prefix": seasonSkPrefix, ":roundId": roundId },
          ConsistentRead: true,
        },
        (item) => item.sk as string,
      );
      return matches.length > 0;
    },
  };
};
