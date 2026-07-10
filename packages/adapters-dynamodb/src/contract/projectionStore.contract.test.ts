import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GolferRoundLine } from "@swng/domain";
import { golferId, roundId } from "@swng/domain";
import { createDynamoProjectionStore } from "../createDynamoProjectionStore.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M7 Task 3), same idiom as courseStore.contract.test.ts: proves
// createDynamoProjectionStore against a real DynamoDB Local against the SAME spec the
// in-memory fake (application/testing/fakes.ts's createInMemoryProjectionStore) satisfies —
// putHistoryLine's upsert-by-roundId invariant (architecture.md §4: "projections treat
// finalize as an idempotent upsert by roundId"), listHistory's oldest-first order, and
// wipeGolfer's completeness. Not part of `pnpm validate`; run via `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const newStore = () => createDynamoProjectionStore({ client: local.client, tableName: local.projectionsTable });

const distribution = { eagles: 0, birdies: 0, pars: 4, bogeys: 0, doublePlus: 0 };

const makeLine = (id: ReturnType<typeof roundId>, finalizedAtMs: number, overrides: Partial<GolferRoundLine> = {}): GolferRoundLine & { finalizedAtMs: number } => ({
  roundId: id,
  courseName: "Casa Verde GC",
  tee: "white",
  holes: 18,
  distribution,
  finalizedAtMs,
  ...overrides,
});

describe("createDynamoProjectionStore", () => {
  describe("putHistoryLine / listHistory", () => {
    it("put + listHistory round-trip for one line", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const line = makeLine(roundId(randomUUID()), 1_000);

      await store.putHistoryLine(golfer, line);

      expect(await store.listHistory(golfer)).toEqual([line]);
    });

    it("listHistory on a golfer with no lines returns []", async () => {
      const store = newStore();
      expect(await store.listHistory(golferId(randomUUID()))).toEqual([]);
    });

    it("re-putting the SAME round (identical finalizedAtMs) upserts — a single line, not an accumulation", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const id = roundId(randomUUID());
      const line = makeLine(id, 1_000, { tee: "white" });

      await store.putHistoryLine(golfer, line);
      const replayed = makeLine(id, 1_000, { tee: "white" }); // a rebuild replay of the same archive
      await store.putHistoryLine(golfer, replayed);

      expect(await store.listHistory(golfer)).toEqual([replayed]);
    });

    // architecture.md §4: "Reopen-and-refinalize is the correction path after finalization;
    // projections treat finalize as an idempotent upsert by roundId and recompute" — the new
    // round-finalized event carries a DIFFERENT finalizedAtMs (wall clock moved on), so this
    // is the sk-shape-changing case putHistoryLine's upsert must still collapse to one line.
    it("re-putting the SAME round with a DIFFERENT finalizedAtMs (reopen-and-refinalize) still upserts to a single, updated line", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const id = roundId(randomUUID());
      await store.putHistoryLine(golfer, makeLine(id, 1_000, { tee: "white" }));

      const refinalized = makeLine(id, 5_000, { tee: "blue" });
      await store.putHistoryLine(golfer, refinalized);

      expect(await store.listHistory(golfer)).toEqual([refinalized]);
    });

    it("listHistory returns lines oldest → newest by finalizedAtMs, regardless of insertion order", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const middle = makeLine(roundId(randomUUID()), 2_000);
      const newest = makeLine(roundId(randomUUID()), 3_000);
      const oldest = makeLine(roundId(randomUUID()), 1_000);

      // Inserted out of chronological order on purpose.
      await store.putHistoryLine(golfer, middle);
      await store.putHistoryLine(golfer, newest);
      await store.putHistoryLine(golfer, oldest);

      expect(await store.listHistory(golfer)).toEqual([oldest, middle, newest]);
    });

    it("putHistoryLine for one golfer never leaks into another golfer's history", async () => {
      const store = newStore();
      const golferA = golferId(randomUUID());
      const golferB = golferId(randomUUID());
      const lineA = makeLine(roundId(randomUUID()), 1_000);

      await store.putHistoryLine(golferA, lineA);

      expect(await store.listHistory(golferA)).toEqual([lineA]);
      expect(await store.listHistory(golferB)).toEqual([]);
    });
  });

  describe("putIndex / getIndex", () => {
    it("put + get round-trip, and unconditionally overwrites on re-put", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());

      await store.putIndex(golfer, { value: 12.3, computedAtMs: 1_000, differentialsUsed: 3 });
      await store.putIndex(golfer, { value: 11.8, computedAtMs: 2_000, differentialsUsed: 4 });

      expect(await store.getIndex(golfer)).toEqual({ value: 11.8, computedAtMs: 2_000, differentialsUsed: 4 });
    });

    it("getIndex on a golfer with no snapshot returns undefined", async () => {
      const store = newStore();
      expect(await store.getIndex(golferId(randomUUID()))).toBeUndefined();
    });
  });

  describe("wipeGolfer", () => {
    it("wipes a golfer's history AND index, leaving other golfers' projections untouched", async () => {
      const store = newStore();
      const golferA = golferId(randomUUID());
      const golferB = golferId(randomUUID());
      const lineA = makeLine(roundId(randomUUID()), 1_000);
      const lineB = makeLine(roundId(randomUUID()), 1_000);

      await store.putHistoryLine(golferA, lineA);
      await store.putIndex(golferA, { value: 12.3, computedAtMs: 1_000, differentialsUsed: 3 });
      await store.putHistoryLine(golferB, lineB);
      await store.putIndex(golferB, { value: 9.4, computedAtMs: 1_000, differentialsUsed: 3 });

      await store.wipeGolfer(golferA);

      expect(await store.listHistory(golferA)).toEqual([]);
      expect(await store.getIndex(golferA)).toBeUndefined();
      expect(await store.listHistory(golferB)).toEqual([lineB]);
      expect(await store.getIndex(golferB)).toEqual({ value: 9.4, computedAtMs: 1_000, differentialsUsed: 3 });
    });

    it("wipeGolfer on a golfer with no projections at all is a no-op, not an error", async () => {
      const store = newStore();
      await expect(store.wipeGolfer(golferId(randomUUID()))).resolves.toBeUndefined();
    });
  });
});
