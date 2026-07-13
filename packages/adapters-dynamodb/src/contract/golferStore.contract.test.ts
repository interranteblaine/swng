import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Golfer } from "@swng/domain";
import { courseId, golferId, placeholderName } from "@swng/domain";
import { ensureGolfer } from "@swng/application";
import { createSequentialIds } from "@swng/application";
import { createDynamoGolferStore } from "../createDynamoGolferStore.js";
import { golferPk, golferSk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M7 Task 3, hardened M9), same idiom as courseStore.contract.test.ts: proves
// createDynamoGolferStore against a real DynamoDB Local against the SAME spec the in-memory
// fake (application/testing/fakes.ts's createInMemoryGolferStore) satisfies — put's
// expectedRevision contract (and, M9, its sub-drop-forbidden guard), getBySub's SUB# pointer
// lookup, and bindSub's atomic bind. Not part of `pnpm validate`; run via `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const newStore = () => createDynamoGolferStore({ client: local.client, tableName: local.coreTable });

const makeGolfer = (overrides: Partial<Golfer> = {}): Golfer => ({
  id: golferId(randomUUID()),
  name: "Cal",
  handicap: {},
  ...overrides,
});

describe("createDynamoGolferStore", () => {
  describe("put/get round-trip", () => {
    it("put (create, unclaimed) + get round-trip", async () => {
      const store = newStore();
      const golfer = makeGolfer({ handicap: { declared: 12.3 } });

      await store.put(golfer, undefined);

      expect(await store.get(golfer.id)).toEqual({ golfer, sub: undefined, revision: 1 });
    });

    it("round-trips namePlaceholder: true (accounts-only identity spec §2); a golfer without it reads back without it", async () => {
      const store = newStore();
      const placeholder = makeGolfer({ name: "Golfer 4821", namePlaceholder: true });
      const chosen = makeGolfer({ name: "Ann" });

      await store.put(placeholder, undefined);
      await store.put(chosen, undefined);

      expect((await store.get(placeholder.id))?.golfer).toEqual(placeholder);
      expect((await store.get(chosen.id))?.golfer).toEqual(chosen);
      expect((await store.get(chosen.id))?.golfer).not.toHaveProperty("namePlaceholder");
    });

    it("put (create, claimed) + get round-trip — a sub set directly on create is honored on the golfer row (no bindSub needed for THIS narrow round-trip)", async () => {
      const store = newStore();
      const golfer = makeGolfer({ homeCourseId: courseId(randomUUID()) });
      const sub = `sub-${randomUUID()}`;

      await store.put({ ...golfer, sub }, undefined);

      expect(await store.get(golfer.id)).toEqual({ golfer, sub, revision: 1 });
    });

    it("get on an unknown golferId returns undefined", async () => {
      const store = newStore();
      expect(await store.get(golferId(randomUUID()))).toBeUndefined();
    });

    it("getBySub on an unknown sub returns undefined", async () => {
      const store = newStore();
      expect(await store.getBySub(`missing-${randomUUID()}`)).toBeUndefined();
    });

    it("create-when-exists (expectedRevision undefined against an existing item) throws golfer-conflict", async () => {
      const store = newStore();
      const golfer = makeGolfer();
      await store.put(golfer, undefined);

      await expect(store.put(golfer, undefined)).rejects.toMatchObject({ code: "golfer-conflict" });
    });

    it("stale-revision replace throws golfer-conflict, and a correct-revision replace lands + bumps revision", async () => {
      const store = newStore();
      const golfer = makeGolfer();
      await store.put(golfer, undefined);

      // Stale: the item is at revision 1, not 2.
      await expect(store.put(golfer, 2)).rejects.toMatchObject({ code: "golfer-conflict" });

      const renamed = { ...golfer, name: "Callum" };
      await store.put(renamed, 1);

      expect(await store.get(golfer.id)).toEqual({ golfer: renamed, sub: undefined, revision: 2 });
    });

    // M9 hardening: put now REFUSES a replace that would silently clear a currently-bound sub
    // — the old behavior (a plain overwrite, sub included or not) let a caller that forgot to
    // carry `found.sub` forward silently unbind a golfer. Every real call site
    // (updateMyGolfer.ts) always re-passes its own found.sub, so this only ever fires on a bug.
    it("a replace that drops a previously-bound sub throws sub-drop-forbidden, leaving the stored row untouched", async () => {
      const store = newStore();
      const golfer = makeGolfer();
      const sub = `sub-${randomUUID()}`;
      await store.put({ ...golfer, sub }, undefined);

      await expect(store.put(golfer, 1)).rejects.toMatchObject({ code: "sub-drop-forbidden" });

      expect(await store.get(golfer.id)).toEqual({ golfer, sub, revision: 1 });
    });

    // A replace that re-passes the SAME sub it already has (the real call-site shape,
    // updateMyGolfer.ts) is unaffected by the M9 guard above — it's not a drop.
    it("a replace that re-passes its own already-bound sub is unaffected by the drop guard", async () => {
      const store = newStore();
      const golfer = makeGolfer();
      const sub = `sub-${randomUUID()}`;
      await store.put({ ...golfer, sub }, undefined);

      const renamed = { ...golfer, name: "Callum", sub };
      await store.put(renamed, 1);

      expect(await store.get(golfer.id)).toEqual({ golfer: { ...golfer, name: "Callum" }, sub, revision: 2 });
    });
  });

  describe("getBySub — resolves via the SUB# pointer item alone (M9 hardening)", () => {
    it("resolves a sub bound by bindSub even with NO gsi2 projection present — pins gsi2 is a dead read path", async () => {
      const store = newStore();
      const golfer = makeGolfer();
      await store.put(golfer, undefined);
      const sub = `sub-${randomUUID()}`;
      await store.bindSub(golfer.id, sub);

      // bindSub still WRITES gsi2pk/gsi2sk (rollback safety, keys.ts's golferSubPk doc
      // comment) — strip them directly to prove getBySub never actually depends on them.
      await local.client.send(
        new UpdateCommand({
          TableName: local.coreTable,
          Key: { pk: golferPk(golfer.id), sk: golferSk },
          UpdateExpression: "REMOVE gsi2pk, gsi2sk",
        }),
      );

      expect(await store.getBySub(sub)).toEqual({ golfer, sub, revision: 2 });
    });
  });

  describe("bindSub", () => {
    it("binds sub to an existing unclaimed row, bumping revision, resolvable via getBySub", async () => {
      const store = newStore();
      const golfer = makeGolfer({ name: "Ghost Golfer", handicap: { declared: 18 } });
      await store.put(golfer, undefined);
      const sub = `sub-${randomUUID()}`;

      await store.bindSub(golfer.id, sub);

      expect(await store.get(golfer.id)).toEqual({ golfer, sub, revision: 2 });
      expect(await store.getBySub(sub)).toEqual({ golfer, sub, revision: 2 });
    });

    it("a second bind on an already-claimed golferId throws golfer-already-claimed, the first binding untouched", async () => {
      const store = newStore();
      const golfer = makeGolfer();
      await store.put(golfer, undefined);
      const subA = `sub-a-${randomUUID()}`;
      const subB = `sub-b-${randomUUID()}`;
      await store.bindSub(golfer.id, subA);

      await expect(store.bindSub(golfer.id, subB)).rejects.toMatchObject({ code: "golfer-already-claimed" });

      expect((await store.get(golfer.id))?.sub).toBe(subA);
      expect(await store.getBySub(subB)).toBeUndefined();
    });

    it("binding the SAME sub to a second golferId throws golfer-already-claimed (sub-uniqueness — the pointer item's own condition)", async () => {
      const store = newStore();
      const golferA = makeGolfer({ name: "Ann" });
      const golferB = makeGolfer({ name: "Bo" });
      await store.put(golferA, undefined);
      await store.put(golferB, undefined);
      const sub = `sub-${randomUUID()}`;
      await store.bindSub(golferA.id, sub);

      await expect(store.bindSub(golferB.id, sub)).rejects.toMatchObject({ code: "golfer-already-claimed" });

      expect((await store.get(golferB.id))?.sub).toBeUndefined();
      expect(await store.getBySub(sub)).toEqual({ golfer: golferA, sub, revision: 2 });
    });

    // Mirrors the M7 two-concurrent-claims-of-one-ghost race construction (real, SEPARATE
    // store instances, every call constructed and fired before either promise is awaited —
    // genuine concurrency, not sequential turns wearing a Promise.all costume) but targets the
    // invariant THIS task actually fixes: sub-uniqueness via the SUB# pointer item's own
    // attribute_not_exists(pk) condition, not golferId-uniqueness (which the row's own
    // attribute_not_exists(sub) condition already covered before M9). Two DIFFERENT,
    // already-existing golfer rows race to bind the SAME sub — exactly one must win, and the
    // pointer + both rows must stay consistent no matter which one does.
    it("two concurrent bindSub calls for ONE sub (different golferIds) — exactly one wins, pointer + rows stay consistent", async () => {
      const seedStore = newStore();
      const golferA = makeGolfer({ name: "Ann" });
      const golferB = makeGolfer({ name: "Bo" });
      await seedStore.put(golferA, undefined);
      await seedStore.put(golferB, undefined);
      const sub = `sub-${randomUUID()}`;

      const results = await Promise.allSettled([newStore().bindSub(golferA.id, sub), newStore().bindSub(golferB.id, sub)]);

      const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      expect(results[loserIndex]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ code: "golfer-already-claimed" }) });

      const golfers = [golferA, golferB] as const;
      const winner = golfers[winnerIndex]!;
      const loser = golfers[loserIndex]!;

      expect((await seedStore.get(winner.id))?.sub).toBe(sub);
      expect((await seedStore.get(loser.id))?.sub).toBeUndefined();
      expect(await seedStore.getBySub(sub)).toEqual({ golfer: winner, sub, revision: 2 });
    });
  });

  // accounts-only identity spec §2: the concurrent-first-request mint race. ensureGolfer is the
  // application use case (get-or-create on first touch); this exercises it against the REAL store's
  // SUB# transaction — the whole reason the mint routes through bindSub. Two parallel ensures for
  // the SAME fresh sub (separate store instances, both calls fired before either is awaited —
  // genuine concurrency, the same construction the bindSub race above uses) must converge on ONE
  // bound golfer: the race's loser re-reads and returns the winner. f(sub) makes the name identical
  // no matter which won.
  describe("ensureGolfer — concurrent-first-request race (accounts-only identity spec §2)", () => {
    it("two parallel ensures for one fresh sub converge on ONE bound golfer, both returning it", async () => {
      const seedStore = newStore();
      const idGenerator = createSequentialIds(`g-${randomUUID()}`);
      const sub = `sub-${randomUUID()}`;
      const claims = { sub };

      const results = await Promise.all([
        ensureGolfer({ golferStore: newStore(), idGenerator })(claims),
        ensureGolfer({ golferStore: newStore(), idGenerator })(claims),
      ]);

      // Both calls return the SAME golfer — the one actually bound to the sub.
      expect(results[0]!.id).toBe(results[1]!.id);
      const bound = await seedStore.getBySub(sub);
      expect(bound?.golfer.id).toBe(results[0]!.id);
      // Minted with the deterministic placeholder + flag, whichever call won.
      expect(bound?.golfer.name).toBe(placeholderName(sub));
      expect(bound?.golfer.namePlaceholder).toBe(true);
    });
  });
});
