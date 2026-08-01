import { describe, expect, it } from "vitest";
import { cardId, courseId, deviceId, fixtureLinks, golferId, opId } from "@swng/domain";
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
import { finalizeRound } from "./finalizeRound.js";
import { joinRound } from "./joinRound.js";
import { loadRoundState } from "./loadRoundState.js";
import { recordScore } from "./recordScore.js";
import { setPlayedAt } from "./setPlayedAt.js";
import { startRound } from "./startRound.js";

// Mirrors setStrokes.test.ts's own local token issuer + client-ops idioms.
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

const createClientOps = (device: string) => {
  let opCounter = 0;
  let wallMs = 5_000;
  return () => ({ opId: opId(`${device}-op-${(opCounter += 1)}`), hlc: { wallMs: wallMs++, counter: 0, deviceId: deviceId(device) } });
};

const setup = async () => {
  const snapshots = createInMemorySnapshotStore();
  const journal = createInMemoryJournal(snapshots);
  const store = createInMemoryRoundStore();
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
    broadcast,
    course,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    set: setPlayedAt({ journal, broadcast, clock, ids }),
  };
};

// A live round, Ann (host) + Bo on the NINE-hole fixtureLinks card.
const freshLiveRound = async () => {
  const ctx = await setup();
  const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: "sub-host" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  return { ...ctx, host, bo, hostClaims, boClaims };
};

describe("setPlayedAt", () => {
  it("appends a round-played-at-set on a live round", async () => {
    const round = await freshLiveRound();

    const result = await round.set(round.hostClaims, { playedAtMs: 1_700_000_000_000 });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "round-played-at-set",
      playedAtMs: 1_700_000_000_000,
      authorId: round.host.golferId,
    });
    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "round-played-at-set"))).toBe(true);

    // The correction actually moves the round's played date, through the ONE shared rule.
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.playedAtMs).toBe(1_700_000_000_000);
  });

  it("accepts a correction from any participant, not just the one who started the round", async () => {
    const round = await freshLiveRound();
    await round.set(round.boClaims, { playedAtMs: 1_700_000_000_000 });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.playedAtMs).toBe(1_700_000_000_000);
  });

  it("refuses a finalized round with round-not-live", async () => {
    const round = await freshLiveRound();
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");
    for (let hole = 1; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...boPhone() });
    }
    await round.finalize(round.hostClaims);
    await expect(round.set(round.hostClaims, { playedAtMs: 1_700_000_000_000 })).rejects.toMatchObject({ code: "round-not-live" });
  });

  it("refuses a non-participant", async () => {
    const round = await freshLiveRound();
    const stranger: ParticipantClaims = { roundId: round.host.roundId, golferId: golferId("stranger") };
    await expect(round.set(stranger, { playedAtMs: 1_700_000_000_000 })).rejects.toMatchObject({ code: "not-a-participant" });
  });
});
