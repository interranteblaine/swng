import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Golfer, GolferId } from "@swng/domain";
import { courseId } from "@swng/domain";
import type { GolferStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { golferGsi2pk, golferGsi2sk, golferIdFromPk, golferPk, golferSk } from "./keys.js";

// A raw golfer item's shape on the core table (keys.ts's golferPk/golferSk): Golfer's nested
// `handicap: { declared?, official? }` is flattened to top-level `declared`/`official`
// attrs (the plan's binding item shape) rather than stored as a nested `handicap` map — same
// spirit as courseStore's own custom encoding (name pulled out for gsi1sk) rather than a
// literal 1:1 serialization of the domain type. `handicap.computed` is deliberately NOT
// persisted here: nothing in application yet writes it onto a Golfer (it's sourced from
// ProjectionStore's INDEX snapshot at read time), so there's nothing to round-trip.
interface GolferItem {
  readonly pk: string;
  readonly sk: string;
  readonly revision: number;
  readonly name: string;
  readonly homeCourseId?: string;
  readonly declared?: number;
  readonly official?: number;
  readonly sub?: string;
  readonly gsi2pk?: string;
  readonly gsi2sk?: string;
}

const golferOf = (item: GolferItem): Golfer => ({
  id: golferIdFromPk(item.pk),
  name: item.name,
  ...(item.homeCourseId !== undefined ? { homeCourseId: courseId(item.homeCourseId) } : {}),
  handicap: {
    ...(item.declared !== undefined ? { declared: item.declared } : {}),
    ...(item.official !== undefined ? { official: item.official } : {}),
  },
});

export const createDynamoGolferStore = (config: { client: DynamoDBDocumentClient; tableName: string }): GolferStore => {
  const { client, tableName } = config;

  return {
    put: async (golfer, expectedRevision) => {
      // Same revision-conditional CRUD as courseStore.put — a create always lands revision 1;
      // a replace's condition checks the caller's expected value but writes one past it.
      const revision = expectedRevision === undefined ? 1 : expectedRevision + 1;
      const item: GolferItem = {
        pk: golferPk(golfer.id),
        sk: golferSk,
        revision,
        name: golfer.name,
        ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
        ...(golfer.handicap.declared !== undefined ? { declared: golfer.handicap.declared } : {}),
        ...(golfer.handicap.official !== undefined ? { official: golfer.handicap.official } : {}),
        // put's `sub` is a plain overwrite, not conditional — it mirrors the caller's OWN
        // golfer object exactly (matches the in-memory fake's `const { sub, ...plain } =
        // golfer` destructure), unlike `claim` below, whose whole job is enforcing atomicity
        // on the sub binding. A caller that always re-passes `found.sub` on every put (every
        // real call site does — updateMyGolfer.ts) never loses a claim this way.
        ...(golfer.sub !== undefined ? { sub: golfer.sub, gsi2pk: golferGsi2pk(golfer.sub), gsi2sk: golferGsi2sk } : {}),
      };
      const condition =
        expectedRevision === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": expectedRevision } };

      try {
        await client.send(new PutCommand({ TableName: tableName, Item: item, ...condition }));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          const detail = expectedRevision === undefined ? "already exists" : `revision mismatch (expected ${expectedRevision})`;
          throw new ApplicationError("golfer-conflict", `golfer ${golfer.id} ${detail}`);
        }
        throw error;
      }
    },

    get: async (golferId: GolferId) => {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: golferPk(golferId), sk: golferSk },
          // Same rationale as courseStore.get: callers (getOrCreateGolfer, updateMyGolfer)
          // base their next mutation's expectedRevision on this read.
          ConsistentRead: true,
        }),
      );
      const item = result.Item as GolferItem | undefined;
      return item ? { golfer: golferOf(item), sub: item.sub, revision: item.revision } : undefined;
    },

    getBySub: async (sub: string) => {
      // gsi2, like gsi1, is eventually consistent — DynamoDB GSIs never support
      // ConsistentRead (findByJoinCode's same note in createDynamoRoundStore.ts). Accepted
      // here too: getBySub backs GET /me and claimGolfer's precheck, neither a tight
      // read-your-writes loop within a single request.
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "gsi2",
          KeyConditionExpression: "gsi2pk = :gsi2pk AND gsi2sk = :gsi2sk",
          ExpressionAttributeValues: { ":gsi2pk": golferGsi2pk(sub), ":gsi2sk": golferGsi2sk },
          Limit: 1,
        }),
      );
      const item = result.Items?.[0] as GolferItem | undefined;
      if (!item?.sub) return undefined;
      return { golfer: golferOf(item), sub: item.sub, revision: item.revision };
    },

    // Atomically creates-or-updates the golfer item, conditional on no EXISTING sub on THIS
    // golferId — `attribute_not_exists(sub)` is true both when the item doesn't exist at all
    // and when it exists but is still unclaimed, exactly the two branches the port doc
    // describes. `if_not_exists` on `revision`/`name` is what makes the two branches land in
    // ONE UpdateItem: a brand-new item has neither attribute, so they seed from `:zero`+1 and
    // `:name`; an existing unclaimed item already has both, so `if_not_exists` leaves them
    // alone (the ghost's own name survives, revision still increments by exactly one).
    //
    // No getBySub precheck lives HERE for the "sub already bound to a DIFFERENT golferId"
    // collision arm — that's the caller's job (claimGolfer.ts already does it, calling this
    // same store's getBySub before ever reaching claim). This method enforces only the ONE
    // invariant it's positioned to enforce atomically: no existing binding on THIS golferId.
    // The condition below is that invariant; a precheck anywhere is advisory UX, never a
    // substitute for it — which is exactly why the two-concurrent-claims contract test races
    // real UpdateItem calls instead of trusting in-process interleaving.
    claim: async (golferId: GolferId, sub: string, name: string) => {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: golferPk(golferId), sk: golferSk },
            // Both `sub` and `name` are DynamoDB reserved words (ValidationException without
            // the alias) — #sub/#name sidestep that; unrelated to the port's own vocabulary.
            UpdateExpression: "SET #sub = :sub, gsi2pk = :gsi2pk, gsi2sk = :gsi2sk, revision = if_not_exists(revision, :zero) + :one, #name = if_not_exists(#name, :name)",
            ConditionExpression: "attribute_not_exists(#sub)",
            ExpressionAttributeNames: { "#sub": "sub", "#name": "name" },
            ExpressionAttributeValues: {
              ":sub": sub,
              ":gsi2pk": golferGsi2pk(sub),
              ":gsi2sk": golferGsi2sk,
              ":zero": 0,
              ":one": 1,
              ":name": name,
            },
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new ApplicationError("golfer-already-claimed", `golfer ${golferId} already claimed`);
        }
        throw error;
      }
    },
  };
};
