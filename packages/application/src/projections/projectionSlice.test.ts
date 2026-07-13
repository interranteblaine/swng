import { describe, expect, it } from "vitest";
import { computeIndex, deviceId, fixtureLinks18, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, GolferRoundLine, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { createFrozenClock, createInMemoryProjectionStore, createNullLogger } from "../testing/fakes.js";
import { finalizedAtMsOf, projectArchive } from "./projectArchive.js";

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
  // A real archive's log always opens with round-created (its genesis) — carried here so
  // createdAtMsOf (accounts-only identity spec §5) resolves; its wall time (1) is arbitrary,
  // no test below asserts it, only its PRESENCE matters.
  events: [
    { kind: "round-created", roundId: roundId(id), card: fixtureLinks18, opId: opId(`created-${id}`), hlc: { wallMs: 1, counter: 0, deviceId: deviceId("server") }, authorId: ann },
    finalizedEvent(wallMs),
  ],
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

    const history = await ctx.projectionStore.listLines(ann);
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

    const history = await ctx.projectionStore.listLines(ann);
    expect(history).toHaveLength(1);
  });

  it("is idempotent across the bootstrap boundary: re-projecting the last archive leaves listLines/getIndex unchanged", async () => {
    const ctx = setup();
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });
    const third = archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]);

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]));
    await project(third);
    const historyBefore = await ctx.projectionStore.listLines(ann);
    const indexBefore = await ctx.projectionStore.getIndex(ann);

    await project(third); // the exact same archive, again

    expect(await ctx.projectionStore.listLines(ann)).toEqual(historyBefore);
    expect(await ctx.projectionStore.getIndex(ann)).toEqual(indexBefore);
  });

  it("tracks each participant's history/index independently; an always-incomplete golfer never bootstraps", async () => {
    const ctx = setup();
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }, { golferId: bo }]));
    await project(archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }, { golferId: bo }]));

    expect(await ctx.projectionStore.getIndex(ann)).toBeDefined();
    expect(await ctx.projectionStore.listLines(bo)).toHaveLength(3);
    expect(await ctx.projectionStore.getIndex(bo)).toBeUndefined(); // incomplete every round — never a differential to combine
  });

  it("throws for a settled archive with no round-finalized event", async () => {
    const ctx = setup();
    const corrupt: RoundArchive = { ...archiveAt("r1", 1_000, [{ golferId: ann }]), events: [] };
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });
    await expect(project(corrupt)).rejects.toThrow();
  });

  // Presence cleanup (projection-realignment spec §5, Task 13): the finalized archive's own
  // participant list IS the seated roster a LIVE pointer was written for at seat-time
  // (rounds/presence.ts) — this is the PRIMARY removal path (TTL is only a backstop for a
  // round that never finalizes).
  it("deletes the LIVE pointer for every participant on the archive", async () => {
    const ctx = setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo }]);
    await ctx.projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500, expiresAtSec: 9_999_999_999 });
    await ctx.projectionStore.putLive(bo, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 600, expiresAtSec: 9_999_999_999 });
    // A DIFFERENT round's presence for ann must survive untouched.
    await ctx.projectionStore.putLive(ann, { roundId: roundId("other-round"), courseName: "Pebble Municipal", joinedAtMs: 100, expiresAtSec: 9_999_999_999 });
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(archive);

    expect(await ctx.projectionStore.listLive(ann)).toEqual([{ roundId: roundId("other-round"), courseName: "Pebble Municipal", joinedAtMs: 100 }]);
    expect(await ctx.projectionStore.listLive(bo)).toEqual([]);
  });

  // Idempotence, same discipline as putLine's own re-projection pin above: a re-projection of
  // an already-projected archive (the stream trigger's own at-least-once delivery, or a
  // rebuild replay) calls deleteLive on a pointer that's already gone — never an error.
  it("re-projecting the same archive a second time is a no-op for presence, not an error", async () => {
    const ctx = setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]);
    await ctx.projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500, expiresAtSec: 9_999_999_999 });
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(archive);
    await expect(project(archive)).resolves.toBeUndefined();

    expect(await ctx.projectionStore.listLive(ann)).toEqual([]);
  });
});

// ProjectionStore.listLines is UNORDERED by contract (ports/projectionStore.ts) — the stable
// ROUND# sk carries no time to sort by, unlike the old HISTORY# scheme's Query, which returned
// oldest-first for free. This proves projectArchive itself imposes the (finalizedAtMs, roundId)
// order BEFORE the index fold, via a fake store whose listLines returns lines in the OPPOSITE
// order from how they were logically produced.
describe("projectArchive sorts listLines before the index fold (order, not just count, must be right)", () => {
  const nineHoleLine = (id: string, finalizedAtMs: number, differential: number): GolferRoundLine & { finalizedAtMs: number } => ({
    roundId: roundId(id),
    courseName: "Casa Verde GC",
    tee: "white",
    holes: 9,
    differential,
    distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
    finalizedAtMs,
  });

  it("combineNineHoleDifferentials pairs adjacent entries positionally (its own doc comment) — feeding it unsorted mispairs everyone, not just reorders the same pairs", async () => {
    // 7 nine-hole lines, chronological order r1..r7. combineNineHoleDifferentials pairs
    // adjacent entries and leaves an odd one out (its own doc comment): sorted ascending, that's
    // (r1,r2)=1+2=3, (r3,r4)=3+4=7, (r5,r6)=5+6=11, r7 pending → combined=[3,7,11]. Fed in the
    // OPPOSITE order (as this fake's listLines returns them), the pairing itself changes — not
    // merely its order — to (r7,r6)=7+6=13, (r5,r4)=5+4=9, (r3,r2)=3+2=5, r1 pending →
    // combined=[13,9,5]. A wrong implementation that skips the sort produces a DIFFERENT index
    // value from this, not the same value in a different position.
    const chronological = [
      nineHoleLine("r1", 1_000, 1),
      nineHoleLine("r2", 2_000, 2),
      nineHoleLine("r3", 3_000, 3),
      nineHoleLine("r4", 4_000, 4),
      nineHoleLine("r5", 5_000, 5),
      nineHoleLine("r6", 6_000, 6),
      nineHoleLine("r7", 7_000, 7),
    ];
    const reversed = [...chronological].reverse();

    let putIndexCall: { value: number; computedAtMs: number; differentialsUsed: number } | undefined;
    const outOfOrderStore: ProjectionStore = {
      putLine: async () => {},
      listLines: async () => reversed,
      putIndex: async (_golferId, snapshot) => {
        putIndexCall = snapshot;
      },
      getIndex: async () => undefined,
      putLive: async () => {},
      deleteLive: async () => {},
      listLive: async () => [],
    };

    const project = projectArchive({ projectionStore: outOfOrderStore, clock: createFrozenClock(9_000), logger: createNullLogger() });
    // The archive's own line (18-hole, from archiveAt) is irrelevant to this assertion — the
    // fake's listLines ignores whatever putLine received and always returns `reversed` — so
    // this call exists purely to trigger the fold over the 7 lines above.
    await project(archiveAt("r7", 7_000, [{ golferId: ann, differential: 7 }]));

    expect(putIndexCall).toBeDefined();
    expect(putIndexCall?.value).toEqual(computeIndex([3, 7, 11]));
    expect(putIndexCall?.differentialsUsed).toBe(1);
  });
});

// The M8 crew season ledger projector extension is GONE (architecture-realignment Task 9): a
// finalized round no longer feeds any crew keyspace. Crew standings are computed on read over
// the snapshots table (crews/getSeasonStandings) and covered by its own slice tests; the
// projector is a golfer-record-only fold now.
