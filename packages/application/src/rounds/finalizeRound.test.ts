import { describe, expect, it } from "vitest";
import type { OpId, RoundEvent } from "@swng/domain";
import { cardId, courseId, deviceId, fixtureLinks, opId, reduceRound, settleRound } from "@swng/domain";
import type { AppendOptions, AppendResult, EventJournal } from "../ports/eventJournal.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createCapturingBroadcast,
  createCapturingMetrics,
  createFixedClock,
  createInMemoryCardStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
  createSequentialIds,
  seedCard,
} from "../testing/fakes.js";
import { addGame } from "./addGame.js";
import { finalizeRound } from "./finalizeRound.js";
import { joinRound } from "./joinRound.js";
import { readEvents } from "./readEvents.js";
import { recordScore } from "./recordScore.js";
import { startRound } from "./startRound.js";

// Not part of the shared fakes (testing/fakes.ts) — same local idiom as roundSlice.test.ts's
// own createTestTokenIssuer: just enough of TokenIssuer for startRound/joinRound to call
// `tokens.issue` without erroring.
const createTestTokenIssuer = (): TokenIssuer => {
  const claimsByToken = new Map<string, TokenClaims>();
  let counter = 0;
  return {
    issue: (claims) => {
      const token = `token-${(counter += 1)}`;
      claimsByToken.set(token, claims);
      return token;
    },
    verify: (token) => claimsByToken.get(token),
  };
};

const toResult = (score: number) => ({ kind: "strokes" as const, strokes: score });

// One client device's opId/hlc generator — matches roundSlice.test.ts's createClientOps.
const createClientOps = (device: string) => {
  let opCounter = 0;
  let wallMs = 5_000;
  return () => ({ opId: opId(`${device}-op-${(opCounter += 1)}`), hlc: { wallMs: wallMs++, counter: 0, deviceId: deviceId(device) } });
};

// journal + snapshots must SHARE state: the atomic finalize commit records into the snapshot
// store the SnapshotStore then reads (testing/fakes.ts models the real cross-table
// transaction this way). setup pairs them by default; the carry-2 suites below pass in their
// own already-paired pair so a race-injecting wrapper can sit over the same `inner`.
const setup = async (overrides?: { journal?: EventJournal; store?: RoundStore; snapshots?: SnapshotStore }) => {
  const snapshotStore = createInMemorySnapshotStore();
  const journal = overrides?.journal ?? createInMemoryJournal(snapshotStore);
  const snapshots = overrides?.snapshots ?? snapshotStore;
  const store = overrides?.store ?? createInMemoryRoundStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("t");
  const golferStore = createInMemoryGolferStore();
  const projectionStore = createInMemoryProjectionStore();
  const logger = createNullLogger();
  const cardStore = createInMemoryCardStore();
  const cardRecord = await seedCard(cardStore, courseId("course-1"), cardId("card-1"), fixtureLinks);
  const course = { courseId: cardRecord.courseId, cardId: cardRecord.cardId };
  const metrics = createCapturingMetrics();

  return {
    journal,
    snapshots,
    broadcast,
    course,
    metrics,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids, metrics }),
    events: readEvents({ journal }),
  };
};

// A live round, Ann (host) + Bo, with a stableford game over both of them already added —
// live but unscored, the starting point both carries' (and the atomic-commit suite's) tests
// build on.
const freshLiveRoundWithGame = async (overrides?: { journal?: EventJournal; store?: RoundStore; snapshots?: SnapshotStore }) => {
  const ctx = await setup(overrides);
  const host = await ctx.start({ course: ctx.course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } }, { sub: "sub-host" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: 2 } }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  await ctx.addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
  return { ...ctx, host, bo, hostClaims, boClaims };
};

// Scores all 9 holes for both players so the stableford game resolves — the precondition for
// a successful finalize.
const scoreAll = async (
  round: Awaited<ReturnType<typeof freshLiveRoundWithGame>>,
  annPhone: ReturnType<typeof createClientOps>,
  boPhone: ReturnType<typeof createClientOps>,
) => {
  for (let hole = 1; hole <= 9; hole += 1) {
    await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: toResult(4), ...annPhone() });
    await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: toResult(4), ...boPhone() });
  }
};

// A journal decorator that counts how many appends carried a snapshot — the direct proof that
// round-finalized and its snapshot ride ONE append call, not two writes.
const snapshotCountingJournal = (inner: EventJournal): EventJournal & { readonly snapshotAppends: () => number } => {
  let snapshotAppends = 0;
  return {
    snapshotAppends: () => snapshotAppends,
    append: (roundId, events, options?: AppendOptions): Promise<AppendResult> => {
      if (options?.snapshot !== undefined) snapshotAppends += 1;
      return inner.append(roundId, events, options);
    },
    read: (roundId, sinceSeq) => inner.read(roundId, sinceSeq),
  };
};

describe("finalizeRound — atomic snapshot commit", () => {
  it("finalize commits round-finalized and the snapshot atomically — one append call carries both", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const counting = snapshotCountingJournal(inner);
    const round = await freshLiveRoundWithGame({ journal: counting, snapshots });
    await scoreAll(round, createClientOps("ann-phone"), createClientOps("bo-phone"));

    const result = await round.finalize(round.hostClaims);
    expect(result.results).toHaveLength(1);

    // Exactly ONE append carried a snapshot — the finalize commit. No separate archive write.
    expect(counting.snapshotAppends()).toBe(1);

    const log = await inner.read(round.host.roundId, 0);
    expect(log.filter((event) => event.kind === "round-finalized")).toHaveLength(1);

    // The committed snapshot IS the settled archive of the committed log — same object, one
    // transaction, no post-append re-read that could drift.
    const stored = await snapshots.get(round.host.roundId);
    expect(stored).toBeDefined();
    expect(stored).toEqual(settleRound(log));
    expect(stored!.results).toEqual(result.results);
  });

  it("idempotent branch: already-final round returns the stored snapshot without appending", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const counting = snapshotCountingJournal(inner);
    const round = await freshLiveRoundWithGame({ journal: counting, snapshots });
    await scoreAll(round, createClientOps("ann-phone"), createClientOps("bo-phone"));

    const first = await round.finalize(round.hostClaims);
    const logAfterFirst = await inner.read(round.host.roundId, 0);

    const second = await round.finalize(round.hostClaims);

    expect(second).toEqual(first); // same settled results, handed straight back from the stored snapshot
    expect(counting.snapshotAppends()).toBe(1); // the second finalize appended NOTHING — no second commit
    const logAfterSecond = await inner.read(round.host.roundId, 0);
    expect(logAfterSecond).toEqual(logAfterFirst); // and no second round-finalized event
    expect(logAfterSecond.filter((event) => event.kind === "round-finalized")).toHaveLength(1);
  });

  it("a final round with NO stored snapshot throws loudly (corrupt) — the repair branch is gone", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const round = await freshLiveRoundWithGame({ journal: inner, snapshots });
    await scoreAll(round, createClientOps("ann-phone"), createClientOps("bo-phone"));

    // Land round-finalized DIRECTLY — an unconditional append with no `snapshot` option, so the
    // paired snapshot store is never written. This reproduces a `final` log with no snapshot: a
    // state the atomic commit rules out going forward, but the idempotent branch must still
    // refuse to silently re-settle it (the M9 repair-on-replay branch that recomputed-and-wrote
    // here is deleted — a missing snapshot under a final log is corruption, not a retry to heal).
    const orphanFinal: RoundEvent = {
      kind: "round-finalized",
      opId: opId("orphan-final"),
      hlc: { wallMs: 9_000, counter: 0, deviceId: deviceId("server") },
      authorId: round.host.golferId,
    };
    await inner.append(round.host.roundId, [orphanFinal]);

    expect(reduceRound(await inner.read(round.host.roundId, 0)).status).toBe("final");
    expect(await snapshots.get(round.host.roundId)).toBeUndefined();

    await expect(round.finalize(round.hostClaims)).rejects.toThrow(/no snapshot|corrupt/);
  });

  it("headSeqConflict → re-read → snapshot computed from the NEW candidate log", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const round = await freshLiveRoundWithGame({ journal: inner, snapshots });
    const annPhone = createClientOps("ann-phone");
    await scoreAll(round, annPhone, createClientOps("bo-phone"));

    // The event that "lands" in the gap between the settle-check read and the conditional
    // append — a re-send of Ann's hole-1 score with a later hlc (still resolved).
    let injectedOpId: OpId | undefined;
    const lateCorrection = (): RoundEvent => {
      const stamp = annPhone();
      injectedOpId = stamp.opId;
      return { kind: "score-recorded", golferId: round.host.golferId, hole: 1, result: toResult(4), authorId: round.host.golferId, ...stamp };
    };

    const racy = createRaceInjectingJournal(inner, lateCorrection, 1);
    const raceFinalize = finalizeRound({
      journal: racy,
      snapshots,
      broadcast: createCapturingBroadcast(),
      clock: createFixedClock(9_000),
      ids: createSequentialIds("race"),
    });

    const finalized = await raceFinalize(round.hostClaims);
    expect(finalized.results).toHaveLength(1);

    // The stored snapshot was settled from the log AS IT WAS AT COMMIT — which includes the
    // injected late correction, because the first attempt's headSeqConflict forced a re-read +
    // re-settle. A stale snapshot (computed from the pre-race candidate log) would omit it.
    const fullLog = await inner.read(round.host.roundId, 0);
    const stored = await snapshots.get(round.host.roundId);
    expect(stored).toBeDefined();
    expect(stored!.events.some((event) => event.opId === injectedOpId)).toBe(true);
    expect(stored).toEqual(settleRound(fullLog));
  });
});

describe("finalizeRound — carry 1: settle-before-append", () => {
  it("a finalize on an unresolvable game leaves NO round-finalized event and status live; a later finalize succeeds once the game resolves", async () => {
    const round = await freshLiveRoundWithGame();
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");

    // Only 5 of fixtureLinks' 9 holes — the stableford game never resolves (resultOf
    // requires state.complete, scoring/result.ts).
    for (let hole = 1; hole <= 5; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: toResult(4), ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: toResult(4), ...boPhone() });
    }

    await expect(round.finalize(round.hostClaims)).rejects.toMatchObject({ code: "game-unresolved" });

    const afterFailedFinalize = await round.events(round.host.roundId, 0);
    expect(afterFailedFinalize.events.some((event) => event.kind === "round-finalized")).toBe(false);
    expect(reduceRound(afterFailedFinalize.events).status).toBe("live");
    // A settle-check that threw before touching the journal also never wrote a snapshot.
    expect(await round.snapshots.get(round.host.roundId)).toBeUndefined();

    // A second failed attempt is just as much a no-op as the first — the round must never
    // accumulate a wedged round-finalized event no matter how many times finalize is retried
    // against an unresolvable log.
    await expect(round.finalize(round.hostClaims)).rejects.toMatchObject({ code: "game-unresolved" });
    const stillNoFinalizeEvent = await round.events(round.host.roundId, 0);
    expect(stillNoFinalizeEvent.events.some((event) => event.kind === "round-finalized")).toBe(false);

    // Finish scoring — the game resolves — and finalize now succeeds, exactly once.
    for (let hole = 6; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: toResult(4), ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: toResult(4), ...boPhone() });
    }

    const finalized = await round.finalize(round.hostClaims);
    expect(finalized.results).toHaveLength(1);

    const afterSuccess = await round.events(round.host.roundId, 0);
    expect(afterSuccess.events.filter((event) => event.kind === "round-finalized")).toHaveLength(1);
    expect(reduceRound(afterSuccess.events).status).toBe("final");
    expect(await round.snapshots.get(round.host.roundId)).toBeDefined();
  });
});

describe("finalizeRound — metrics", () => {
  it("emits RoundsFinalized once on a genuine finalize, and not again on replay", async () => {
    const round = await freshLiveRoundWithGame();
    await scoreAll(round, createClientOps("ann-phone"), createClientOps("bo-phone"));

    await round.finalize(round.hostClaims); // genuine
    await round.finalize(round.hostClaims); // idempotent replay

    expect(round.metrics.calls).toEqual(["RoundsFinalized"]); // exactly one — replay does not re-emit
  });
});

// A journal decorator that injects an extra event through `inner` the first `times` calls it
// sees a CONDITIONAL append (identified by `options.expectedHeadSeq` being set — i.e.
// finalizeRound's own append, never RecordScore/AddGame/StartRound's unconditional ones) —
// simulating an event landing in the exact gap between finalizeRound's settle-check read and
// its append. Every other call passes straight through to `inner`.
const createRaceInjectingJournal = (
  inner: EventJournal,
  injectEvent: () => RoundEvent,
  times: number,
): EventJournal & { readonly injections: () => number } => {
  let injectionsRemaining = times;
  let injections = 0;
  return {
    injections: () => injections,
    append: async (roundId, events, options?: AppendOptions): Promise<AppendResult> => {
      if (options?.expectedHeadSeq !== undefined && injectionsRemaining > 0) {
        injectionsRemaining -= 1;
        injections += 1;
        await inner.append(roundId, [injectEvent()]);
      }
      return inner.append(roundId, events, options);
    },
    read: (roundId, sinceSeq) => inner.read(roundId, sinceSeq),
  };
};

describe("finalizeRound — carry 2: head-seq conditional append", () => {
  it("a score appended between the settle-check read and the append forces a re-read + re-validate, then succeeds", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const round = await freshLiveRoundWithGame({ journal: inner, snapshots });
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");

    // Fully score both — the game is resolved BEFORE finalize is ever called, so this test
    // isolates carry 2 (the append race) from carry 1 (the settle-ability check).
    for (let hole = 1; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: toResult(4), ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: toResult(4), ...boPhone() });
    }

    // The event that "lands" between finalizeRound's read and its append — a re-send of
    // Ann's hole-1 score with a later hlc, still resolved, so the retried settle-check still
    // succeeds (this test is about the race being CAUGHT and retried, not about a second,
    // unrelated failure mode).
    let injectedOpId: OpId | undefined;
    const lateCorrection = (): RoundEvent => {
      const stamp = annPhone();
      injectedOpId = stamp.opId;
      return { kind: "score-recorded", golferId: round.host.golferId, hole: 1, result: toResult(4), authorId: round.host.golferId, ...stamp };
    };

    const racy = createRaceInjectingJournal(inner, lateCorrection, 1);
    const raceFinalize = finalizeRound({
      journal: racy,
      snapshots,
      broadcast: createCapturingBroadcast(),
      clock: createFixedClock(9_000),
      ids: createSequentialIds("race"),
    });

    const finalized = await raceFinalize(round.hostClaims);
    expect(finalized.results).toHaveLength(1);
    // Exactly one injected race, proving the FIRST attempt is the one that hit the
    // interleaving event — not that it happened to retry for some other reason.
    expect(racy.injections()).toBe(1);

    const fullLog = await inner.read(round.host.roundId, 0);
    const finalizedEvents = fullLog.filter((event) => event.kind === "round-finalized");
    expect(finalizedEvents).toHaveLength(1);

    // The injected late correction landed BEFORE round-finalized in seq order — proof the
    // retry's re-read actually saw it (and re-validated against it) rather than
    // round-finalized racing ahead of an event the first settle-check never saw.
    const injectedEvent = fullLog.find((event) => event.opId === injectedOpId);
    expect(injectedEvent).toBeDefined();
    expect(injectedEvent!.seq!).toBeLessThan(finalizedEvents[0]!.seq!);
  });

  it("gives up after bounded attempts if the head keeps moving out from under every retry", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const round = await freshLiveRoundWithGame({ journal: inner, snapshots });
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");

    for (let hole = 1; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: toResult(4), ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: toResult(4), ...boPhone() });
    }

    const relentlessCorrection = (): RoundEvent => ({
      kind: "score-recorded",
      golferId: round.host.golferId,
      hole: 1,
      result: toResult(4),
      authorId: round.host.golferId,
      ...annPhone(),
    });

    // Injects on EVERY conditional append attempt — the head has moved again by the time
    // finalizeRound retries, every single time, so this must never converge.
    const racy = createRaceInjectingJournal(inner, relentlessCorrection, Number.POSITIVE_INFINITY);
    const raceFinalize = finalizeRound({
      journal: racy,
      snapshots,
      broadcast: createCapturingBroadcast(),
      clock: createFixedClock(9_000),
      ids: createSequentialIds("race2"),
    });

    await expect(raceFinalize(round.hostClaims)).rejects.toThrow(/did not converge/);

    // Bounded means bounded: no round-finalized event ever lands, and no snapshot is ever
    // written, no matter how many retries it took to give up.
    const fullLog = await inner.read(round.host.roundId, 0);
    expect(fullLog.some((event) => event.kind === "round-finalized")).toBe(false);
    expect(await snapshots.get(round.host.roundId)).toBeUndefined();
  });
});
