import { describe, expect, it } from "vitest";
import { cellKey, deviceId, fixtureLinks, fixtureLinks18, golferId, golferMetrics, opId, playGoldenRoundLog, roundId, settleRound } from "@swng/domain";
import type { GolferId, Participant, RoundArchive, RoundEvent, RosterEntry, ScoreCell } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import { getMyRecord } from "../golfers/getMyRecord.js";
import { createInMemoryGolferStore, createInMemoryProjectionStore, createNullLogger, putAndBindGolfer } from "../testing/fakes.js";
import { finalizedAtMsOf, projectArchive, sortLines } from "./projectArchive.js";

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

// A minimal, hand-built finalized archive. `perHole` is the ONLY scoring input: given, it fills
// every one of the card's 18 holes with that stroke count for that golfer, so the projected line
// carries a real `score` (18 x perHole against fixtureLinks18's par 72 — spec 2026-07-29 §2d's
// hasCompleteScore). Omitted, the golfer's card is empty and the line honestly carries no score at
// all, which is how the "never bootstraps" cases below are built. Always 18 holes (fixtureLinks18).
type ArchiveEntry = { golferId: GolferId; perHole?: number };

const cellsFor = (id: string, entries: readonly ArchiveEntry[]): Record<string, ScoreCell> =>
  Object.fromEntries(
    entries.flatMap((e) =>
      e.perHole === undefined
        ? []
        : fixtureLinks18.teeSets[0]!.holes.map((hole) => [
            cellKey(e.golferId, hole.number),
            {
              result: { kind: "strokes" as const, strokes: e.perHole! },
              recordedBy: e.golferId,
              hlc: { wallMs: 1, counter: hole.number, deviceId: deviceId("server") },
              opId: opId(`score-${id}-${e.golferId}-${hole.number}`),
            } satisfies ScoreCell,
          ]),
    ),
  );

const archiveAt = (id: string, wallMs: number, entries: readonly ArchiveEntry[]): RoundArchive => ({
  roundId: roundId(id),
  card: fixtureLinks18,
  participants: entries.map((e): RosterEntry => ({ golferId: e.golferId, name: e.golferId, tee: "white", strokes: 0 })),
  games: [],
  cells: cellsFor(id, entries),
  // A real archive's log always opens with round-created (its genesis) — carried here so
  // createdAtMsOf (accounts-only identity spec §5) resolves; its wall time (1) is arbitrary,
  // no test below asserts it, only its PRESENCE matters. One participant-joined event per
  // entry is carried too (PC-T1/papercut 11): presence-cleanup reads the ever-seated roster
  // off THESE events, never off archive.participants, so any test that seeds a LIVE pointer
  // and expects it cleared needs one here for its golferId.
  events: [
    // playedAtMs (spec 2026-08-01 §3a): arbitrary here (1, matching the event's own arbitrary
    // wallMs) — no test in this file cares about its VALUE except the dedicated "stamps the
    // line's playedAtMs" case below, which appends its own round-played-at-set correction on top
    // of this genesis rather than editing it.
    { kind: "round-created", roundId: roundId(id), card: fixtureLinks18, playedAtMs: 1, opId: opId(`created-${id}`), hlc: { wallMs: 1, counter: 0, deviceId: deviceId("server") }, authorId: ann },
    ...entries.map(
      (e, i): RoundEvent => ({
        kind: "participant-joined",
        participant: { golferId: e.golferId, name: e.golferId, tee: "white", strokes: 0 },
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
    const archive = archiveAt("r1", 4_242, [{ golferId: ann, perHole: 5 }]);
    expect(finalizedAtMsOf(archive)).toBe(4_242);
  });

  it("throws for a settled archive with no round-finalized event — corrupt by construction", () => {
    const corrupt: RoundArchive = { ...archiveAt("r1", 1_000, [{ golferId: ann }]), events: [] };
    expect(() => finalizedAtMsOf(corrupt)).toThrow();
  });
});

describe("sortLines", () => {
  // Ordering is by WHEN THE ROUND WAS PLAYED (spec 2026-08-01 §4), not when it was finalized —
  // this test FAILS on the pre-arc implementation (sorted by finalizedAtMs), which is the point:
  // the finalizedAtMs ordering only ever looked right because you finalize the round you just
  // played, and a back-dated round would sort to the top of a history that is supposed to be a
  // chronology of golf. A played EARLIER but finalized LATER; B played LATER but finalized
  // FIRST — a finalizedAtMs sort would return [B, A], the wrong order for a "when did you play
  // this" history.
  it("sorts by playedAtMs, not finalizedAtMs", () => {
    const a = { roundId: roundId("a"), playedAtMs: 1_000, finalizedAtMs: 9_000 };
    const b = { roundId: roundId("b"), playedAtMs: 5_000, finalizedAtMs: 2_000 };
    expect(sortLines([b, a])).toEqual([a, b]);
    expect(sortLines([a, b])).toEqual([a, b]);
  });

  // Fix wave (Important 1): the test above proves played is not FINALIZED — and nothing more. Both
  // its fixtures happen to sit in ascending roundId order too, so a comparator that ignored
  // `playedAtMs` outright and ranked on the roundId tiebreak ALONE passed it (proven: replacing the
  // comparator with `roundId`-only left the whole package green at 227). Here the played order is
  // the REVERSE of both the roundId order and the finalizedAtMs order, so all three candidate keys
  // give three different answers and only the played one gives this one. If this regresses, every
  // golfer's rolling average, bests, milestones and chart order silently reorder.
  it("sorts by playedAtMs — neither the roundId tiebreak nor finalizedAtMs can stand in for it", () => {
    const zulu = { roundId: roundId("z-round"), playedAtMs: 1_000, finalizedAtMs: 9_000 };
    const alpha = { roundId: roundId("a-round"), playedAtMs: 5_000, finalizedAtMs: 2_000 };
    expect(sortLines([alpha, zulu])).toEqual([zulu, alpha]);
    expect(sortLines([zulu, alpha])).toEqual([zulu, alpha]);
  });

  it("still tiebreaks on roundId for a same-playedAtMs pair", () => {
    const a = { roundId: roundId("a"), playedAtMs: 1_000, finalizedAtMs: 1_000 };
    const b = { roundId: roundId("b"), playedAtMs: 1_000, finalizedAtMs: 1_000 };
    expect(sortLines([b, a])).toEqual([a, b]);
  });
});

describe("projectArchive", () => {
  // The handicap index is NOT this projector's concern anymore (pre-prod hardening D4a): it's
  // computed at read time in golfers/getMyRecord.ts from these same lines. projectArchive's
  // whole write surface here is the line upsert — there is no getIndex to even ask.
  it("writes one history line per participant", async () => {
    const ctx = await setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }]);
    const project = projectArchive(ctx);

    await project(archive);

    const history = await ctx.projectionStore.listLines(ann);
    expect(history).toHaveLength(1);
    // The line records what the round said about this golfer: the strokes they played off and the
    // round's own gross (18 x 5 on fixtureLinks18's par 72).
    expect(history[0]).toMatchObject({ roundId: roundId("r1"), strokes: 0, score: 90, finalizedAtMs: 1_000 });
  });

  // playedAtMs (spec 2026-08-01 §4a): the projector stamps every line with the round's played
  // instant via the ONE shared rule (domain's playedAtMsOf), never re-derived here. A correction
  // (round-played-at-set) riding the log after genesis must win over the genesis event's own
  // playedAtMs — exactly the fold rule playedAt.ts itself pins, proven here through the projector
  // rather than the domain function directly.
  it("stamps the line's playedAtMs from a log carrying a round-played-at-set", async () => {
    const ctx = await setup();
    const base = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }]);
    const correction: RoundEvent = {
      kind: "round-played-at-set",
      playedAtMs: 500_000,
      opId: opId("played-at-r1"),
      hlc: { wallMs: 2, counter: 0, deviceId: deviceId("server") },
      authorId: ann,
    };
    const archive: RoundArchive = { ...base, events: [...base.events, correction] };
    const project = projectArchive(ctx);

    await project(archive);

    const history = await ctx.projectionStore.listLines(ann);
    // Genesis carried playedAtMs: 1 (archiveAt's own fixed value) — the correction's 500_000
    // must win, not the genesis value and not the round-finalized wallMs (1_000).
    expect(history[0]?.playedAtMs).toBe(500_000);
  });

  // The read-side pin runs the SAME two steps a real request does: project finalizes (the
  // projector's only job — line upserts, no derived number written at all), then read getMyRecord
  // and check its average against the domain fold over the very lines the projector wrote. There
  // is no bootstrap to cross anymore (spec 2026-07-29 §7): ONE scored round is already an average.
  it("the average moves with each projected round, computed at read time from the lines themselves", async () => {
    const ctx = await setup();
    const project = projectArchive(ctx);
    const record = getMyRecord({ golferStore: ctx.golferStore, projectionStore: ctx.projectionStore });

    await project(archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }])); // 90 on par 72 -> +18
    expect((await record({ sub: "sub-ann" })).metrics.average).toBe(18);

    await project(archiveAt("r2", 2_000, [{ golferId: ann, perHole: 6 }])); // 108 -> +36; mean 27
    expect((await record({ sub: "sub-ann" })).metrics.average).toBe(27);

    await project(archiveAt("r3", 3_000, [{ golferId: ann, perHole: 5 }])); // +18; mean 72/3 = 24
    const { metrics } = await record({ sub: "sub-ann" });
    expect(metrics.average).toBe(24);
    // ...and it agrees with the domain fold over the projector's OWN stored lines, so neither side
    // can drift into a second implementation.
    const stored = [...(await ctx.projectionStore.listLines(ann))].sort((a, b) => a.finalizedAtMs - b.finalizedAtMs);
    expect(metrics.average).toBe(golferMetrics(stored).average);
  });

  it("is idempotent: re-putting the same history line doesn't duplicate it", async () => {
    const ctx = await setup();
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }]);
    const project = projectArchive(ctx);

    await project(archive);
    await project(archive);

    const history = await ctx.projectionStore.listLines(ann);
    expect(history).toHaveLength(1);
  });

  it("is idempotent across the bootstrap boundary: re-projecting the last archive leaves listLines unchanged", async () => {
    const ctx = await setup();
    const project = projectArchive(ctx);
    const third = archiveAt("r3", 3_000, [{ golferId: ann, perHole: 5 }]);

    await project(archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, perHole: 5 }]));
    await project(third);
    const historyBefore = await ctx.projectionStore.listLines(ann);

    await project(third); // the exact same archive, again

    expect(await ctx.projectionStore.listLines(ann)).toEqual(historyBefore);
  });

  it("tracks each participant's history independently; a golfer who never posts a score never gets an average", async () => {
    const ctx = await setup();
    const project = projectArchive(ctx);
    const record = getMyRecord({ golferStore: ctx.golferStore, projectionStore: ctx.projectionStore });

    await project(archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }, { golferId: bo }]));
    await project(archiveAt("r2", 2_000, [{ golferId: ann, perHole: 5 }, { golferId: bo }]));
    await project(archiveAt("r3", 3_000, [{ golferId: ann, perHole: 5 }, { golferId: bo }]));

    expect((await record({ sub: "sub-ann" })).metrics.average).toBe(18);
    expect(await ctx.projectionStore.listLines(bo)).toHaveLength(3); // Bo's rounds are all on file...
    expect((await record({ sub: "sub-bo" })).metrics.average).toBeUndefined(); // ...but none of them carries a score
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
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }, { golferId: bo }]);
    await ctx.projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500 });
    await ctx.projectionStore.putLive(bo, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 600 });
    // A DIFFERENT round's presence for ann must survive untouched.
    await ctx.projectionStore.putLive(ann, { roundId: roundId("other-round"), courseName: "Pebble Municipal", joinedAtMs: 100 });
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
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }]);
    await ctx.projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500 });
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
    await golferStore.put({ id: bo, name: "Bo Ghost" }, undefined); // sub-less row
    // Pre-existing presence for the ghost — presence-cleanup clears it regardless of account status.
    await projectionStore.putLive(bo, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 600 });

    const archive = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }, { golferId: bo, perHole: 5 }]);
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
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }, { golferId: bo, perHole: 5 }]);
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
    await projectionStore.putLive(ann, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 500 });
    const archive = archiveAt("r1", 1_000, [{ golferId: ann, perHole: 5 }]);
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
    const annP: Participant = { golferId: ann, name: "Ann", tee: "white", strokes: 0 };
    const boP: Participant = { golferId: bo, name: "Bo", tee: "white", strokes: 0 };
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

    await ctx.projectionStore.putLive(bo, { roundId: archive.roundId, courseName: "Fixture Links", joinedAtMs: 500 });
    await ctx.projectionStore.putLive(ann, { roundId: archive.roundId, courseName: "Fixture Links", joinedAtMs: 500 });
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
