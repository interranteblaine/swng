import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
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
