import { randomUUID } from "node:crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundArchive, RoundId } from "@swng/domain";
import { fixtureLinks, roundId } from "@swng/domain";
import { createDynamoSnapshotStore } from "../createDynamoSnapshotStore.js";
import { snapshotPk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (projection-realignment Task 2): proves createDynamoSnapshotStore's READ side
// (get/getMany/page) against a real DynamoDB Local snapshots table. The WRITE side isn't here
// by design — a snapshot is only ever written through createDynamoEventJournal's atomic finalize
// transaction (journal.contract.test.ts covers that), so this suite seeds items with a raw Put.
// Not part of `pnpm validate`; run via `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const minimalArchive = (id: RoundId): RoundArchive => ({
  roundId: id,
  card: fixtureLinks,
  participants: [],
  games: [],
  cells: {},
  events: [],
  results: [],
  terminatedGameIds: [],
});

// Seeds one snapshot item in the exact shape createDynamoEventJournal's atomic commit writes
// (`{ pk: <roundId>, finalizedAt, archive }`) — the store's read side is what's under test, so
// the write is a plain Put here.
const seed = async (id: RoundId, finalizedAt: number): Promise<RoundArchive> => {
  const archive = minimalArchive(id);
  await local.client.send(new PutCommand({ TableName: local.snapshotsTable, Item: { pk: snapshotPk(id), finalizedAt, archive } }));
  return archive;
};

describe("createDynamoSnapshotStore", () => {
  it("get returns undefined for a round with no snapshot", async () => {
    const store = createDynamoSnapshotStore({ client: local.client, tableName: local.snapshotsTable });
    expect(await store.get(roundId(randomUUID()))).toBeUndefined();
  });

  it("get round-trips exactly what was written", async () => {
    const store = createDynamoSnapshotStore({ client: local.client, tableName: local.snapshotsTable });
    const id = roundId(randomUUID());
    const archive = await seed(id, 1_000);

    expect(await store.get(id)).toEqual(archive);
  });

  it("getMany returns the present snapshots and silently omits absent ids", async () => {
    const store = createDynamoSnapshotStore({ client: local.client, tableName: local.snapshotsTable });
    const present = [roundId(randomUUID()), roundId(randomUUID())];
    const absent = roundId(randomUUID());
    const archives = await Promise.all(present.map((id, i) => seed(id, 2_000 + i)));

    const found = await store.getMany([present[0]!, absent, present[1]!]);

    // Order isn't promised (SnapshotStore's port doc) — compare as a set. Absent id omitted.
    expect(new Set(found.map((a) => a.roundId))).toEqual(new Set(present));
    for (const archive of archives) {
      expect(found.find((a) => a.roundId === archive.roundId)).toEqual(archive);
    }
  });

  // Spec 2026-07-30 §10, the same correction as journal.read's: this store used to assert
  // `item.archive as RoundArchive` on all three read paths, so a snapshot missing a field the
  // domain type requires was believed by the type and folded anyway — into the golfer's permanent
  // record (the projector), into a crew's standings, into a finalize's idempotent replay. It now
  // parses through `roundArchiveSchema`, the one schema that also backs the stream image the
  // projector reads, so a corrupt snapshot is loud at every door rather than silent at three.
  describe("reads parse the stored archive rather than asserting it", () => {
    // `page` (below) Scans the WHOLE table, so a corrupt item left behind would fail it for the
    // right reason at the wrong seam. Each probe cleans up its own item.
    const withCorruptSnapshot = async (archive: unknown, probe: (id: RoundId) => Promise<void>): Promise<void> => {
      const id = roundId(randomUUID());
      await local.client.send(new PutCommand({ TableName: local.snapshotsTable, Item: { pk: snapshotPk(id), finalizedAt: 9_000, archive } }));
      try {
        await probe(id);
      } finally {
        await local.client.send(new DeleteCommand({ TableName: local.snapshotsTable, Key: { pk: snapshotPk(id) } }));
      }
    };

    it("get rejects a snapshot whose archive is missing a required field", async () => {
      const store = createDynamoSnapshotStore({ client: local.client, tableName: local.snapshotsTable });
      // Every field but `participants` — exactly the "a field the type declares required is
      // absent at runtime" shape the cast used to wave through.
      await withCorruptSnapshot({ roundId: "r-corrupt", card: fixtureLinks, games: [], cells: {}, events: [], results: [], terminatedGameIds: [] }, async (id) => {
        await expect(store.get(id)).rejects.toThrow(/stored-archive-invalid/);
      });
    });

    it("getMany rejects a corrupt archive rather than folding it", async () => {
      const store = createDynamoSnapshotStore({ client: local.client, tableName: local.snapshotsTable });
      // A participant with no `strokes` — the exact field this arc made required (spec §2), and
      // the exact class of absence the cast made unrepresentable-in-theory and routine-in-practice.
      const archive = {
        roundId: "r-corrupt",
        card: fixtureLinks,
        participants: [{ golferId: "ann", name: "Ann", tee: "white" }],
        games: [],
        cells: {},
        events: [],
        results: [],
        terminatedGameIds: [],
      };
      await withCorruptSnapshot(archive, async (id) => {
        await expect(store.getMany([id])).rejects.toThrow(/stored-archive-invalid/);
      });
    });

    // `page` is the door with the sharpest consequence, so it gets its own pin rather than riding
    // on its two siblings. It parses a whole page EAGERLY, so one bad item takes down the good
    // items ahead of it in that page AND the cursor never advances past it — a full cursor-driven
    // walk cannot complete, which is precisely `rebuildProjections` bricked at whichever page the
    // bad item lands on. That is the intended trade (loud beats projecting garbage into every
    // golfer's permanent record), but it is a behaviour an operator has to be able to rely on, so
    // it is pinned, not inferred.
    it("page cannot complete a cursor walk while one corrupt snapshot is on the table", async () => {
      const store = createDynamoSnapshotStore({ client: local.client, tableName: local.snapshotsTable, pageLimit: 2 });
      // A `cells` map whose entry is not a ScoreCell at all — a third distinct corruption shape,
      // so the three pins don't all rest on one missing field.
      const corrupt = { roundId: "r-corrupt", card: fixtureLinks, participants: [], games: [], cells: { "ann#1": { result: "4" } }, events: [], results: [], terminatedGameIds: [] };

      await withCorruptSnapshot(corrupt, async () => {
        const walk = async (): Promise<number> => {
          let cursor: string | undefined;
          let seen = 0;
          do {
            const result = await store.page(cursor);
            seen += result.snapshots.length;
            cursor = result.cursor;
          } while (cursor);
          return seen;
        };

        // The walk throws somewhere in the scan — wherever the bad item sorts — and can never
        // reach a `cursor === undefined` completion. Asserted over the whole walk rather than a
        // single `page()` call, because WHICH page holds the bad item is not deterministic while
        // the other tests' snapshots share this table, but "the walk cannot finish" always is.
        await expect(walk()).rejects.toThrow(/stored-archive-invalid/);
      });

      // ...and once it's gone (withCorruptSnapshot's own cleanup), the walk completes again — so
      // the failure is the item, not a store the test permanently poisoned.
      let cursor: string | undefined;
      do {
        cursor = (await store.page(cursor)).cursor;
      } while (cursor);
    });
  });

  it("page walks every item exactly once across ≥3 pages (page size 2, cursor-driven)", async () => {
    // Five snapshots of our own — a page size of 2 forces at least three pages (2 + 2 + 1).
    const ids = Array.from({ length: 5 }, () => roundId(randomUUID()));
    for (const [i, id] of ids.entries()) await seed(id, 3_000 + i);

    const store = createDynamoSnapshotStore({ client: local.client, tableName: local.snapshotsTable, pageLimit: 2 });

    const seenCounts = new Map<RoundId, number>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await store.page(cursor);
      pages += 1;
      for (const snapshot of result.snapshots) seenCounts.set(snapshot.roundId, (seenCounts.get(snapshot.roundId) ?? 0) + 1);
      cursor = result.cursor;
      expect(result.snapshots.length).toBeLessThanOrEqual(2); // Limit is honored page-by-page
    } while (cursor);

    // Each of our five appears exactly once across the walk (no gap, no double-yield at a page
    // boundary) — the cursor is the sole progress authority.
    for (const id of ids) expect(seenCounts.get(id)).toBe(1);
    expect(pages).toBeGreaterThanOrEqual(3);
  });
});
