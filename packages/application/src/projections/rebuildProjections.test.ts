import { describe, expect, it } from "vitest";
import { deviceId, fixtureLinks18, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, RoundArchive, RoundEvent, RosterEntry } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { createInMemoryGolferStore, createInMemoryProjectionStore, createInMemorySnapshotStore, createNullLogger, putAndBindGolfer } from "../testing/fakes.js";
import { rebuildProjections } from "./rebuildProjections.js";

const ann = golferId("ann");
const bo = golferId("bo");

// Accounts-only identity (spec §7): the projector — and the rebuild that replays through it —
// projects ONLY account-bound golfers (a golfer row carrying a sub). Every golfer these fixtures
// project must therefore be a real account, so seed ann + bo as sub-bound rows before each rebuild.
const seededGolferStore = async (): Promise<GolferStore> => {
  const golferStore = createInMemoryGolferStore();
  await putAndBindGolfer(golferStore, ann, "sub-ann", "Ann");
  await putAndBindGolfer(golferStore, bo, "sub-bo", "Bo");
  return golferStore;
};

const finalizedEvent = (wallMs: number): RoundEvent => ({
  kind: "round-finalized",
  opId: opId(`finalize-${wallMs}`),
  hlc: { wallMs, counter: 0, deviceId: deviceId("server") },
  authorId: ann,
});

// A minimal, hand-built finalized archive — no scoring math involved at all: `cells` is empty, so
// every projected line honestly carries no `score`. That is enough for THIS file, whose subject is
// the rebuild LOOP (paging, cursors, idempotence, no-wipe), never a derived number — the per-round
// line's own contents are golfer/record.test.ts's concern and the average's are
// golferSlice.test.ts's. The `differential?` parameter this helper used to take is gone with
// RoundArchive.handicapping, the only thing it ever fed (spec 2026-07-29 §7): it had become an
// argument every call site passed and nothing read. Always 18 holes (fixtureLinks18).
const archiveAt = (id: string, wallMs: number, entries: readonly { golferId: GolferId }[]): RoundArchive => ({
  roundId: roundId(id),
  card: fixtureLinks18,
  participants: entries.map((e): RosterEntry => ({ golferId: e.golferId, name: e.golferId, tee: "white", basis: { kind: "normally-shoots", overPar: 8 }, strokes: 0 })),
  games: [],
  cells: {},
  // A real archive's log always opens with round-created (its genesis) — carried here so
  // createdAtMsOf (accounts-only identity spec §5) resolves; its wall time (1) is arbitrary,
  // only its PRESENCE matters to the projector. One participant-joined event per entry is
  // carried too (PC-T1/papercut 11): presence-cleanup reads the ever-seated roster off THESE
  // events, never off archive.participants — without one here, a rebuild replay would never
  // call deleteLive for that golferId.
  events: [
    { kind: "round-created", roundId: roundId(id), card: fixtureLinks18, opId: opId(`created-${id}`), hlc: { wallMs: 1, counter: 0, deviceId: deviceId("server") }, authorId: ann },
    ...entries.map(
      (e, i): RoundEvent => ({
        kind: "participant-joined",
        participant: { golferId: e.golferId, name: e.golferId, tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
        opId: opId(`joined-${id}-${e.golferId}`),
        hlc: { wallMs: 1, counter: i + 1, deviceId: deviceId("server") },
        authorId: e.golferId,
      }),
    ),
    finalizedEvent(wallMs),
  ],
  results: [],
  terminatedGameIds: [],
});

// Wraps the real in-memory ProjectionStore, recording every WRITE method it sees (never the
// reads — listLines tells you nothing about whether a wipe happened). Exists to prove the one
// negative fact a passing test suite can't show any other way: rebuildProjections' loop (Task 5)
// has no code path that can call a DESTRUCTIVE wipe method at all, not merely "didn't happen to
// in this fixture" — this fake is how a regression that reintroduced one would get caught. (The
// crew ledger and its wipe are gone entirely as of Task 9. deleteLive — added Task 13 — is
// recorded here too, but it's projectArchive's own idempotent presence cleanup, not a
// destructive wipe; see the "touches exactly {putLine, deleteLive}" test below. putIndex is gone
// too, pre-prod hardening D4a: the index is computed at read time in getMyRecord.ts, never
// written by this projector at all.)
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
    const archives = Array.from({ length: 7 }, (_, i) => archiveAt(`r${i}`, 1_000 + i, [{ golferId: i % 2 === 0 ? ann : bo }]));
    const snapshots = createInMemorySnapshotStore({ pageSize: 3 });
    for (const archive of archives) snapshots.record(archive);
    const projectionStore = createInMemoryProjectionStore();
    const golferStore = await seededGolferStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore, golferStore, logger: createNullLogger() });

    const result = await rebuild();

    expect(result.processed).toBe(7);
    expect(result.cursor).toBeUndefined(); // the whole table was walked — nothing left to resume
    // Every archive actually landed, not just got counted — one line per roundId, split by parity.
    expect(await projectionStore.listLines(ann)).toHaveLength(4); // r0, r2, r4, r6
    expect(await projectionStore.listLines(bo)).toHaveLength(3); // r1, r3, r5
  });

  it("returns a cursor when maxSnapshots is hit mid-run; resuming from it processes the remainder exactly once", async () => {
    // 6 snapshots, page size 2 -> pages of [2, 2, 2]. maxSnapshots 4 stops after 2 pages.
    const archives = Array.from({ length: 6 }, (_, i) => archiveAt(`r${i}`, 1_000 + i, [{ golferId: ann }]));
    const snapshots = createInMemorySnapshotStore({ pageSize: 2 });
    for (const archive of archives) snapshots.record(archive);
    const projectionStore = createInMemoryProjectionStore();
    const golferStore = await seededGolferStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore, golferStore, logger: createNullLogger() });

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

  // "Wipe" here means a destructive full-replace (the OLD crew ledger's own wipe, gone as of
  // Task 9) — deleteLive is NOT that: it's projectArchive's own idempotent presence cleanup
  // (Task 13, projections/projectArchive.ts), the SAME call the real stream-triggered
  // projector makes at finalize time. A rebuild replaying an already-finalized archive calls
  // deleteLive on a pointer that's already gone (a no-op, per its own port doc) — this test's
  // job is narrower than its name once was: prove the write surface is EXACTLY
  // {putLine, deleteLive}, nothing beyond what projectArchive itself does for every archive
  // it's handed. putIndex is gone from that surface entirely (pre-prod hardening D4a) and so is the
  // index it wrote (spec 2026-07-29 §7): every derived number is computed at read time in
  // getMyRecord.ts, so no count of archives can make the projector write anything but lines.
  it("touches exactly {putLine, deleteLive} — no OTHER write surface (no destructive wipe, no derived-number write)", async () => {
    // 3 archives for the SAME golfer — three was the count that USED to cross the WHS bootstrap and
    // fire putIndex, so keeping three here keeps the regression pin aimed at the same case even
    // though nothing about the number depends on it anymore.
    const archives = [
      archiveAt("r1", 1_000, [{ golferId: ann }]),
      archiveAt("r2", 2_000, [{ golferId: ann }]),
      archiveAt("r3", 3_000, [{ golferId: ann }]),
    ];
    const snapshots = createInMemorySnapshotStore();
    for (const archive of archives) snapshots.record(archive);
    const recording = createRecordingProjectionStore();
    const golferStore = await seededGolferStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore: recording, golferStore, logger: createNullLogger() });

    await rebuild();

    expect(new Set(recording.writeCalls)).toEqual(new Set(["putLine", "deleteLive"]));
  });

  it("replaying the same page(s) twice yields identical store state (idempotence — no wipe means a repeat pass is always safe)", async () => {
    const archives = [
      archiveAt("r1", 1_000, [
        { golferId: ann },
        { golferId: bo },
      ]),
      archiveAt("r2", 2_000, [{ golferId: ann }]),
      archiveAt("r3", 3_000, [{ golferId: ann }]),
    ];
    const snapshots = createInMemorySnapshotStore({ pageSize: 2 }); // ≥2 pages, so a replay re-walks a page boundary too
    for (const archive of archives) snapshots.record(archive);
    const projectionStore = createInMemoryProjectionStore();
    const golferStore = await seededGolferStore();
    const rebuild = rebuildProjections({ snapshots, projectionStore, golferStore, logger: createNullLogger() });

    await rebuild();
    const afterFirst = {
      ann: await projectionStore.listLines(ann),
      bo: await projectionStore.listLines(bo),
    };

    await rebuild(); // the exact same snapshots table, replayed a second full pass — cursor unset, starts over

    expect(await projectionStore.listLines(ann)).toEqual(afterFirst.ann);
    expect(await projectionStore.listLines(bo)).toEqual(afterFirst.bo);
  });
});
