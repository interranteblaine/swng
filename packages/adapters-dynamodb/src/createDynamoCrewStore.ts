import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Crew, CrewId, CrewMember, GolferId, RoundId } from "@swng/domain";
import { golferId as toGolferId } from "@swng/domain";
import type { CountedRound, CrewSeason, CrewStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import {
  countedRoundSk,
  countedRoundSkMarker,
  countedRoundSkPrefix,
  crewGsi1pk,
  crewIdFromPk,
  crewPk,
  crewSk,
  golferPk,
  memberSk,
  memberSkPrefix,
  seasonSk,
  seasonSkPrefix,
} from "./keys.js";
import { queryAllPages } from "./paginate.js";

// One item per season (keys.ts's seasonSk) — the WHOLE CrewSeason nested under `season`, same
// nest-the-whole-domain-value idiom CrewItem's own `crew` attribute uses above.
interface SeasonItem {
  readonly pk: string;
  readonly sk: string;
  readonly season: CrewSeason;
}

// One item per round counted into a season (keys.ts's countedRoundSk) — the WHOLE CountedRound
// nested under `entry`, mirroring createDynamoProjectionStore's own crew-round-contribution
// item shape (its `entry: CrewRoundContribution` — same reasoning: countsRound's
// FilterExpression below reads `entry.roundId` the identical way that store's own
// listCrewRounds-adjacent write reads its own nested roundId).
interface CountedRoundItem {
  readonly pk: string;
  readonly sk: string;
  readonly entry: CountedRound;
}

// A crew root item's shape on the core table (keys.ts's crewPk/crewSk): unlike
// createDynamoGolferStore's flattened attrs, the WHOLE domain Crew is nested under `crew` —
// same idiom as createDynamoCourseStore's `course` attribute — because Crew's shape (a
// members array, an optional nested StandingGame with per-kind GameConfigDraft unions) has
// nothing to gain from hand-flattening the way Golfer's two scalar handicap fields did.
interface CrewItem {
  readonly pk: string;
  readonly sk: string;
  readonly revision: number;
  readonly joinCode: string;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
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

// Guard: seasonId MUST NOT contain "#" (the store's key vocabulary composites it between
// separators — seasonSk + countedRoundSk share the "SEASON#" prefix and use "#ROUND#" to
// distinguish them; a "#" in seasonId would create a key collision, breaking listSeasons).
// This is a programming-error guard (crewStore.ts port doc's caller contract), not a
// business-logic error, so we throw plain Error like the journal's missing-snapshotsTableName
// guard, never ApplicationError.
const validateSeasonId = (seasonId: string): void => {
  if (seasonId.includes("#")) {
    throw new Error(`seasonId contains "#" — key vocabulary collision: "${seasonId}"`);
  }
};

export const createDynamoCrewStore = (config: { client: DynamoDBDocumentClient; tableName: string }): CrewStore => {
  const { client, tableName } = config;

  return {
    put: async (crew: Crew, joinCode: string, expectedRevision: number | undefined) => {
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

      const item: CrewItem = { pk, sk: crewSk, revision, joinCode, gsi1pk: crewGsi1pk, gsi1sk: joinCode, crew };
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
      return item ? { crew: item.crew, joinCode: item.joinCode, revision: item.revision } : undefined;
    },

    findByJoinCode: async (joinCode: string) => {
      // gsi1, like gsi2, is eventually consistent — DynamoDB GSIs never support
      // ConsistentRead (findByJoinCode's same accepted tradeoff in createDynamoRoundStore).
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :gsi1pk AND gsi1sk = :code",
          ExpressionAttributeValues: { ":gsi1pk": crewGsi1pk, ":code": joinCode },
          Limit: 1,
        }),
      );
      // The base table's key attributes (`pk`/`sk`) are always projected onto a GSI
      // regardless of ProjectionType (courseIdFromPk's own doc note) — crewId parses back out
      // of `pk` even though gsi1's real ProjectionType is INCLUDE(["name"]) for courses.
      const item = result.Items?.[0] as { pk: string } | undefined;
      return item ? crewIdFromPk(item.pk) : undefined;
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
      // Unconditional upsert — create, rename, and close are all the SAME put keyed by
      // seasonId (the port doc's own contract). No revision to conflict on.
      const item: SeasonItem = { pk: crewPk(crewId), sk: seasonSk(season.seasonId), season };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },

    getSeason: async (crewId: CrewId, seasonId: string) => {
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: crewPk(crewId), sk: seasonSk(seasonId) }, ConsistentRead: true }),
      );
      const item = result.Item as SeasonItem | undefined;
      return item?.season;
    },

    listSeasons: async (crewId: CrewId) => {
      // One Query over the shared "SEASON#" prefix returns BOTH a season's own item AND every
      // round entry filed under it (keys.ts's own doc comment on why: cheap at this scale) — so
      // this filters OUT anything whose sk carries the "#ROUND#" marker client-side rather than
      // running a second, narrower Query. Cheap because a crew's whole season + counted-round
      // item count is small (task-8-brief.md: "hundreds at most").
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
      return items.filter((item) => !item.sk.includes(countedRoundSkMarker)).map((item) => item.season);
    },

    addCountedRound: async (crewId: CrewId, seasonId: string, entry: CountedRound) => {
      validateSeasonId(seasonId);
      const item: CountedRoundItem = { pk: crewPk(crewId), sk: countedRoundSk(seasonId, entry.roundId), entry };
      try {
        await client.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(sk)" }));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new ApplicationError("round-already-counted", `round ${entry.roundId} is already counted in season ${seasonId} of crew ${crewId}`);
        }
        throw error;
      }
    },

    removeCountedRound: async (crewId: CrewId, seasonId: string, roundId: RoundId) => {
      // No existence condition — removing an entry that was never there (or is already gone)
      // is a no-op, not an error (the port doc's own contract). WHO may remove is enforced one
      // layer up.
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: crewPk(crewId), sk: countedRoundSk(seasonId, roundId) } }));
    },

    listCountedRounds: async (crewId: CrewId, seasonId: string) =>
      queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": crewPk(crewId), ":prefix": countedRoundSkPrefix(seasonId) },
          ConsistentRead: true,
        },
        (item) => (item as unknown as CountedRoundItem).entry,
      ),

    countsRound: async (crewId: CrewId, roundId: RoundId) => {
      // Query every season-namespaced item this crew has (season items AND counted-round
      // entries alike — begins_with(sk, "SEASON#") catches both) and FILTER on the entry's own
      // roundId attribute; a season item carries no `entry.roundId` at all, so it never matches
      // the filter and is excluded for free — no separate exclusion step needed here the way
      // listSeasons above needs one. Paginated to exhaustion (queryAllPages): a filter can
      // produce empty pages with more left to scan, so a naive single-page check could
      // false-negative.
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
