import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundArchive } from "@swng/domain";
import { fixtureLinks, roundId } from "@swng/domain";
import { createDynamoConnectionRegistry } from "../createDynamoConnectionRegistry.js";
import { createDynamoRoundStore } from "../createDynamoRoundStore.js";
import { archiveSk, roundPk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M3 plan) for the thin key-value adapters: RoundStore and
// ConnectionRegistry. Not part of `pnpm validate`; run via `pnpm test:contract`.

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
  handicapping: [],
});

describe("createDynamoRoundStore", () => {
  it("createRound + findByJoinCode round-trip", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    const id = roundId(randomUUID());
    const joinCode = randomUUID().slice(0, 6).toUpperCase();

    await store.createRound({ roundId: id, joinCode });

    expect(await store.findByJoinCode(joinCode)).toBe(id);
  });

  it("findByJoinCode returns undefined for an unknown code", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    expect(await store.findByJoinCode(`missing-${randomUUID()}`)).toBeUndefined();
  });

  it("putArchive persists the archive, and re-finalizing overwrites it (idempotent upsert)", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    const id = roundId(randomUUID());
    const archive = minimalArchive(id);

    await store.putArchive(archive);
    const raw = await local.client.send(new GetCommand({ TableName: local.roundsTable, Key: { pk: roundPk(id), sk: archiveSk } }));
    expect(raw.Item?.archive).toEqual(archive);

    // A reopen + re-finalize settles the same roundId again — must overwrite, not conflict.
    const resettled = { ...archive, results: [] };
    await expect(store.putArchive(resettled)).resolves.toBeUndefined();
  });
});

describe("createDynamoConnectionRegistry", () => {
  it("register/listByRound/deregister round-trip", async () => {
    const registry = createDynamoConnectionRegistry({ client: local.client, tableName: local.connectionsTable });
    const id = roundId(randomUUID());
    const connA = `conn-${randomUUID()}`;
    const connB = `conn-${randomUUID()}`;

    await registry.register(connA, id);
    await registry.register(connB, id);

    expect(new Set(await registry.listByRound(id))).toEqual(new Set([connA, connB]));

    await registry.deregister(connA);
    expect(await registry.listByRound(id)).toEqual([connB]);
  });

  it("listByRound returns [] for a round with no connections", async () => {
    const registry = createDynamoConnectionRegistry({ client: local.client, tableName: local.connectionsTable });
    expect(await registry.listByRound(roundId(randomUUID()))).toEqual([]);
  });
});
