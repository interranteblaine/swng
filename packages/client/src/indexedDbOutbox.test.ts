import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { deviceId, golferId, opId, roundId } from "@swng/domain";
import type { RoundEvent } from "@swng/domain";
import { createIndexedDbOutboxStore } from "./indexedDbOutbox.js";
import type { PersistedSync } from "./outbox.js";

const SCORE_EVENT: RoundEvent = {
  kind: "score-recorded",
  opId: opId("device-a-1"),
  hlc: { wallMs: 1_000, counter: 0, deviceId: deviceId("device-a") },
  authorId: golferId("golfer-a"),
  golferId: golferId("golfer-a"),
  hole: 1,
  result: { kind: "strokes", strokes: 4 },
};

describe("createIndexedDbOutboxStore", () => {
  it("round-trips a saved sync state through IndexedDB", async () => {
    const store = createIndexedDbOutboxStore({ indexedDb: new IDBFactory() });
    const sync: PersistedSync = { pending: [SCORE_EVENT], lastSeq: 5, opCounter: 1, rejected: [] };

    await store.save(roundId("round-1"), sync);
    const loaded = await store.load(roundId("round-1"));

    expect(loaded).toEqual(sync);
  });

  it("returns undefined for a round that was never saved", async () => {
    const store = createIndexedDbOutboxStore({ indexedDb: new IDBFactory() });

    await expect(store.load(roundId("never-saved"))).resolves.toBeUndefined();
  });

  it("persists across two store instances sharing one IDBFactory — the app-restarted case", async () => {
    const factory = new IDBFactory();
    const sync: PersistedSync = { pending: [SCORE_EVENT], lastSeq: 7, opCounter: 4, rejected: [] };

    const first = createIndexedDbOutboxStore({ indexedDb: factory, databaseName: "restart-test" });
    await first.save(roundId("round-1"), sync);

    // A brand new store instance — as if the app were reloaded — over the SAME factory
    // (the durable "disk") must see what the first instance wrote.
    const second = createIndexedDbOutboxStore({ indexedDb: factory, databaseName: "restart-test" });
    const loaded = await second.load(roundId("round-1"));

    expect(loaded).toEqual(sync);
  });
});
