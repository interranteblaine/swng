import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CrewId, RoundArchive, RoundEvent } from "@swng/domain";
import { crewId, deviceId, fixtureLinks, golferId, opId, roundId, settleRound } from "@swng/domain";
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
  terminatedGameIds: [],
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

  // The M8 Task 4 live defect's contract-level pin: `minimalArchive` above is a HAND-BUILT
  // fixture whose optional crewId key is simply absent — which is exactly how the explicit-
  // undefined bug slipped past this suite. settleRound used to emit `crewId: undefined` as a
  // real property on every non-crew archive, and the document client's marshall() (which,
  // deliberately, does NOT set removeUndefinedValues — the archive is the canonical
  // stream/projector payload, so an explicit-undefined key is a domain shape violation to
  // fix at the source, not mask at the adapter) threw on it: every non-crew round's first
  // finalize on beta 500'd. These two run REAL settleRound output through the REAL putArchive
  // so the class — not just the instance — stays pinned.
  const settledLog = (id: ReturnType<typeof roundId>, tag?: CrewId): RoundEvent[] => {
    const at = (wallMs: number) => ({ wallMs, counter: 0, deviceId: deviceId("contract-test") });
    const author = golferId(`author-${id}`);
    return [
      {
        kind: "round-created",
        roundId: id,
        card: fixtureLinks,
        ...(tag !== undefined ? { crewId: tag } : {}),
        opId: opId(`op-${id}-created`),
        hlc: at(1),
        authorId: author,
      },
      { kind: "round-started", opId: opId(`op-${id}-started`), hlc: at(2), authorId: author },
      { kind: "round-finalized", opId: opId(`op-${id}-finalized`), hlc: at(3), authorId: author },
    ];
  };

  it("putArchive accepts a settleRound-PRODUCED archive for a NON-crew round (no crewId key) — the exact class that crashed marshall live", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    const id = roundId(randomUUID());
    const archive = settleRound(settledLog(id));

    // putArchive FIRST — with the explicit-undefined bug in place, THIS line is what threw
    // ("Pass options.removeUndefinedValues=true..."), so it must be the first thing
    // exercised, not short-circuited by a shape assertion above it.
    await store.putArchive(archive);

    expect("crewId" in archive).toBe(false); // the domain-level pin, re-asserted at the boundary this suite owns
    const raw = await local.client.send(new GetCommand({ TableName: local.roundsTable, Key: { pk: roundPk(id), sk: archiveSk } }));
    expect(raw.Item?.archive).toEqual(archive);
    expect("crewId" in (raw.Item?.archive as Record<string, unknown>)).toBe(false); // absent on the stored item too, not resurrected by the round-trip
  });

  it("putArchive round-trips a settleRound-PRODUCED crew-tagged archive with its crewId intact", async () => {
    const store = createDynamoRoundStore({ client: local.client, tableName: local.roundsTable });
    const id = roundId(randomUUID());
    const tag = crewId(`crew-${randomUUID()}`);
    const archive = settleRound(settledLog(id, tag));
    expect(archive.crewId).toBe(tag);

    await store.putArchive(archive);

    const raw = await local.client.send(new GetCommand({ TableName: local.roundsTable, Key: { pk: roundPk(id), sk: archiveSk } }));
    expect(raw.Item?.archive).toEqual(archive);
    expect((raw.Item?.archive as { crewId?: string }).crewId).toBe(tag);
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
