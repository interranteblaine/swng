import { describe, expect, it } from "vitest";
import { deviceId, fixtureLinks18, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { createFrozenClock, createInMemoryProjectionStore, createInMemorySnapshotStore, createNullLogger } from "../testing/fakes.js";
import { rebuildProjections } from "./rebuildProjections.js";

const ann = golferId("ann");
const bo = golferId("bo");

const finalizedEvent = (wallMs: number): RoundEvent => ({
  kind: "round-finalized",
  opId: opId(`finalize-${wallMs}`),
  hlc: { wallMs, counter: 0, deviceId: deviceId("server") },
  authorId: ann,
});

// A minimal, hand-built finalized archive — no real scoring/handicap math involved (that's
// domain's job, exhaustively tested elsewhere); `differential` is hand-pinned directly per
// participant, same idiom as projectionSlice.test.ts's own archiveAt. Always 18 holes
// (fixtureLinks18) — the 9-hole combining rule itself is domain's own unit-gated concern.
const archiveAt = (id: string, wallMs: number, entries: readonly { golferId: GolferId; differential?: number }[]): RoundArchive => ({
  roundId: roundId(id),
  card: fixtureLinks18,
  participants: entries.map((e): Participant => ({ golferId: e.golferId, name: e.golferId, tee: "white", courseHandicap: 8 })),
  games: [],
  cells: {},
  events: [finalizedEvent(wallMs)],
  results: [],
  terminatedGameIds: [],
  handicapping: entries.map((e) =>
    e.differential === undefined
      ? { golferId: e.golferId, kind: "incomplete" as const }
      : { golferId: e.golferId, kind: "complete" as const, ags: 90, differential: e.differential },
  ),
});

// Wraps the real in-memory ProjectionStore, recording every WRITE method it sees (never the
// reads — listLines/getIndex tell you nothing about whether a wipe happened). Exists to prove
// the one negative fact a passing test suite can't show any other way: rebuildProjections' loop
// (Task 5) has no code path that can call a wipe method at all, not merely "didn't happen to in
// this fixture" — this fake is how a regression that reintroduced one would get caught. (The
// crew ledger and its wipe are gone entirely as of Task 9, so the only write surface left to
// guard is the golfer-record one.)
const createRecordingProjectionStore = (): ProjectionStore & { readonly writeCalls: readonly string[] } => {
  const inner = createInMemoryProjectionStore();
  const writeCalls: string[] = [];
  return {
    writeCalls,
    putLine: async (...args) => {
      writeCalls.push("putLine");
      return inner.putLine(...args);
    },
    listLines: (...args) => inner.listLines(...args),
    putIndex: async (...args) => {
      writeCalls.push("putIndex");
      return inner.putIndex(...args);
    },
    getIndex: (...args) => inner.getIndex(...args),
    putLive: async (...args) => {
      writeCalls.push("putLive");
      return inner.putLive(...args);
    },
    deleteLive: async (...args) => {
      writeCalls.push("deleteLive");
      return inner.deleteLive(...args);
    },
    listLive: (...args) => inner.listLive(...args),
  };
};

describe("rebuildProjections", () => {
  it("processes every snapshot across ≥3 pages, in full", async () => {
    // 7 snapshots, alternating golfers, page size 3 -> pages of [3, 3, 1] = 3 pages.
    const archives = Array.from({ length: 7 }, (_, i) => archiveAt(`r${i}`, 1_000 + i, [{ golferId: i % 2 === 0 ? ann : bo, differential: 8 + i }]));
    const snapshots = createInMemorySnapshotStore({ pageSize: 3 });
    for (const archive of archives) snapshots.record(archive);
    const projectionStore = createInMemoryProjectionStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore, clock: createFrozenClock(9_000), logger: createNullLogger() });

    const result = await rebuild();

    expect(result.processed).toBe(7);
    expect(result.cursor).toBeUndefined(); // the whole table was walked — nothing left to resume
    // Every archive actually landed, not just got counted — one line per roundId, split by parity.
    expect(await projectionStore.listLines(ann)).toHaveLength(4); // r0, r2, r4, r6
    expect(await projectionStore.listLines(bo)).toHaveLength(3); // r1, r3, r5
  });

  it("returns a cursor when maxSnapshots is hit mid-run; resuming from it processes the remainder exactly once", async () => {
    // 6 snapshots, page size 2 -> pages of [2, 2, 2]. maxSnapshots 4 stops after 2 pages.
    const archives = Array.from({ length: 6 }, (_, i) => archiveAt(`r${i}`, 1_000 + i, [{ golferId: ann, differential: 8 + i }]));
    const snapshots = createInMemorySnapshotStore({ pageSize: 2 });
    for (const archive of archives) snapshots.record(archive);
    const projectionStore = createInMemoryProjectionStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore, clock: createFrozenClock(9_000), logger: createNullLogger() });

    const first = await rebuild({ maxSnapshots: 4 });
    expect(first.processed).toBe(4);
    expect(first.cursor).toBeDefined();
    const afterFirst = (await projectionStore.listLines(ann)).map((line) => line.roundId).sort();
    expect(afterFirst).toEqual([roundId("r0"), roundId("r1"), roundId("r2"), roundId("r3")].sort());

    const second = await rebuild({ cursor: first.cursor });
    expect(second.processed).toBe(2); // exactly the remainder — r4, r5
    expect(second.cursor).toBeUndefined();

    const all = (await projectionStore.listLines(ann)).map((line) => line.roundId).sort();
    expect(all).toEqual(archives.map((archive) => archive.roundId).sort());
    expect(all).toHaveLength(6); // every round exactly once across both calls — no re-processing, no gap
  });

  it("never calls a wipe method — the recording store sees only putLine/putIndex writes", async () => {
    // 3 archives for the SAME golfer, ascending differentials — the 3rd crosses the bootstrap
    // (computeIndexDetail needs 3+), so putIndex fires too and this isn't just "putLine never
    // wipes," it's "the whole write surface this run touches is exactly {putLine, putIndex}."
    const archives = [
      archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]),
      archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]),
      archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]),
    ];
    const snapshots = createInMemorySnapshotStore();
    for (const archive of archives) snapshots.record(archive);
    const recording = createRecordingProjectionStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore: recording, clock: createFrozenClock(9_000), logger: createNullLogger() });

    await rebuild();

    expect(new Set(recording.writeCalls)).toEqual(new Set(["putLine", "putIndex"]));
  });

  it("replaying the same page(s) twice yields identical store state (idempotence — no wipe means a repeat pass is always safe)", async () => {
    const archives = [
      archiveAt("r1", 1_000, [
        { golferId: ann, differential: 9.0 },
        { golferId: bo, differential: 20.0 },
      ]),
      archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]),
      archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]),
    ];
    const snapshots = createInMemorySnapshotStore({ pageSize: 2 }); // ≥2 pages, so a replay re-walks a page boundary too
    for (const archive of archives) snapshots.record(archive);
    const projectionStore = createInMemoryProjectionStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore, clock: createFrozenClock(9_000), logger: createNullLogger() });

    await rebuild();
    const afterFirst = {
      ann: await projectionStore.listLines(ann),
      annIndex: await projectionStore.getIndex(ann),
      bo: await projectionStore.listLines(bo),
    };

    await rebuild(); // the exact same snapshots table, replayed a second full pass — cursor unset, starts over

    expect(await projectionStore.listLines(ann)).toEqual(afterFirst.ann);
    expect(await projectionStore.getIndex(ann)).toEqual(afterFirst.annIndex);
    expect(await projectionStore.listLines(bo)).toEqual(afterFirst.bo);
  });
});
