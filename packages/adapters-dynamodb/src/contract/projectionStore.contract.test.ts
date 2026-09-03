import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { GolferRoundLine, RoundId } from "@swng/domain";
import { courseId, golferId, roundId } from "@swng/domain";
import { createDynamoProjectionStore } from "../createDynamoProjectionStore.js";
import { golferPk } from "../keys.js";
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

// playedAtMs (spec 2026-08-01 §4a) is REQUIRED on a stored line — defaults to finalizedAtMs
// (a round played and finalized "now" in these fixtures), overridable via `overrides` for the
// tests below that need a distinct played-at value.
const makeLine = (
  id: ReturnType<typeof roundId>,
  finalizedAtMs: number,
  overrides: Partial<GolferRoundLine> & { playedAtMs?: number } = {},
): GolferRoundLine & { finalizedAtMs: number; playedAtMs: number } => ({
  roundId: id,
  courseName: "Casa Verde GC",
  tee: "white",
  holes: 18,
  par: 72,
  strokes: 8,
  distribution,
  finalizedAtMs,
  playedAtMs: finalizedAtMs,
  ...overrides,
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

    it("round-trips courseId on a line (Task 7: the analytics join key) — the store persists the line object whole, so no field list drops it", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const line = makeLine(roundId(randomUUID()), 1_000, { courseId: courseId("course-1") });

      await store.putLine(golfer, line);

      expect(await store.listLines(golfer)).toEqual([line]);
    });

    it("round-trips createdAtMs on a line (accounts-only identity spec §5); a line written without it reads back without it", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const withCreated = { ...makeLine(roundId(randomUUID()), 2_000), createdAtMs: 1_500 };
      const withoutCreated = makeLine(roundId(randomUUID()), 3_000);

      await store.putLine(golfer, withCreated);
      await store.putLine(golfer, withoutCreated);

      const back = new Map((await store.listLines(golfer)).map((line) => [line.roundId, line]));
      expect(back.get(withCreated.roundId)?.createdAtMs).toBe(1_500);
      expect(back.get(withoutCreated.roundId)).not.toHaveProperty("createdAtMs");
    });

    // playedAtMs (spec 2026-08-01 §4a) is REQUIRED and distinct from finalizedAtMs — a golfer
    // entering last Friday's card on Sunday finalizes "now" but played "then". A value that
    // differs from finalizedAtMs (rather than makeLine's own default-to-finalizedAtMs shortcut)
    // proves the two fields round-trip independently, not conflated.
    it("round-trips playedAtMs on a line, distinct from finalizedAtMs", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const line = makeLine(roundId(randomUUID()), 5_000, { playedAtMs: 1_000 });

      await store.putLine(golfer, line);

      const [back] = await store.listLines(golfer);
      expect(back?.playedAtMs).toBe(1_000);
      expect(back?.finalizedAtMs).toBe(5_000);
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

  // The stored handicap-index snapshot and its putIndex/getIndex methods are GONE (pre-prod
  // hardening D4a): the index is computed at read time from listLines' own lines
  // (golfers/getMyRecord.ts), never stored on this table. A live table can still carry rows
  // written under the OLD sort key ("INDEX") from before this change — this pin proves they are
  // genuinely dead data, not just unread by the deleted methods: a raw item seeded directly under
  // that legacy sk (bypassing the port entirely, since the port has no way to write one anymore)
  // must be INVISIBLE to listLines' `ROUND#`-prefixed begins_with query, never surfacing as a
  // phantom "round" line.
  describe("a legacy INDEX row (pre-D4a data) is invisible to listLines", () => {
    it("a raw item seeded under the old 'INDEX' sort key never appears in listLines' ROUND#-prefixed query", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const line = makeLine(roundId(randomUUID()), 1_000);
      await store.putLine(golfer, line);
      // Seeded directly via the raw client — the port itself no longer has a way to write this.
      await local.client.send(
        new PutCommand({
          TableName: local.projectionsTable,
          Item: { pk: golferPk(golfer), sk: "INDEX", snapshot: { value: 12.3, computedAtMs: 1_000, differentialsUsed: 3 } },
        }),
      );

      expect(await store.listLines(golfer)).toEqual([line]);
    });
  });

  describe("putLive / listLive / deleteLive (presence, projection-realignment spec §5)", () => {
    it("put + listLive round-trip for one live round", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const round = roundId(randomUUID());

      await store.putLive(golfer, { roundId: round, courseName: "Casa Verde GC", joinedAtMs: 1_000 });

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

      await store.putLive(golferA, { roundId: roundA1, courseName: "Casa Verde GC", joinedAtMs: 1_000 });
      await store.putLive(golferA, { roundId: roundA2, courseName: "Pebble Municipal", joinedAtMs: 2_000 });
      await store.putLive(golferB, { roundId: roundB1, courseName: "Casa Verde GC", joinedAtMs: 1_000 });

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
      await store.putLive(golfer, { roundId: keep, courseName: "Casa Verde GC", joinedAtMs: 1_000 });
      await store.putLive(golfer, { roundId: drop, courseName: "Pebble Municipal", joinedAtMs: 2_000 });

      await store.deleteLive(golfer, drop);

      expect(await store.listLive(golfer)).toEqual([{ roundId: keep, courseName: "Casa Verde GC", joinedAtMs: 1_000 }]);
    });

    it("deleteLive on a round that was never live is a no-op, not an error", async () => {
      const store = newStore();
      await expect(store.deleteLive(golferId(randomUUID()), roundId(randomUUID()))).resolves.toBeUndefined();
    });

    // A presence pointer NEVER self-expires (2026-09-03 ticket). It is a golfer's only route
    // back into a live round they are seated in, and the round's own lifecycle — finalize
    // (projections/projectArchive.ts) or abandon (rounds/abandonRound.ts) — is the ONLY thing
    // that removes it. The former 36h TTL was anchored to SEAT time, so a round created for a
    // tee time further out than that deleted its own creator's way back in before the golf ever
    // happened: exactly what happened to the round created 72h ahead on 2026-09-01.
    //
    // DynamoDB's sweep only ever touches items that CARRY the `ttl` attribute (the projections
    // table's TTL spec, apps/infra-cdk/lib/swngStack.ts — history lines have always relied on
    // this), so the guarantee is precisely "the attribute is absent." Read raw via the document
    // client, bypassing listLive, because absence is invisible through the port.
    it("putLive writes NO `ttl` attribute — a presence pointer never expires on its own", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const round = roundId(randomUUID());

      await store.putLive(golfer, { roundId: round, courseName: "Casa Verde GC", joinedAtMs: 1_000 });

      const raw = await local.client.send(new GetCommand({ TableName: local.projectionsTable, Key: { pk: `GOLFER#${golfer}`, sk: `LIVE#${round}` } }));
      expect(raw.Item).toBeDefined(); // the row itself was written
      expect(raw.Item).not.toHaveProperty("ttl");
    });
  });

  // The crew ledger contract coverage is GONE alongside the store methods themselves
  // (architecture-realignment Task 9): crew standings are computed on read over the snapshots
  // table (crews/getSeasonStandings), not stored on the projections table.
});
