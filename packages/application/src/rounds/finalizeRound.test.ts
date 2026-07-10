import { describe, expect, it } from "vitest";
import type { OpId, RoundEvent } from "@swng/domain";
import { deviceId, fixtureLinks, opId, reduceRound } from "@swng/domain";
import type { AppendOptions, AppendResult, EventJournal } from "../ports/eventJournal.js";
import type { ParticipantClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createCapturingBroadcast,
  createFixedClock,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryRoundStore,
  createSequentialIds,
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
  const claimsByToken = new Map<string, ParticipantClaims>();
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

const setup = (journal: EventJournal = createInMemoryJournal()) => {
  const store = createInMemoryRoundStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("t");
  const golferStore = createInMemoryGolferStore();

  return {
    journal,
    broadcast,
    start: startRound({ journal, store, broadcast, tokens, clock, ids }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, store, broadcast, clock, ids }),
    events: readEvents({ journal }),
  };
};

// A live round, Ann (host) + Bo, with a stableford game over both of them already added —
// live but unscored, the starting point both carries' tests build on.
const freshLiveRoundWithGame = async (journal?: EventJournal) => {
  const ctx = setup(journal);
  const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
  const bo = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  await ctx.addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
  return { ...ctx, host, bo, hostClaims, boClaims };
};

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
    const inner = createInMemoryJournal();
    const round = await freshLiveRoundWithGame(inner);
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
      store: createInMemoryRoundStore(),
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
    const inner = createInMemoryJournal();
    const round = await freshLiveRoundWithGame(inner);
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
      store: createInMemoryRoundStore(),
      broadcast: createCapturingBroadcast(),
      clock: createFixedClock(9_000),
      ids: createSequentialIds("race2"),
    });

    await expect(raceFinalize(round.hostClaims)).rejects.toThrow(/did not converge/);

    // Bounded means bounded: no round-finalized event ever lands, no matter how many retries
    // it took to give up.
    const fullLog = await inner.read(round.host.roundId, 0);
    expect(fullLog.some((event) => event.kind === "round-finalized")).toBe(false);
  });
});
