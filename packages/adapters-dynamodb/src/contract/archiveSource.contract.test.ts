import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundArchive } from "@swng/domain";
import { fixtureLinks, roundId } from "@swng/domain";
import { createDynamoArchiveSource } from "../createDynamoArchiveSource.js";
import { createDynamoRoundStore } from "../createDynamoRoundStore.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M7 Task 4), same idiom as store.contract.test.ts: proves
// createDynamoArchiveSource's Scan-and-filter against a real DynamoDB Local, over the SAME
// rounds table createDynamoRoundStore.putArchive writes to (the rebuild entry's real source
// of archives). Not part of `pnpm validate`; run via `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const minimalArchive = (id: ReturnType<typeof roundId>): RoundArchive => ({
  roundId: id,
  card: fixtureLinks,
  participants: [],
  games: [],
  cells: {},
  events: [],
  results: [],
  terminatedGameIds: [],
  handicapping: [],
});

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

describe("createDynamoArchiveSource", () => {
  it("listArchives yields every archive put via createDynamoRoundStore, and nothing else", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    const source = createDynamoArchiveSource({ client: local.client, tableName: local.roundsTable });

    const ids = [roundId(randomUUID()), roundId(randomUUID()), roundId(randomUUID())];
    const archives = ids.map(minimalArchive);
    for (const archive of archives) await store.putArchive(archive);
    // A non-archive item (a META round record) in the same table must never be mistaken for
    // an archive — the Scan's FilterExpression is the thing under test here.
    const metaOnlyId = roundId(randomUUID());
    await store.createRound({ roundId: metaOnlyId, joinCode: randomUUID().slice(0, 6).toUpperCase() });

    const found = await collect(source.listArchives());
    const foundIds = new Set(found.map((a) => a.roundId));

    for (const id of ids) expect(foundIds.has(id)).toBe(true);
    expect(foundIds.has(metaOnlyId)).toBe(false);
    for (const archive of archives) {
      expect(found.find((a) => a.roundId === archive.roundId)).toEqual(archive);
    }
  });
});
