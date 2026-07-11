import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Crew, CrewId, CrewMember, GolferId } from "@swng/domain";
import { golferId as toGolferId } from "@swng/domain";
import type { CrewStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { crewGsi1pk, crewIdFromPk, crewPk, crewSk, golferPk, memberSk, memberSkPrefix } from "./keys.js";
import { queryAllPages } from "./paginate.js";

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
  };
};
