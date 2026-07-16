import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Golfer, GolferId } from "@swng/domain";
import { courseId, golferId as toGolferId } from "@swng/domain";
import type { GolferStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { golferGsi2pk, golferGsi2sk, golferIdFromPk, golferPk, golferSk, golferSubPk, golferSubSk } from "./keys.js";

// DynamoDB caps one BatchGetItem at 100 keys — getMany chunks its input to stay under it (same
// idiom as createDynamoSnapshotStore.getMany).
const BATCH_GET_MAX_KEYS = 100;

// A raw golfer item's shape on the core table (keys.ts's golferPk/golferSk): Golfer's nested
// `handicap: { declared? }` is flattened to a top-level `declared` attr (the plan's binding
// item shape) rather than stored as a nested `handicap` map — same spirit as courseStore's own
// custom encoding (name pulled out for gsi1sk) rather than a literal 1:1 serialization of the
// domain type. `official` is a LEGACY on-disk attr only (unrated-courses spec §6 folded the
// self-maintained official index into `declared`): the domain HandicapProfile no longer carries
// it, nothing WRITES it anymore, and golferOf below folds a stored `official` up into `declared`
// on read — kept on this item shape purely so that fold can see it. `computed` was never
// persisted here at all — it's a read-time metric (getMyRecord's metrics.whsIndex).
interface GolferItem {
  readonly pk: string;
  readonly sk: string;
  readonly revision: number;
  readonly name: string;
  readonly homeCourseId?: string;
  readonly declared?: number;
  readonly official?: number;
  // accounts-only identity spec §2: true iff `name` is the sub-derived placeholder a mint used.
  // Written only when true, tolerated as absent on read — old rows never carry it, no migration.
  readonly namePlaceholder?: boolean;
  readonly sub?: string;
  readonly gsi2pk?: string;
  readonly gsi2sk?: string;
}

// The SUB#<sub> pointer item bindSub maintains (keys.ts's golferSubPk doc comment) — carries
// only enough to resolve back to the golfer row it points at.
interface GolferSubPointerItem {
  readonly pk: string;
  readonly sk: string;
  readonly golferId: string;
}

const golferOf = (item: GolferItem): Golfer => ({
  id: golferIdFromPk(item.pk),
  name: item.name,
  ...(item.homeCourseId !== undefined ? { homeCourseId: courseId(item.homeCourseId) } : {}),
  ...(item.namePlaceholder === true ? { namePlaceholder: true } : {}),
  // unrated-courses spec §6: the three-number model collapsed to one persisted number,
  // `declared`. A legacy row carrying only `official` (an old self-maintained index, written
  // before this fold) reads back AS `declared`; a row that has both keeps `declared` and drops
  // the stale `official`. Old data tolerates forever, migrates never — the next whole-golfer put
  // simply omits `official` (the WRITE path no longer emits it), retiring the attr organically.
  handicap: {
    ...(item.declared !== undefined
      ? { declared: item.declared }
      : item.official !== undefined
        ? { declared: item.official }
        : {}),
  },
});

export const createDynamoGolferStore = (config: { client: DynamoDBDocumentClient; tableName: string }): GolferStore => {
  const { client, tableName } = config;

  const getGolferItem = async (id: GolferId): Promise<GolferItem | undefined> => {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk: golferPk(id), sk: golferSk }, ConsistentRead: true }));
    return result.Item as GolferItem | undefined;
  };

  return {
    put: async (golfer, expectedRevision) => {
      // M9 hardening: refuse a REPLACE that would silently clear a currently-bound sub — a
      // plain read-then-check (not folded into the write's own ConditionExpression) because
      // this is a programmer-error NET, not a concurrency invariant: every real call site
      // (updateMyGolfer.ts) already re-passes its own found.sub on every replace, and the
      // actual concurrency-critical invariant (no two subs racing for one binding) is
      // bindSub's transaction, below — not put's job at all. A stale read here can only ever
      // make this check MISS a drop that a concurrent write introduced, never falsely flag
      // one, so a TOCTOU gap is an acceptable tradeoff for a bug-catcher, not a real race.
      if (expectedRevision !== undefined && golfer.sub === undefined) {
        const current = await getGolferItem(golfer.id);
        if (current?.sub !== undefined) {
          throw new ApplicationError("sub-drop-forbidden", `put on golfer ${golfer.id} would drop its bound sub`);
        }
      }

      // Same revision-conditional CRUD as courseStore.put — a create always lands revision 1;
      // a replace's condition checks the caller's expected value but writes one past it.
      const revision = expectedRevision === undefined ? 1 : expectedRevision + 1;
      const item: GolferItem = {
        pk: golferPk(golfer.id),
        sk: golferSk,
        revision,
        name: golfer.name,
        ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
        // Written only when true (spec §2, absent = false) — a real-name PUT drops it by NOT
        // re-including it here, never by writing `false`.
        ...(golfer.namePlaceholder === true ? { namePlaceholder: true } : {}),
        ...(golfer.handicap.declared !== undefined ? { declared: golfer.handicap.declared } : {}),
        // put's `sub` is a plain overwrite, not conditional — it mirrors the caller's OWN
        // golfer object exactly (matches the in-memory fake's `const { sub, ...plain } =
        // golfer` destructure). The guard above is what stops a caller from actually DROPPING
        // an existing sub this way; establishing a NEW binding for real is bindSub's job (its
        // own doc comment) — no real call site sets `sub` here on create anymore.
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
      // Same rationale as put/getBySub below: callers (ensureGolfer, updateMyGolfer) base
      // their next mutation's expectedRevision on this read.
      const item = await getGolferItem(golferId);
      return item ? { golfer: golferOf(item), sub: item.sub, revision: item.revision } : undefined;
    },

    // Batch fetch of golfer rows by id (GolferStore's port doc): order is NOT guaranteed and
    // absent ids are omitted. The projector's one read per finalized round to decide which
    // participants are account-bound. NOT ConsistentRead (unlike get/getBySub above): a golfer's
    // sub binding is established at StartRound/JoinRound time, long before that round could ever
    // finalize, so an eventually-consistent BatchGet can't miss a binding relevant to this
    // archive. Dedupe + chunk + re-drive UnprocessedKeys, exactly as createDynamoSnapshotStore does.
    getMany: async (golferIds: readonly GolferId[]) => {
      const seen = new Set<string>();
      const uniqueKeys: { pk: string; sk: string }[] = [];
      for (const id of golferIds) {
        const pk = golferPk(id);
        if (seen.has(pk)) continue;
        seen.add(pk);
        uniqueKeys.push({ pk, sk: golferSk });
      }

      const results: { golfer: Golfer; sub?: string; revision: number }[] = [];
      for (let i = 0; i < uniqueKeys.length; i += BATCH_GET_MAX_KEYS) {
        let remaining: { pk: string; sk: string }[] | undefined = uniqueKeys.slice(i, i + BATCH_GET_MAX_KEYS);
        while (remaining && remaining.length > 0) {
          const result = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: remaining } } }));
          for (const raw of result.Responses?.[tableName] ?? []) {
            const item = raw as GolferItem;
            results.push({ golfer: golferOf(item), sub: item.sub, revision: item.revision });
          }
          remaining = result.UnprocessedKeys?.[tableName]?.Keys as { pk: string; sk: string }[] | undefined;
        }
      }
      return results;
    },

    // M9 hardening: resolves via the base-table SUB#<sub> pointer item bindSub maintains
    // (ConsistentRead both hops) — gsi2's own sub→golfer projection is no longer read here at
    // all (keys.ts's golferSubPk doc comment: gsi2 never supports ConsistentRead, which is
    // exactly the eventually-consistent race this move closes). gsi2pk/gsi2sk are still
    // WRITTEN by put/bindSub for rollback safety, but nothing reads them anymore.
    getBySub: async (sub: string) => {
      const pointer = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: golferSubPk(sub), sk: golferSubSk }, ConsistentRead: true }),
      );
      const pointerItem = pointer.Item as GolferSubPointerItem | undefined;
      if (!pointerItem) return undefined;

      const item = await getGolferItem(toGolferId(pointerItem.golferId));
      if (!item?.sub) return undefined; // defensive: the pointer names a row that's missing or unbound — shouldn't happen, but never fabricate a binding
      return { golfer: golferOf(item), sub: item.sub, revision: item.revision };
    },

    // M9 hardening (replaces the old `claim`, which also lazily CREATED the row — bindSub
    // never does; see golferStore.ts's port doc). ONE transaction writes the SUB#<sub>
    // pointer item (condition: attribute_not_exists(pk) — no OTHER golferId may already hold
    // this sub) AND sets `sub` on the golfer row (condition: attribute_exists(pk) — the row
    // must already exist — AND attribute_not_exists(sub) — this golferId isn't already
    // claimed). Either condition failing cancels the WHOLE transaction, so the two invariants
    // (sub-uniqueness, golferId-uniqueness) are enforced atomically together, not as two
    // separate non-atomic checks.
    bindSub: async (golferId: GolferId, sub: string) => {
      const pointerItem: GolferSubPointerItem = { pk: golferSubPk(sub), sk: golferSubSk, golferId };
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: tableName, Item: pointerItem, ConditionExpression: "attribute_not_exists(pk)" } },
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: golferPk(golferId), sk: golferSk },
                  UpdateExpression: "SET #sub = :sub, gsi2pk = :gsi2pk, gsi2sk = :gsi2sk, revision = revision + :one",
                  ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#sub)",
                  ExpressionAttributeNames: { "#sub": "sub" },
                  ExpressionAttributeValues: { ":sub": sub, ":gsi2pk": golferGsi2pk(sub), ":gsi2sk": golferGsi2sk, ":one": 1 },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (error instanceof TransactionCanceledException) {
          // Either item's condition failing means this exact bind cannot proceed — the sub is
          // already bound elsewhere, OR this golferId is already claimed, OR (a caller bug
          // this port doc warns against) the row doesn't exist yet. Every real caller treats
          // this uniformly (ensureGolfer catches it and re-reads the winner), so there's no need
          // to inspect CancellationReasons to tell the arms apart.
          throw new ApplicationError("golfer-already-claimed", `golfer ${golferId} could not be bound to the given sub`);
        }
        throw error;
      }
    },
  };
};
