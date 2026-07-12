import { describe, expect, it } from "vitest";
import { computeIndex, crewId, deviceId, fixtureLinks18, gameId, golferId, opId, roundId } from "@swng/domain";
import type { CrewId, GolferId, GolferRoundLine, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { createFrozenClock, createInMemoryProjectionStore, createNullLogger } from "../testing/fakes.js";
import { finalizedAtMsOf, projectArchive, seasonOf } from "./projectArchive.js";
import type { ArchiveSource } from "./rebuildProjections.js";
import { rebuildProjections } from "./rebuildProjections.js";

const ann = golferId("ann");
const bo = golferId("bo");
const cal = golferId("cal");

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

// A crew-tagged, singles-match-decided archive — the smallest game shape crewContribution
// (domain/crew/ledger.ts) actually produces a ledger line + a head-to-head entry from, so
// the projector's crew arm has something non-empty to upsert/recompute. `winner` must be
// one of `a`/`b`.
const crewArchiveAt = (id: string, wallMs: number, crew: CrewId, a: GolferId, b: GolferId, winner: GolferId): RoundArchive => {
  const singlesId = gameId(`singles-${id}`);
  return {
    roundId: roundId(id),
    crewId: crew,
    card: fixtureLinks18,
    participants: [a, b].map((g): Participant => ({ golferId: g, name: g, tee: "white", courseHandicap: 8 })),
    games: [{ kind: "singles-match", id: singlesId, a, b }],
    cells: {},
    events: [finalizedEvent(wallMs)],
    results: [{ kind: "singles-match", id: singlesId, outcome: { winner, closing: "3&2" }, thru: 16 }],
    terminatedGameIds: [],
    handicapping: [],
  };
};

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
      wipeGolfer: async () => {},
      putCrewRound: async () => {},
      listCrewRounds: async () => [],
      putSeasonRecords: async () => {},
      getSeasonRecords: async () => undefined,
      wipeCrew: async () => {},
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
    await rebuiltStore.putLine(ann, {
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
    expect(await rebuiltStore.listLines(ann)).toEqual(await incrementalStore.listLines(ann));
    expect(await rebuiltStore.getIndex(ann)).toEqual(await incrementalStore.getIndex(ann));
    // The stale line is gone, not merely joined by the 3 real ones.
    expect((await rebuiltStore.listLines(ann)).some((line) => line.roundId === roundId("stale-round"))).toBe(false);
  });

  it("wipes and replays every golfer touched across the archive set, independently", async () => {
    const archives = [archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo, differential: 20.0 }])];
    const store = createInMemoryProjectionStore();

    const rebuild = rebuildProjections({ archiveSource: createArchiveSource(archives), projectionStore: store, clock: createFrozenClock(9_000), logger: createNullLogger() });
    const summary = await rebuild();

    expect(summary).toEqual({ rounds: 1, golfers: 2 });
    expect(await store.listLines(ann)).toHaveLength(1);
    expect(await store.listLines(bo)).toHaveLength(1);
  });
});

// M8: the season ledger projector extension — a crew-tagged archive additionally feeds
// putCrewRound → listCrewRounds → aggregateSeason → putSeasonRecords (projectArchive.ts).
describe("projectArchive — the crew season ledger extension (M8)", () => {
  it("an UNTAGGED archive (no crewId) never touches the crew projections", async () => {
    const ctx = setup();
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });
    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]));

    expect(await ctx.projectionStore.getSeasonRecords(crewId("crew-1"), seasonOf(1_000))).toBeUndefined();
  });

  it("a crew-tagged archive upserts the round's contribution and recomputes the whole season's ledger + head-to-head", async () => {
    const ctx = setup();
    const crew = crewId("crew-1");
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(crewArchiveAt("r1", 1_000, crew, ann, bo, ann)); // Ann beats Bo
    const season = seasonOf(1_000);

    const records = await ctx.projectionStore.getSeasonRecords(crew, season);
    expect(records?.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ golferId: ann, wins: 1, losses: 0 }),
        expect.objectContaining({ golferId: bo, wins: 0, losses: 1 }),
      ]),
    );
    expect(records?.headToHead).toHaveLength(1);
  });

  it("is idempotent by construction: projecting the SAME crew archive twice reproduces identical season records (upsert-then-recompute, never `+=`)", async () => {
    const ctx = setup();
    const crew = crewId("crew-1");
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });
    const archive = crewArchiveAt("r1", 1_000, crew, ann, bo, ann);

    await project(archive);
    const once = await ctx.projectionStore.getSeasonRecords(crew, seasonOf(1_000));
    await project(archive); // the exact same archive, again
    const twice = await ctx.projectionStore.getSeasonRecords(crew, seasonOf(1_000));

    expect(twice).toEqual(once);
    // Not doubled — the win count from a SECOND projection of the SAME round is still 1, not 2.
    expect(twice?.ledger.find((line) => line.golferId === ann)?.wins).toBe(1);
  });

  it("accumulates correctly across TWO DIFFERENT rounds in the same season — ledger sums, not overwrites", async () => {
    const ctx = setup();
    const crew = crewId("crew-1");
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(crewArchiveAt("r1", 1_000, crew, ann, bo, ann)); // Ann beats Bo
    await project(crewArchiveAt("r2", 2_000, crew, ann, bo, bo)); // Bo beats Ann

    const records = await ctx.projectionStore.getSeasonRecords(crew, seasonOf(1_000));
    expect(records?.ledger).toEqual(
      expect.arrayContaining([expect.objectContaining({ golferId: ann, wins: 1, losses: 1 }), expect.objectContaining({ golferId: bo, wins: 1, losses: 1 })]),
    );
    expect(records?.headToHead).toEqual([expect.objectContaining({ aWins: 1, bWins: 1, halves: 0 })]);
  });

  it("keeps two different crews' season records independent", async () => {
    const ctx = setup();
    const crewA = crewId("crew-a");
    const crewB = crewId("crew-b");
    const project = projectArchive({ ...ctx, clock: createFrozenClock(5_000) });

    await project(crewArchiveAt("r1", 1_000, crewA, ann, bo, ann));
    await project(crewArchiveAt("r2", 2_000, crewB, ann, cal, cal));

    const recordsA = await ctx.projectionStore.getSeasonRecords(crewA, seasonOf(1_000));
    const recordsB = await ctx.projectionStore.getSeasonRecords(crewB, seasonOf(2_000));
    expect(recordsA?.ledger.map((l) => l.golferId).sort()).toEqual([ann, bo].sort());
    expect(recordsB?.ledger.map((l) => l.golferId).sort()).toEqual([ann, cal].sort());
  });
});

describe("rebuildProjections — the crew season ledger extension (M8)", () => {
  it("rebuild-equals-incremental for a crew's season ledger, and wipes a stale season's records first (mirrors the golfer-history test construction above)", async () => {
    const crew = crewId("crew-1");
    const archives = [crewArchiveAt("r1", 1_000, crew, ann, bo, ann), crewArchiveAt("r2", 2_000, crew, ann, bo, bo)];
    const season = seasonOf(1_000);

    // Path A: the "live" incremental build.
    const incrementalStore = createInMemoryProjectionStore();
    const incrementalProject = projectArchive({ projectionStore: incrementalStore, clock: createFrozenClock(9_000), logger: createNullLogger() });
    for (const archive of archives) await incrementalProject(archive);

    // Path B: rebuildProjections, unsorted input, pre-seeded with a stray ROUND CONTRIBUTION
    // (not just a stale season record — putSeasonRecords is already a full replace every
    // projectArchive call, so seeding one there proves nothing about wipeCrew specifically;
    // putCrewRound's map is what actually needs wiping, since listCrewRounds would otherwise
    // keep returning this stale entry forever, folded into every future recompute) from a
    // round that no longer belongs to this replay — proving the wipe-first step, not just an
    // upsert-over (same construction as the golfer-history rebuild test above, which seeds a
    // stale putLine for the identical reason).
    const rebuiltStore = createInMemoryProjectionStore();
    await rebuiltStore.putCrewRound(crew, season, {
      roundId: roundId("stale-round"),
      lines: [{ golferId: golferId("ghost-of-a-stale-round"), wins: 1, losses: 0, halves: 0, points: 0, skins: 0 }],
      headToHead: [],
      finalizedAtMs: 500,
    });

    const rebuild = rebuildProjections({
      archiveSource: createArchiveSource([archives[1]!, archives[0]!]),
      projectionStore: rebuiltStore,
      clock: createFrozenClock(9_000),
      logger: createNullLogger(),
    });
    await rebuild();

    expect(await rebuiltStore.getSeasonRecords(crew, season)).toEqual(await incrementalStore.getSeasonRecords(crew, season));
    // The stale contribution is gone, not merely joined by the 2 real ones.
    const rebuiltLedger = await rebuiltStore.getSeasonRecords(crew, season);
    expect(rebuiltLedger?.ledger.some((line) => line.golferId === golferId("ghost-of-a-stale-round"))).toBe(false);
    expect((await rebuiltStore.listCrewRounds(crew, season)).some((round) => round.roundId === roundId("stale-round"))).toBe(false);
  });

  it("wipes and replays every (crew, season) touched across the archive set, independently — including two seasons for the SAME crew", async () => {
    const crew = crewId("crew-1");
    // wallMs values chosen to land in different UTC years, so this exercises TWO separate
    // season buckets for one crew, not just two crews.
    const earlySeasonMs = Date.UTC(2024, 0, 1);
    const laterSeasonMs = Date.UTC(2025, 0, 1);
    const archives = [crewArchiveAt("r1", earlySeasonMs, crew, ann, bo, ann), crewArchiveAt("r2", laterSeasonMs, crew, ann, bo, bo)];
    const store = createInMemoryProjectionStore();

    const rebuild = rebuildProjections({ archiveSource: createArchiveSource(archives), projectionStore: store, clock: createFrozenClock(9_000), logger: createNullLogger() });
    await rebuild();

    const early = await store.getSeasonRecords(crew, seasonOf(earlySeasonMs));
    const later = await store.getSeasonRecords(crew, seasonOf(laterSeasonMs));
    expect(early?.ledger.find((l) => l.golferId === ann)?.wins).toBe(1);
    expect(early?.ledger.find((l) => l.golferId === ann)?.losses).toBe(0);
    expect(later?.ledger.find((l) => l.golferId === ann)?.wins).toBe(0);
    expect(later?.ledger.find((l) => l.golferId === ann)?.losses).toBe(1);
  });
});
