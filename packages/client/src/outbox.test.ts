import { describe, expect, it } from "vitest";
import { deviceId, golferId, opId, roundId } from "@swng/domain";
import type { RoundEvent } from "@swng/domain";
import { createMemoryOutboxStore } from "./outbox.js";
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

describe("createMemoryOutboxStore", () => {
  it("round-trips a saved sync state", async () => {
    const store = createMemoryOutboxStore();
    const sync: PersistedSync = { pending: [SCORE_EVENT], lastSeq: 5, opCounter: 1 };

    await store.save(roundId("round-1"), sync);
    const loaded = await store.load(roundId("round-1"));

    expect(loaded).toEqual(sync);
  });

  it("returns undefined for a round that was never saved", async () => {
    const store = createMemoryOutboxStore();

    await expect(store.load(roundId("never-saved"))).resolves.toBeUndefined();
  });

  it("keeps rounds isolated from one another", async () => {
    const store = createMemoryOutboxStore();
    const syncA: PersistedSync = { pending: [], lastSeq: 1, opCounter: 0 };
    const syncB: PersistedSync = { pending: [SCORE_EVENT], lastSeq: 2, opCounter: 1 };

    await store.save(roundId("round-a"), syncA);
    await store.save(roundId("round-b"), syncB);

    await expect(store.load(roundId("round-a"))).resolves.toEqual(syncA);
    await expect(store.load(roundId("round-b"))).resolves.toEqual(syncB);
  });
});
