import { describe, expect, it } from "vitest";
import { computeIndex, deviceId, fixtureLinks, fixtureLinks18, golferId, opId, playGoldenRoundLog, roundId, settleRound } from "@swng/domain";
import type { GolferId, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import { getMyRecord } from "../golfers/getMyRecord.js";
import { createFrozenClock, createInMemoryGolferStore, createInMemoryProjectionStore, createNullLogger, putAndBindGolfer } from "../testing/fakes.js";
import { finalizedAtMsOf, projectArchive } from "./projectArchive.js";

const ann = golferId("ann");
const bo = golferId("bo");

// Accounts-only identity (spec §7): the projector projects ONLY account-bound golfers (a golfer
// row carrying a sub). Seeds a set of golferIds as account golfers on one shared store — the
// common case where a test wants all of an archive's participants projected; a sub-less golfer
// (or one with no row at all) is deliberately skipped by the projector.
const accountsFor = async (...ids: GolferId[]): Promise<GolferStore> => {
  const golferStore = createInMemoryGolferStore();
  for (const id of ids) await putAndBindGolfer(golferStore, id, `sub-${id}`, `${id}`);
  return golferStore;
};

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
  // no test below asserts it, only its PRESENCE matters. One participant-joined event per
  // entry is carried too (PC-T1/papercut 11): presence-cleanup reads the ever-seated roster
  // off THESE events, never off archive.participants, so any test that seeds a LIVE pointer
  // and expects it cleared needs one here for its golferId.
  events: [
    { kind: "round-created", roundId: roundId(id), card: fixtureLinks18, opId: opId(`created-${id}`), hlc: { wallMs: 1, counter: 0, deviceId: deviceId("server") }, authorId: ann },
    ...entries.map(
      (e, i): RoundEvent => ({
        kind: "participant-joined",
        participant: { golferId: e.golferId, name: e.golferId, tee: "white", courseHandicap: 8 },
        opId: opId(`joined-${id}-${e.golferId}`),
        hlc: { wallMs: 1, counter: i + 1, deviceId: deviceId("server") },
        authorId: e.golferId,
      }),
    ),
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

// Seeds ann + bo as account golfers by default — the participants every projectArchive test below
// uses — so the account-bound filter (spec §7) lets them through. Tests that assert the SKIP path
// (a sub-less golfer) seed their own store instead.
const setup = async () => ({
  projectionStore: createInMemoryProjectionStore(),
  golferStore: await accountsFor(ann, bo),
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
  // The handicap index is NOT this projector's concern anymore (pre-prod hardening D4a): it's
  // computed at read time in golfers/getMyRecord.ts from these same lines. projectArchive's
  // whole write surface here is the line upsert — there is no getIndex to even ask.
  it("writes one history line per participant", async () => {
    const ctx = await setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]);
    const project = projectArchive(ctx);

    await project(archive);

    const history = await ctx.projectionStore.listLines(ann);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ roundId: roundId("r1"), differential: 9.0, finalizedAtMs: 1_000 });
  });

  // The bootstrap-crossing pin now runs the SAME two steps a real request does: project three
  // finalizes (the projector's only job — line upserts, no index write at all), then read
  // getMyRecord and check its wire index against the domain fold oracle directly — proving the
  // two functions agree, not just that some store round-trips a value.
  it("crosses the bootstrap on the 3rd differential; differentialsUsed is the WHS use-count, not the window size", async () => {
    const ctx = await setup();
    const project = projectArchive(ctx);
    const record = getMyRecord({ golferStore: ctx.golferStore, projectionStore: ctx.projectionStore, clock: createFrozenClock(5_000) });

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]));
    expect((await record({ sub: "sub-ann" })).metrics.whsIndex).toBeUndefined();

    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]));
    expect((await record({ sub: "sub-ann" })).metrics.whsIndex).toBeUndefined();

    await project(archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]));
    const { metrics } = await record({ sub: "sub-ann" });
    // 3 differentials available → Rule 5.2a uses only the lowest 1 (whs.test.ts's
    // computeIndexDetail pin), not 3. computedAtMs is the READ-time clock (D4a), never a
    // stored snapshot's.
    expect(metrics.whsIndex).toEqual({ value: computeIndex([9.0, 10.0, 11.0]), computedAtMs: 5_000, differentialsUsed: 1 });
  });

  it("is idempotent: re-putting the same history line doesn't duplicate it", async () => {
    const ctx = await setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]);
    const project = projectArchive(ctx);

    await project(archive);
    await project(archive);

    const history = await ctx.projectionStore.listLines(ann);
    expect(history).toHaveLength(1);
  });

  it("is idempotent across the bootstrap boundary: re-projecting the last archive leaves listLines unchanged", async () => {
    const ctx = await setup();
    const project = projectArchive(ctx);
    const third = archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }]);

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }]));
    await project(third);
    const historyBefore = await ctx.projectionStore.listLines(ann);

    await project(third); // the exact same archive, again

    expect(await ctx.projectionStore.listLines(ann)).toEqual(historyBefore);
  });

  it("tracks each participant's history independently; an always-incomplete golfer's wire index never bootstraps", async () => {
    const ctx = await setup();
    const project = projectArchive(ctx);
    const record = getMyRecord({ golferStore: ctx.golferStore, projectionStore: ctx.projectionStore, clock: createFrozenClock(5_000) });

    await project(archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, differential: 10.0 }, { golferId: bo }]));
    await project(archiveAt("r3", 3_000, [{ golferId: ann, differential: 11.0 }, { golferId: bo }]));

    expect((await record({ sub: "sub-ann" })).metrics.whsIndex).toBeDefined();
    expect(await ctx.projectionStore.listLines(bo)).toHaveLength(3);
    expect((await record({ sub: "sub-bo" })).metrics.whsIndex).toBeUndefined(); // incomplete every round — never a differential to combine
  });

  it("throws for a settled archive with no round-finalized event", async () => {
    const ctx = await setup();
    const corrupt: RoundArchive = { ...archiveAt("r1", 1_000, [{ golferId: ann }]), events: [] };
    const project = projectArchive(ctx);
    await expect(project(corrupt)).rejects.toThrow();
  });

  // Presence cleanup (projection-realignment spec §5, Task 13; decoupled from lines/index
  // projection policy by PC-T1/papercut 11): a LIVE pointer is written at seat-time for every
  // golferId that ever appears in a participant-joined event (rounds/presence.ts) — cleared
  // here over that ever-seated roster, not archive.participants (the two coincide in THIS
  // archive; the settle-omitted-departure test below is where they diverge) — this is the
  // PRIMARY removal path (TTL is only a backstop for a round that never finalizes).
  it("deletes the LIVE pointer for every participant on the archive", async () => {
    const ctx = await setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo }]);
    await ctx.projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500, expiresAtSec: 9_999_999_999 });
    await ctx.projectionStore.putLive(bo, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 600, expiresAtSec: 9_999_999_999 });
    // A DIFFERENT round's presence for ann must survive untouched.
    await ctx.projectionStore.putLive(ann, { roundId: roundId("other-round"), courseName: "Pebble Municipal", joinedAtMs: 100, expiresAtSec: 9_999_999_999 });
    const project = projectArchive(ctx);

    await project(archive);

    expect(await ctx.projectionStore.listLive(ann)).toEqual([{ roundId: roundId("other-round"), courseName: "Pebble Municipal", joinedAtMs: 100 }]);
    expect(await ctx.projectionStore.listLive(bo)).toEqual([]);
  });

  // Idempotence, same discipline as putLine's own re-projection pin above: a re-projection of
  // an already-projected archive (the stream trigger's own at-least-once delivery, or a
  // rebuild replay) calls deleteLive on a pointer that's already gone — never an error.
  it("re-projecting the same archive a second time is a no-op for presence, not an error", async () => {
    const ctx = await setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]);
    await ctx.projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500, expiresAtSec: 9_999_999_999 });
    const project = projectArchive(ctx);

    await project(archive);
    await expect(project(archive)).resolves.toBeUndefined();

    expect(await ctx.projectionStore.listLive(ann)).toEqual([]);
  });

  // Accounts-only identity (spec §7): only account golfers get a history line. A participant
  // whose golfer record has NO bound sub (a ghost from old data) gets none. But presence-cleanup
  // is NOT projection policy (PC-T1/papercut 11): it runs over every golferId that ever seated
  // the round (the events' own participant-joined roster), unconditionally — so the ghost's
  // LIVE# pointer clears exactly like an account golfer's, even though the ghost itself is
  // invisible to lines. (This pin used to assert the opposite — "no presence clear" — before
  // PC-T1 decoupled the two; the no-line half is unchanged.)
  it("skips a participant whose golfer record is sub-less (a ghost) for lines — but presence clears for every ever-seated golferId, sub or not", async () => {
    const projectionStore = createInMemoryProjectionStore();
    const logger = createNullLogger();
    // ann is a real account; bo has a golfer row but NO sub (still a ghost).
    const golferStore = await accountsFor(ann);
    await golferStore.put({ id: bo, name: "Bo Ghost", handicap: {} }, undefined); // sub-less row
    // Pre-existing presence for the ghost — presence-cleanup clears it regardless of account status.
    await projectionStore.putLive(bo, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 600, expiresAtSec: 9_999_999_999 });

    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo, differential: 12.0 }]);
    const project = projectArchive({ projectionStore, golferStore, logger });
    await project(archive);

    // ann (account) is projected; bo (sub-less ghost) is entirely skipped for lines.
    expect(await projectionStore.listLines(ann)).toHaveLength(1);
    expect(await projectionStore.listLines(bo)).toHaveLength(0);
    // But bo DID seat this round (archiveAt gives every entry its own participant-joined event)
    // — presence-cleanup runs over that ever-seated roster, so bo's pointer is gone too.
    expect(await projectionStore.listLive(bo)).toEqual([]);
  });

  // A participant with NO golfer row at all (possible for an old ghost id) is likewise skipped —
  // never throwing (getMany simply omits it), same "not account-bound" outcome as a sub-less row.
  it("skips a participant with no golfer row at all — never throws", async () => {
    const projectionStore = createInMemoryProjectionStore();
    const golferStore = await accountsFor(ann); // bo has no row whatsoever
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }, { golferId: bo, differential: 12.0 }]);
    const project = projectArchive({ projectionStore, golferStore, logger: createNullLogger() });

    await expect(project(archive)).resolves.toBeUndefined();
    expect(await projectionStore.listLines(ann)).toHaveLength(1);
    expect(await projectionStore.listLines(bo)).toHaveLength(0);
  });

  // And the account golfer's own presence IS cleared too (the complement of the skip above) —
  // presence-cleanup (PC-T1) clears for every ever-seated golferId regardless of account status,
  // so an account golfer's own pointer is included in that set, not carved out of it.
  it("clears presence for the account golfer it projected", async () => {
    const projectionStore = createInMemoryProjectionStore();
    const golferStore = await accountsFor(ann);
    await projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500, expiresAtSec: 9_999_999_999 });
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, differential: 9.0 }]);
    const project = projectArchive({ projectionStore, golferStore, logger: createNullLogger() });

    await project(archive);

    expect(await projectionStore.listLive(ann)).toEqual([]);
  });

  // Papercut 11 (PC-T1): presence-cleanup is identity housekeeping, not projection policy — it
  // must run over the EVER-SEATED roster (every golferId a participant-joined event ever named),
  // never over the settled archive's own participants. settleRound's departure rule (domain's
  // round/archive.test.ts "OMITS a departed participant...") drops a departed participant
  // entirely from archive.participants when they scored nothing and joined no game — this deck
  // reproduces exactly that via the real settleRound, not a hand-built archive, because the bug
  // this test pins is specifically about the gap between "ever seated" and "settled".
  it("clears the LIVE# pointer of a settle-omitted departed participant — presence cleanup runs over the ever-seated roster, not the settled archive", async () => {
    const ctx = await setup();
    const annP: Participant = { golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 };
    const boP: Participant = { golferId: bo, name: "Bo", tee: "white", courseHandicap: 10 };
    const annNine = [5, 5, 4, 6, 5, 4, 5, 6, 4];
    const leaveBo: RoundEvent = { kind: "participant-left", golferId: bo, opId: opId("leave-bo"), hlc: { wallMs: 5_000, counter: 0, deviceId: deviceId("test") }, authorId: bo };
    const finalize: RoundEvent = { kind: "round-finalized", opId: opId("finalize-omit"), hlc: { wallMs: 6_000, counter: 0, deviceId: deviceId("test") }, authorId: ann };
    const archive = settleRound([
      // Bo joins, is in no game, records no scores, then leaves; Ann plays the card and the
      // round finalizes — the exact shape settleRound's empty-case departure rule omits.
      ...playGoldenRoundLog(fixtureLinks, [annP, boP], [], { [ann]: annNine, [bo]: [] }, [], false),
      leaveBo,
      finalize,
    ]);
    // Precondition: settleRound really did omit Bo — nothing to settle for a departed
    // participant with zero scored holes and zero game membership.
    expect(archive.participants.some((p) => p.golferId === bo)).toBe(false);

    await ctx.projectionStore.putLive(bo, { roundId: archive.roundId, courseName: "Fixture Links", joinedAtMs: 500, expiresAtSec: 9_999_999_999 });
    await ctx.projectionStore.putLive(ann, { roundId: archive.roundId, courseName: "Fixture Links", joinedAtMs: 500, expiresAtSec: 9_999_999_999 });
    const project = projectArchive(ctx);

    await project(archive);

    // Bo's pointer is gone even though Bo is not in the archive:
    expect(await ctx.projectionStore.listLive(bo)).toEqual([]);
    // And Ann's normal projection is untouched by the change:
    expect(await ctx.projectionStore.listLines(ann)).toHaveLength(1);
  });
});

// The "sorts listLines before folding" pin that used to live here moved WITH the fold itself
// (pre-prod hardening D4a): projectArchive no longer folds an index at all, so there is nothing
// left in this file to prove order-sensitivity about. The replacement pin — an out-of-order
// ProjectionStore fake proving the SAME combineNineHoleDifferentials mispairing risk — now lives
// in golfers/golferSlice.test.ts, right beside getMyRecord's own fold.

// The M8 crew season ledger projector extension is GONE (architecture-realignment Task 9): a
// finalized round no longer feeds any crew keyspace. Crew standings are computed on read over
// the snapshots table (crews/getSeasonStandings) and covered by its own slice tests; the
// projector is a golfer-record-only fold now.
