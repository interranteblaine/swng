import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { CrewRoundContribution, GolferRoundLine, RoundId } from "@swng/domain";
import { crewId, golferId, roundId } from "@swng/domain";
import type { CrewSeasonRecords } from "@swng/application";
import { createDynamoProjectionStore } from "../createDynamoProjectionStore.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M7 Task 3; rewritten for the projection-realignment's stable-key golfer
// record — projection-realignment spec §3): proves createDynamoProjectionStore against a real
// DynamoDB Local against the SAME spec the in-memory fake (application/testing/fakes.ts's
// createInMemoryProjectionStore) satisfies — putLine's stable-key upsert-by-roundId invariant
// ("a key is an identity, time is an attribute": a correction REPLACES, never duplicates),
// listLines' UNORDERED contract, and presence's put/list/delete round-trip incl. the `ttl`
// attribute DynamoDB TTL actually reads. Not part of `pnpm validate`; run via
// `pnpm test:contract`.

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

// Order-insensitive comparison — listLines/listLive make NO order promise (ports/
// projectionStore.ts), so every multi-item assertion below compares as a SET, never an array
// equality that would incidentally pin an order the port doesn't actually guarantee.
const sortByRoundId = <T extends { readonly roundId: RoundId }>(items: readonly T[]): T[] => [...items].sort((a, b) => (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));

describe("createDynamoProjectionStore", () => {
  describe("putLine / listLines", () => {
    it("put + listLines round-trip for one line", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const line = makeLine(roundId(randomUUID()), 1_000);

      await store.putLine(golfer, line);

      expect(await store.listLines(golfer)).toEqual([line]);
    });

    it("listLines on a golfer with no lines returns []", async () => {
      const store = newStore();
      expect(await store.listLines(golferId(randomUUID()))).toEqual([]);
    });

    // THE stable-key point (projection-realignment spec §3): "a correction replaces, never
    // duplicates." The OLD time-embedded HISTORY# scheme computed a DIFFERENT sk for a
    // reopen-and-refinalize (a new finalizedAtMs, same roundId) and needed a query-then-delete
    // dance to avoid stranding the old sk as a second, stale item. lineSk embeds ONLY the
    // roundId, so this is now just two unconditional Puts at the SAME sk.
    it("put + put for the SAME roundId with a DIFFERENT finalizedAtMs (reopen-and-refinalize) leaves exactly ONE item — the second replaces the first outright", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const id = roundId(randomUUID());
      await store.putLine(golfer, makeLine(id, 1_000, { tee: "white" }));

      const refinalized = makeLine(id, 5_000, { tee: "blue" });
      await store.putLine(golfer, refinalized);

      expect(await store.listLines(golfer)).toEqual([refinalized]);
    });

    it("re-putting the SAME round with the IDENTICAL finalizedAtMs (a stream/rebuild replay) also stays a single item", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const id = roundId(randomUUID());
      const line = makeLine(id, 1_000, { tee: "white" });

      await store.putLine(golfer, line);
      await store.putLine(golfer, makeLine(id, 1_000, { tee: "white" }));

      expect(await store.listLines(golfer)).toEqual([line]);
    });

    it("listLines returns every line for a golfer with TWO different rounds — order not asserted (the port makes none)", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const first = makeLine(roundId(randomUUID()), 3_000);
      const second = makeLine(roundId(randomUUID()), 1_000); // deliberately the LATER finalize, EARLIER wall time

      await store.putLine(golfer, first);
      await store.putLine(golfer, second);

      expect(sortByRoundId(await store.listLines(golfer))).toEqual(sortByRoundId([first, second]));
    });

    it("putLine for one golfer never leaks into another golfer's lines", async () => {
      const store = newStore();
      const golferA = golferId(randomUUID());
      const golferB = golferId(randomUUID());
      const lineA = makeLine(roundId(randomUUID()), 1_000);

      await store.putLine(golferA, lineA);

      expect(await store.listLines(golferA)).toEqual([lineA]);
      expect(await store.listLines(golferB)).toEqual([]);
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

  describe("putLive / listLive / deleteLive (presence, projection-realignment spec §5)", () => {
    it("put + listLive round-trip for one live round", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const round = roundId(randomUUID());

      await store.putLive(golfer, { roundId: round, courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });

      expect(await store.listLive(golfer)).toEqual([{ roundId: round, courseName: "Casa Verde GC", joinedAtMs: 1_000 }]);
    });

    it("listLive on a golfer with no live rounds returns []", async () => {
      const store = newStore();
      expect(await store.listLive(golferId(randomUUID()))).toEqual([]);
    });

    it("listLive returns every currently-live round for a golfer, independent of other golfers", async () => {
      const store = newStore();
      const golferA = golferId(randomUUID());
      const golferB = golferId(randomUUID());
      const roundA1 = roundId(randomUUID());
      const roundA2 = roundId(randomUUID());
      const roundB1 = roundId(randomUUID());

      await store.putLive(golferA, { roundId: roundA1, courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });
      await store.putLive(golferA, { roundId: roundA2, courseName: "Pebble Municipal", joinedAtMs: 2_000, expiresAtSec: 9_999_999_999 });
      await store.putLive(golferB, { roundId: roundB1, courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });

      expect(sortByRoundId(await store.listLive(golferA))).toEqual(
        sortByRoundId([
          { roundId: roundA1, courseName: "Casa Verde GC", joinedAtMs: 1_000 },
          { roundId: roundA2, courseName: "Pebble Municipal", joinedAtMs: 2_000 },
        ]),
      );
      expect(await store.listLive(golferB)).toEqual([{ roundId: roundB1, courseName: "Casa Verde GC", joinedAtMs: 1_000 }]);
    });

    it("deleteLive removes exactly the named round, leaving the golfer's other live rounds untouched", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const keep = roundId(randomUUID());
      const drop = roundId(randomUUID());
      await store.putLive(golfer, { roundId: keep, courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });
      await store.putLive(golfer, { roundId: drop, courseName: "Pebble Municipal", joinedAtMs: 2_000, expiresAtSec: 9_999_999_999 });

      await store.deleteLive(golfer, drop);

      expect(await store.listLive(golfer)).toEqual([{ roundId: keep, courseName: "Casa Verde GC", joinedAtMs: 1_000 }]);
    });

    it("deleteLive on a round that was never live is a no-op, not an error", async () => {
      const store = newStore();
      await expect(store.deleteLive(golferId(randomUUID()), roundId(randomUUID()))).resolves.toBeUndefined();
    });

    // DynamoDB TTL reads a top-level Number attribute named exactly `ttl` (the projections
    // table's real TTL spec, apps/infra-cdk/lib/swngStack.ts, realignment Task 1) — this reads
    // the raw item back via the document client (bypassing the port's own listLive, which
    // deliberately never surfaces expiresAtSec — ports/projectionStore.ts) to prove putLive
    // actually writes INTO that attribute, not just tracks expiresAtSec internally.
    it("putLive writes expiresAtSec into the item's own `ttl` attribute", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const round = roundId(randomUUID());

      await store.putLive(golfer, { roundId: round, courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 1_234_567_890 });

      const raw = await local.client.send(new GetCommand({ TableName: local.projectionsTable, Key: { pk: `GOLFER#${golfer}`, sk: `LIVE#${round}` } }));
      expect(raw.Item?.ttl).toBe(1_234_567_890);
    });
  });

  describe("wipeGolfer", () => {
    it("wipes a golfer's lines AND index, leaving other golfers' projections untouched", async () => {
      const store = newStore();
      const golferA = golferId(randomUUID());
      const golferB = golferId(randomUUID());
      const lineA = makeLine(roundId(randomUUID()), 1_000);
      const lineB = makeLine(roundId(randomUUID()), 1_000);

      await store.putLine(golferA, lineA);
      await store.putIndex(golferA, { value: 12.3, computedAtMs: 1_000, differentialsUsed: 3 });
      await store.putLine(golferB, lineB);
      await store.putIndex(golferB, { value: 9.4, computedAtMs: 1_000, differentialsUsed: 3 });

      await store.wipeGolfer(golferA);

      expect(await store.listLines(golferA)).toEqual([]);
      expect(await store.getIndex(golferA)).toBeUndefined();
      expect(await store.listLines(golferB)).toEqual([lineB]);
      expect(await store.getIndex(golferB)).toEqual({ value: 9.4, computedAtMs: 1_000, differentialsUsed: 3 });
    });

    it("wipeGolfer on a golfer with no projections at all is a no-op, not an error", async () => {
      const store = newStore();
      await expect(store.wipeGolfer(golferId(randomUUID()))).resolves.toBeUndefined();
    });
  });

  // DELETED IN REALIGNMENT TASK 9 alongside ProjectionStore's own crew section — kept here,
  // UNCHANGED, only because the adapter's crew methods stay alive until then.
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

    // Same reopen-and-refinalize shape as putLine's own test above: a DIFFERENT
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
      await store.putLine(golfer, line);
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
      expect(await store.listLines(golfer)).toEqual([line]);
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
