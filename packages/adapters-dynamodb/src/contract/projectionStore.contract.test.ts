import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CrewRoundContribution, GolferRoundLine } from "@swng/domain";
import { crewId, golferId, roundId } from "@swng/domain";
import type { CrewSeasonRecords } from "@swng/application";
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

const makeContribution = (
  id: ReturnType<typeof roundId>,
  finalizedAtMs: number,
  overrides: Partial<CrewRoundContribution> = {},
): CrewRoundContribution & { finalizedAtMs: number } => ({
  roundId: id,
  lines: [{ golferId: golferId(randomUUID()), wins: 1, losses: 0, halves: 0, points: 0, skins: 0 }],
  headToHead: [],
  finalizedAtMs,
  ...overrides,
});

const makeRecords = (): CrewSeasonRecords => ({
  ledger: [{ golferId: golferId(randomUUID()), rounds: 3, wins: 2, losses: 1, halves: 0, points: 0, skins: 0 }],
  headToHead: [{ a: golferId(randomUUID()), b: golferId(randomUUID()), aWins: 2, bWins: 1, halves: 0 }],
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

  describe("putCrewRound / listCrewRounds", () => {
    it("put + listCrewRounds round-trip for one contribution", async () => {
      const store = newStore();
      const crew = crewId(randomUUID());
      const entry = makeContribution(roundId(randomUUID()), 1_000);

      await store.putCrewRound(crew, 2026, entry);

      expect(await store.listCrewRounds(crew, 2026)).toEqual([entry]);
    });

    it("listCrewRounds on a crew/season with no contributions returns []", async () => {
      const store = newStore();
      expect(await store.listCrewRounds(crewId(randomUUID()), 2026)).toEqual([]);
    });

    it("re-putting the SAME round (identical finalizedAtMs) upserts — a single entry, not an accumulation", async () => {
      const store = newStore();
      const crew = crewId(randomUUID());
      const id = roundId(randomUUID());
      const entry = makeContribution(id, 1_000);

      await store.putCrewRound(crew, 2026, entry);
      const replayed = makeContribution(id, 1_000, { lines: entry.lines }); // a rebuild replay of the same archive
      await store.putCrewRound(crew, 2026, replayed);

      expect(await store.listCrewRounds(crew, 2026)).toEqual([replayed]);
    });

    // Same reopen-and-refinalize shape as putHistoryLine's own test above: a DIFFERENT
    // finalizedAtMs computes a DIFFERENT sk for the SAME roundId — the upsert must still
    // collapse to one entry.
    it("re-putting the SAME round with a DIFFERENT finalizedAtMs still upserts to a single, updated entry", async () => {
      const store = newStore();
      const crew = crewId(randomUUID());
      const id = roundId(randomUUID());
      await store.putCrewRound(crew, 2026, makeContribution(id, 1_000));

      const refinalized = makeContribution(id, 5_000, { headToHead: [{ a: golferId(randomUUID()), b: golferId(randomUUID()), outcome: "halved" }] });
      await store.putCrewRound(crew, 2026, refinalized);

      expect(await store.listCrewRounds(crew, 2026)).toEqual([refinalized]);
    });

    it("contributions for one (crew, season) never leak into another crew or another season of the SAME crew", async () => {
      const store = newStore();
      const crewA = crewId(randomUUID());
      const crewB = crewId(randomUUID());
      const entryA2026 = makeContribution(roundId(randomUUID()), 1_000);
      const entryA2025 = makeContribution(roundId(randomUUID()), 1_000);
      const entryB2026 = makeContribution(roundId(randomUUID()), 1_000);

      await store.putCrewRound(crewA, 2026, entryA2026);
      await store.putCrewRound(crewA, 2025, entryA2025);
      await store.putCrewRound(crewB, 2026, entryB2026);

      expect(await store.listCrewRounds(crewA, 2026)).toEqual([entryA2026]);
      expect(await store.listCrewRounds(crewA, 2025)).toEqual([entryA2025]);
      expect(await store.listCrewRounds(crewB, 2026)).toEqual([entryB2026]);
    });
  });

  describe("putSeasonRecords / getSeasonRecords", () => {
    it("put + get round-trip, and unconditionally overwrites on re-put", async () => {
      const store = newStore();
      const crew = crewId(randomUUID());
      const first = makeRecords();
      const second = makeRecords();

      await store.putSeasonRecords(crew, 2026, first);
      await store.putSeasonRecords(crew, 2026, second);

      expect(await store.getSeasonRecords(crew, 2026)).toEqual(second);
    });

    it("getSeasonRecords on a crew/season with no snapshot returns undefined", async () => {
      const store = newStore();
      expect(await store.getSeasonRecords(crewId(randomUUID()), 2026)).toBeUndefined();
    });
  });

  describe("wipeCrew", () => {
    it("wipes every supplied season's contributions AND records, leaving other seasons, other crews, and golfer projections untouched", async () => {
      const store = newStore();
      const crewA = crewId(randomUUID());
      const crewB = crewId(randomUUID());
      const golfer = golferId(randomUUID());
      const line = makeLine(roundId(randomUUID()), 1_000);

      await store.putCrewRound(crewA, 2025, makeContribution(roundId(randomUUID()), 1_000));
      await store.putCrewRound(crewA, 2026, makeContribution(roundId(randomUUID()), 1_000));
      await store.putSeasonRecords(crewA, 2025, makeRecords());
      await store.putSeasonRecords(crewA, 2026, makeRecords());
      const crewBEntry2026 = makeContribution(roundId(randomUUID()), 1_000);
      const crewBRecords2026 = makeRecords();
      await store.putCrewRound(crewB, 2026, crewBEntry2026);
      await store.putSeasonRecords(crewB, 2026, crewBRecords2026);
      await store.putHistoryLine(golfer, line);
      await store.putIndex(golfer, { value: 12.3, computedAtMs: 1_000, differentialsUsed: 3 });

      // Wipe only 2025 and 2026 of crewA (both seasons it touched) — crewB and the golfer's
      // own projections (a completely different table partition) must survive untouched.
      await store.wipeCrew(crewA, [2025, 2026]);

      expect(await store.listCrewRounds(crewA, 2025)).toEqual([]);
      expect(await store.listCrewRounds(crewA, 2026)).toEqual([]);
      expect(await store.getSeasonRecords(crewA, 2025)).toBeUndefined();
      expect(await store.getSeasonRecords(crewA, 2026)).toBeUndefined();
      expect(await store.listCrewRounds(crewB, 2026)).toEqual([crewBEntry2026]);
      expect(await store.getSeasonRecords(crewB, 2026)).toEqual(crewBRecords2026);
      expect(await store.listHistory(golfer)).toEqual([line]);
      expect(await store.getIndex(golfer)).toEqual({ value: 12.3, computedAtMs: 1_000, differentialsUsed: 3 });
    });

    it("wipeCrew only touches the SUPPLIED seasons — an untouched season for the SAME crew survives", async () => {
      const store = newStore();
      const crew = crewId(randomUUID());
      const entry2025 = makeContribution(roundId(randomUUID()), 1_000);
      await store.putCrewRound(crew, 2025, entry2025);
      await store.putCrewRound(crew, 2026, makeContribution(roundId(randomUUID()), 1_000));

      await store.wipeCrew(crew, [2026]); // 2025 not supplied

      expect(await store.listCrewRounds(crew, 2025)).toEqual([entry2025]);
      expect(await store.listCrewRounds(crew, 2026)).toEqual([]);
    });

    it("wipeCrew on a crew/seasons with no projections at all is a no-op, not an error", async () => {
      const store = newStore();
      await expect(store.wipeCrew(crewId(randomUUID()), [2026])).resolves.toBeUndefined();
    });
  });
});
