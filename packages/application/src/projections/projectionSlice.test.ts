import { describe, expect, it } from "vitest";
import { computeIndex, deviceId, fixtureLinks18, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import { createFrozenClock, createInMemoryProjectionStore, createNullLogger } from "../testing/fakes.js";
import { finalizedAtMsOf, projectArchive } from "./projectArchive.js";
import type { ArchiveSource } from "./rebuildProjections.js";
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
// domain's job, exhaustively tested elsewhere in handicap/whs.test.ts and
// golfer/record.test.ts); `differential` is hand-pinned directly per participant, same
// idiom as golfer/record.test.ts's baseArchive. Always 18 holes (fixtureLinks18) — the
// 9-hole combining rule itself stays domain's own unit-gated concern (Task 1).
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

const setup = () => ({
  projectionStore: createInMemoryProjectionStore(),
  logger: createNullLogger(),
});

describe("finalizedAtMsOf", () => {
  it("reads the round-finalized event's hlc.wallMs", () => {
    const archive = archiveAt("r1", 4_242, [{ golferId: ann, differential: 9.0 }]);
    expect(finalizedAtMsOf(archive)).toBe(4_242);
  });

  it("throws for a settled archive with no round-finalized event — corrupt by construction", () => {
    const corrupt: RoundArchive = { ...archiveAt("r1", 1_000, [{ golferId: ann }]), events: [] };
    expect(() => finalizedAtMsOf(corrupt)).toThrow();
  });
});

describe("projectArchive", () => {
  it("writes one history line per participant; index stays absent below the 3-differential bootstrap", async () => {
    const ctx = setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]);
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(archive);

    const history = await ctx.projectionStore.listHistory(ann);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ roundId: roundId("r1"), differential: 9.0, finalizedAtMs: 1_000 });
    expect(await ctx.projectionStore.getIndex(ann)).toBeUndefined();
  });

  it("crosses the bootstrap on the 3rd differential; differentialsUsed is the WHS use-count, not the window size", async () => {
    const ctx = setup();
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]));
    expect(await ctx.projectionStore.getIndex(ann)).toBeUndefined();

    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]));
    expect(await ctx.projectionStore.getIndex(ann)).toBeUndefined();

    await project(archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]));
    const index = await ctx.projectionStore.getIndex(ann);
    // 3 differentials available → Rule 5.2a uses only the lowest 1 (whs.test.ts's
    // computeIndexDetail pin), not 3.
    expect(index).toEqual({ value: computeIndex([9.0, 10.0, 11.0]), computedAtMs: 5_000, differentialsUsed: 1 });
  });

  it("is idempotent: re-putting the same history line doesn't duplicate it", async () => {
    const ctx = setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]);
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(archive);
    await project(archive);

    const history = await ctx.projectionStore.listHistory(ann);
    expect(history).toHaveLength(1);
  });

  it("is idempotent across the bootstrap boundary: re-projecting the last archive leaves listHistory/getIndex unchanged", async () => {
    const ctx = setup();
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });
    const third = archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]);

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]));
    await project(third);
    const historyBefore = await ctx.projectionStore.listHistory(ann);
    const indexBefore = await ctx.projectionStore.getIndex(ann);

    await project(third); // the exact same archive, again

    expect(await ctx.projectionStore.listHistory(ann)).toEqual(historyBefore);
    expect(await ctx.projectionStore.getIndex(ann)).toEqual(indexBefore);
  });

  it("tracks each participant's history/index independently; an always-incomplete golfer never bootstraps", async () => {
    const ctx = setup();
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }, { golferId: bo }]));
    await project(archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }, { golferId: bo }]));

    expect(await ctx.projectionStore.getIndex(ann)).toBeDefined();
    expect(await ctx.projectionStore.listHistory(bo)).toHaveLength(3);
    expect(await ctx.projectionStore.getIndex(bo)).toBeUndefined(); // incomplete every round — never a differential to combine
  });

  it("throws for a settled archive with no round-finalized event", async () => {
    const ctx = setup();
    const corrupt: RoundArchive = { ...archiveAt("r1", 1_000, [{ golferId: ann }]), events: [] };
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });
    await expect(project(corrupt)).rejects.toThrow();
  });
});

const createArchiveSource = (archives: readonly RoundArchive[]): ArchiveSource => ({
  listArchives: async function* () {
    for (const archive of archives) yield archive;
  },
});

describe("rebuildProjections", () => {
  it("wipe-then-replay reproduces the same store contents as incremental projectArchive calls, and wipes stale data first", async () => {
    const archives = [
      archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]),
      archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]),
      archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]),
    ];

    // Path A: the "live" incremental build — 3 sequential projectArchive calls in
    // chronological order, exactly as they'd really happen one finalize at a time.
    const incrementalStore = createInMemoryProjectionStore();
    const incrementalProject = projectArchive({ projectionStore: incrementalStore, clock: createFrozenClock(9_000), logger: createNullLogger() });
    for (const archive of archives) await incrementalProject(archive);

    // Path B: rebuildProjections, fed the archives in a DIFFERENT (unsorted) order — it
    // must sort by finalizedAt itself — and pre-seeded with a stray line/index from a
    // round that no longer belongs (proving the wipe-first step, not just an upsert-over).
    const rebuiltStore = createInMemoryProjectionStore();
    await rebuiltStore.putHistoryLine(ann, {
      roundId: roundId("stale-round"),
      courseName: "Nowhere GC",
      tee: "white",
      holes: 18,
      differential: 99,
      distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      finalizedAtMs: 500,
    });
    await rebuiltStore.putIndex(ann, { value: 36, computedAtMs: 1, differentialsUsed: 1 });

    const rebuild = rebuildProjections({
      archiveSource: createArchiveSource([archives[2]!, archives[0]!, archives[1]!]),
      projectionStore: rebuiltStore,
      clock: createFrozenClock(9_000),
      logger: createNullLogger(),
    });
    const summary = await rebuild();

    expect(summary).toEqual({ rounds: 3, golfers: 1 });
    expect(await rebuiltStore.listHistory(ann)).toEqual(await incrementalStore.listHistory(ann));
    expect(await rebuiltStore.getIndex(ann)).toEqual(await incrementalStore.getIndex(ann));
    // The stale line is gone, not merely joined by the 3 real ones.
    expect((await rebuiltStore.listHistory(ann)).some((line) => line.roundId === roundId("stale-round"))).toBe(false);
  });

  it("wipes and replays every golfer touched across the archive set, independently", async () => {
    const archives = [archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo, differential: 20.0 }])];
    const store = createInMemoryProjectionStore();

    const rebuild = rebuildProjections({ archiveSource: createArchiveSource(archives), projectionStore: store, clock: createFrozenClock(9_000), logger: createNullLogger() });
    const summary = await rebuild();

    expect(summary).toEqual({ rounds: 1, golfers: 2 });
    expect(await store.listHistory(ann)).toHaveLength(1);
    expect(await store.listHistory(bo)).toHaveLength(1);
  });
});
