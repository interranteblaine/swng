import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Golfer } from "@swng/domain";
import { courseId, golferId } from "@swng/domain";
import { createDynamoGolferStore } from "../createDynamoGolferStore.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M7 Task 3), same idiom as courseStore.contract.test.ts: proves
// createDynamoGolferStore against a real DynamoDB Local against the SAME spec the in-memory
// fake (application/testing/fakes.ts's createInMemoryGolferStore) satisfies — put's
// expectedRevision contract, getBySub's gsi2 lookup, and claim's atomic create-or-bind. Not
// part of `pnpm validate`; run via `pnpm test:contract`.

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

    it("put (create, claimed) + get + getBySub round-trip", async () => {
      const store = newStore();
      const golfer = makeGolfer({ homeCourseId: courseId(randomUUID()) });
      const sub = `sub-${randomUUID()}`;

      await store.put({ ...golfer, sub }, undefined);

      expect(await store.get(golfer.id)).toEqual({ golfer, sub, revision: 1 });
      expect(await store.getBySub(sub)).toEqual({ golfer, sub, revision: 1 });
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

    it("a replace can drop a previously-claimed sub (put's sub is a plain overwrite, not conditional)", async () => {
      const store = newStore();
      const golfer = makeGolfer();
      const sub = `sub-${randomUUID()}`;
      await store.put({ ...golfer, sub }, undefined);

      await store.put(golfer, 1); // no sub on this call

      expect(await store.get(golfer.id)).toEqual({ golfer, sub: undefined, revision: 2 });
      expect(await store.getBySub(sub)).toBeUndefined();
    });
  });

  describe("claim", () => {
    it("claiming a golferId with no existing item creates a fresh golfer (name + empty handicap from the claim) bound to sub", async () => {
      const store = newStore();
      const id = golferId(randomUUID());
      const sub = `sub-${randomUUID()}`;

      await store.claim(id, sub, "Dee");

      expect(await store.get(id)).toEqual({ golfer: { id, name: "Dee", handicap: {} }, sub, revision: 1 });
      expect(await store.getBySub(sub)).toEqual({ golfer: { id, name: "Dee", handicap: {} }, sub, revision: 1 });
    });

    it("claiming an existing unclaimed ghost keeps its own name/handicap — only sub (and revision) change", async () => {
      const store = newStore();
      const golfer = makeGolfer({ name: "Ghost Golfer", handicap: { declared: 18 } });
      await store.put(golfer, undefined);
      const sub = `sub-${randomUUID()}`;

      await store.claim(golfer.id, sub, "Ignored Name");

      expect(await store.get(golfer.id)).toEqual({ golfer, sub, revision: 2 });
    });

    it("a second claim on an already-claimed golferId throws golfer-already-claimed, first binding untouched", async () => {
      const store = newStore();
      const id = golferId(randomUUID());
      const subA = `sub-a-${randomUUID()}`;
      const subB = `sub-b-${randomUUID()}`;
      await store.claim(id, subA, "Ann");

      await expect(store.claim(id, subB, "Bo")).rejects.toMatchObject({ code: "golfer-already-claimed" });

      expect((await store.get(id))?.sub).toBe(subA);
      expect(await store.getBySub(subB)).toBeUndefined();
    });

    // Mirrors journal.contract.test.ts's N-concurrent-append construction: every call is
    // constructed and fired (one store instance each) before either promise is awaited —
    // genuine concurrency, not sequential turns wearing a Promise.all costume. The invariant
    // under test is that DynamoDB's `attribute_not_exists(sub)` condition is what actually
    // arbitrates the race, not that two in-process calls happen to interleave nicely.
    it("two concurrent claims of one ghost — exactly one wins", async () => {
      const store = newStore();
      const ghost = makeGolfer({ name: "Ghost Golfer" });
      await store.put(ghost, undefined);

      const claimants = [
        { sub: `sub-a-${randomUUID()}`, name: "Cal" },
        { sub: `sub-b-${randomUUID()}`, name: "Dee" },
      ] as const;

      const results = await Promise.allSettled(claimants.map((c) => newStore().claim(ghost.id, c.sub, c.name)));

      const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      expect(results[loserIndex]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ code: "golfer-already-claimed" }) });

      const winner = claimants[winnerIndex]!;
      const loser = claimants[loserIndex]!;

      // The item existed and was unclaimed before the race — name/handicap stay the ghost's
      // own regardless of who won (the create-branch defaults never apply here).
      const found = await store.get(ghost.id);
      expect(found).toEqual({ golfer: ghost, sub: winner.sub, revision: 2 });
      expect(await store.getBySub(winner.sub)).toEqual({ golfer: ghost, sub: winner.sub, revision: 2 });
      expect(await store.getBySub(loser.sub)).toBeUndefined();
    });
  });
});
