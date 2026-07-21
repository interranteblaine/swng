import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roundId } from "@swng/domain";
import { createDynamoConnectionRegistry } from "../createDynamoConnectionRegistry.js";
import { createDynamoRoundStore } from "../createDynamoRoundStore.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M3 plan) for the thin key-value adapters: RoundStore and
// ConnectionRegistry. The terminal archive no longer lives on the rounds table — it moved to
// the snapshots table (snapshotStore.contract.test.ts / journal.contract.test.ts cover it now)
// — so this suite is back to just the join-code lookup and the WS connection registry. Not part
// of `pnpm validate`; run via `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
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

  it("getJoinCode returns the code createRound stored", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    const id = roundId(randomUUID());
    const joinCode = randomUUID().slice(0, 6).toUpperCase();

    await store.createRound({ roundId: id, joinCode });

    expect(await store.getJoinCode(id)).toBe(joinCode);
  });

  it("getJoinCode returns undefined for an unknown round", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    const unknownId = roundId(randomUUID());
    expect(await store.getJoinCode(unknownId)).toBeUndefined();
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
