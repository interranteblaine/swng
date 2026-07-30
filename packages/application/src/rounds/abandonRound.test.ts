import { describe, expect, it } from "vitest";
import type { RoundEvent } from "@swng/domain";
import { cardId, courseId, deviceId, fixtureLinks, opId, reduceRound } from "@swng/domain";
import type { AppendOptions, AppendResult, EventJournal } from "../ports/eventJournal.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createCapturingBroadcast,
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
import { abandonRound } from "./abandonRound.js";
import { addGame } from "./addGame.js";
import { finalizeRound } from "./finalizeRound.js";
import { joinRound } from "./joinRound.js";
import { readEvents } from "./readEvents.js";
import { recordScore } from "./recordScore.js";
import { startRound } from "./startRound.js";

// Not part of the shared fakes (testing/fakes.ts) — same local idiom as terminateGame.test.ts's
// own createTestTokenIssuer.
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

// One client device's opId/hlc generator — matches terminateGame.test.ts's own createClientOps.
const createClientOps = (device: string) => {
  let opCounter = 0;
  let wallMs = 5_000;
  return () => ({ opId: opId(`${device}-op-${(opCounter += 1)}`), hlc: { wallMs: wallMs++, counter: 0, deviceId: deviceId(device) } });
};

// overrides let the race suites below share one `inner` journal/snapshot pair between a
// race-injecting wrapper and a plain finalizeRound/abandonRound call — same idiom as
// finalizeRound.test.ts's own setup().
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

  return {
    journal,
    snapshots,
    broadcast,
    projectionStore,
    course,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    abandon: abandonRound({ journal, broadcast, clock, ids, projectionStore, logger }),
    events: readEvents({ journal }),
  };
};

// A live round, Ann (host) + Bo, with a stableford game over both already added — start + join
// each write a LIVE presence pointer for their own golfer (rounds/presence.ts), which the
// presence-cleanup case below depends on.
const freshLiveRoundWithGame = async (overrides?: { journal?: EventJournal; store?: RoundStore; snapshots?: SnapshotStore }) => {
  const ctx = await setup(overrides);
  const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: "sub-host" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  const added = await ctx.addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
  return { ...ctx, host, bo, hostClaims, boClaims, gameId: added.gameId };
};

const scoreAll = async (round: Awaited<ReturnType<typeof freshLiveRoundWithGame>>) => {
  const annPhone = createClientOps("ann-phone");
  const boPhone = createClientOps("bo-phone");
  for (let hole = 1; hole <= 9; hole += 1) {
    await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...annPhone() });
    await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...boPhone() });
  }
};

describe("abandonRound — happy path", () => {
  it("appends exactly one round-abandoned event, broadcasts it, and folds to status abandoned", async () => {
    const round = await freshLiveRoundWithGame();

    const result = await round.abandon(round.hostClaims);
    expect(result).toEqual({ status: "abandoned" });

    const after = await round.events(round.host.roundId, 0);
    expect(after.events.filter((event) => event.kind === "round-abandoned")).toHaveLength(1);
    expect(reduceRound(after.events).status).toBe("abandoned");

    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "round-abandoned"))).toBe(true);
  });

  it("any participant (not just the host) may abandon", async () => {
    const round = await freshLiveRoundWithGame();
    const result = await round.abandon(round.boClaims);
    expect(result).toEqual({ status: "abandoned" });
  });

  it("clears LIVE presence for every participant (no snapshot means the projector never runs)", async () => {
    const round = await freshLiveRoundWithGame();
    // start + join each seated a LIVE pointer under their own golfer.
    expect(await round.projectionStore.listLive(round.host.golferId)).toHaveLength(1);
    expect(await round.projectionStore.listLive(round.bo.golferId)).toHaveLength(1);

    await round.abandon(round.hostClaims);

    expect(await round.projectionStore.listLive(round.host.golferId)).toEqual([]);
    expect(await round.projectionStore.listLive(round.bo.golferId)).toEqual([]);
  });
});

describe("abandonRound — idempotent", () => {
  it("abandoning an already-abandoned round appends nothing and returns success", async () => {
    const round = await freshLiveRoundWithGame();
    await round.abandon(round.hostClaims);
    const logAfterFirst = await round.events(round.host.roundId, 0);

    const second = await round.abandon(round.hostClaims);
    expect(second).toEqual({ status: "abandoned" });

    const logAfterSecond = await round.events(round.host.roundId, 0);
    expect(logAfterSecond.events).toEqual(logAfterFirst.events); // no second round-abandoned event
    expect(logAfterSecond.events.filter((event) => event.kind === "round-abandoned")).toHaveLength(1);
  });
});

describe("abandonRound — rejected after finalize", () => {
  it("throws round-final once the round is already settled", async () => {
    const round = await freshLiveRoundWithGame();
    await scoreAll(round);
    await round.finalize(round.hostClaims);

    await expect(round.abandon(round.hostClaims)).rejects.toMatchObject({ code: "round-final" });
  });
});

describe("abandonRound — closes the round to further appends", () => {
  it("a score after abandon is rejected by the live-status guard (round-not-live)", async () => {
    const round = await freshLiveRoundWithGame();
    await round.abandon(round.hostClaims);

    const annPhone = createClientOps("ann-late");
    await expect(
      round.record(round.hostClaims, { golferId: round.host.golferId, hole: 1, result: { kind: "strokes", strokes: 4 }, ...annPhone() }),
    ).rejects.toMatchObject({ code: "round-not-live" });
  });

  it("adding a game after abandon is rejected by the live-status guard (round-not-live)", async () => {
    const round = await freshLiveRoundWithGame();
    await round.abandon(round.hostClaims);

    await expect(
      round.addStableford(round.hostClaims, { game: { kind: "stableford", players: [round.host.golferId, round.bo.golferId] } }),
    ).rejects.toMatchObject({ code: "round-not-live" });
  });

  it("finalize after abandon is refused by the settle-check (round-abandoned) and appends no round-finalized", async () => {
    const round = await freshLiveRoundWithGame();
    await round.abandon(round.hostClaims);

    await expect(round.finalize(round.hostClaims)).rejects.toMatchObject({ code: "round-abandoned" });

    const after = await round.events(round.host.roundId, 0);
    expect(after.events.some((event) => event.kind === "round-finalized")).toBe(false);
  });
});

// A journal decorator that runs `inject` (an arbitrary async action against `inner` — either a
// raw append or a full use-case call) the first `times` times it sees a CONDITIONAL append
// (`options.expectedHeadSeq` set) BEFORE forwarding that append to `inner` — same idiom as
// finalizeRound.test.ts's own createRaceInjectingJournal (carry 2), generalized to an arbitrary
// injector instead of a single synthesized event so it can drive a real finalizeRound call, not
// just a raw event, into the gap between abandon's read and its own append.
const createRaceInjectingJournal = (
  inner: EventJournal,
  inject: () => Promise<void>,
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
        await inject();
      }
      return inner.append(roundId, events, options);
    },
    read: (roundId, sinceSeq) => inner.read(roundId, sinceSeq),
  };
};

// task-15 fix wave: abandonRound's append is now conditional (expectedHeadSeq), closing the
// exact race a code review of 1e40bc9 found — device A's abandon reads live state, device B's
// finalizeRound commits round-finalized + snapshot atomically, and A's OLD unconditional append
// used to land round-abandoned after it anyway: the fold said abandoned (dominant) but the
// snapshot existed, already projected. These three tests pin the closed window.
describe("abandonRound — carry: head-seq conditional append (task-15 fix)", () => {
  it("a finalize that lands in abandon's read-append gap wins the race: abandon 409s round-final, no round-abandoned lands, and the finalized snapshot survives", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const round = await freshLiveRoundWithGame({ journal: inner, snapshots });
    await scoreAll(round); // resolves the stableford game so the injected finalize can succeed

    const finalizeDuringWindow = finalizeRound({
      journal: inner,
      snapshots,
      broadcast: createCapturingBroadcast(),
      clock: createFixedClock(9_000),
      ids: createSequentialIds("race-finalize"),
    });

    const racy = createRaceInjectingJournal(
      inner,
      async () => {
        await finalizeDuringWindow(round.hostClaims);
      },
      1,
    );
    const raceAbandon = abandonRound({
      journal: racy,
      broadcast: createCapturingBroadcast(),
      clock: createFixedClock(9_000),
      ids: createSequentialIds("race-abandon"),
      projectionStore: round.projectionStore,
      logger: createNullLogger(),
    });

    await expect(raceAbandon(round.hostClaims)).rejects.toMatchObject({ code: "round-final" });
    // Exactly one injected race — the FIRST attempt is the one that hit the interleaving finalize.
    expect(racy.injections()).toBe(1);

    const fullLog = await inner.read(round.host.roundId, 0);
    expect(fullLog.some((event) => event.kind === "round-abandoned")).toBe(false);
    expect(fullLog.filter((event) => event.kind === "round-finalized")).toHaveLength(1);
    expect(reduceRound(fullLog).status).toBe("final");

    // The load-bearing assertion: the snapshot the race was about EXISTS. Under the old
    // unconditional append, abandon's dominant fold would land anyway and this would strand a
    // snapshot that counts nowhere per the fold but is durably present, listable, and projected.
    const archived = await snapshots.get(round.host.roundId);
    expect(archived).toBeDefined();
    expect(archived!.results).toHaveLength(1);
  });

  it("abandon still wins when it lands first: a late finalize 409s round-abandoned with no snapshot ever written (reverse re-check)", async () => {
    const round = await freshLiveRoundWithGame();
    await round.abandon(round.hostClaims);

    await expect(round.finalize(round.hostClaims)).rejects.toMatchObject({ code: "round-abandoned" });

    const after = await round.events(round.host.roundId, 0);
    expect(after.events.some((event) => event.kind === "round-finalized")).toBe(false);
    expect(reduceRound(after.events).status).toBe("abandoned");
    expect(await round.snapshots.get(round.host.roundId)).toBeUndefined();
  });

  it("a concurrent abandon (a second device) landing in the read-append gap is caught by the re-read: idempotent success, exactly one round-abandoned event", async () => {
    const snapshots = createInMemorySnapshotStore();
    const inner = createInMemoryJournal(snapshots);
    const round = await freshLiveRoundWithGame({ journal: inner, snapshots });

    const concurrentAbandon = (): RoundEvent => ({
      kind: "round-abandoned",
      opId: opId("concurrent-device-b-abandon"),
      hlc: { wallMs: 9_000, counter: 0, deviceId: deviceId("bo-phone") },
      authorId: round.bo.golferId,
    });

    const racy = createRaceInjectingJournal(
      inner,
      async () => {
        await inner.append(round.host.roundId, [concurrentAbandon()]);
      },
      1,
    );
    const raceAbandon = abandonRound({
      journal: racy,
      broadcast: createCapturingBroadcast(),
      clock: createFixedClock(9_000),
      ids: createSequentialIds("race-abandon-2"),
      projectionStore: round.projectionStore,
      logger: createNullLogger(),
    });

    const result = await raceAbandon(round.hostClaims);
    expect(result).toEqual({ status: "abandoned" });
    expect(racy.injections()).toBe(1);

    const fullLog = await inner.read(round.host.roundId, 0);
    expect(fullLog.filter((event) => event.kind === "round-abandoned")).toHaveLength(1);
    expect(reduceRound(fullLog).status).toBe("abandoned");
  });
});
