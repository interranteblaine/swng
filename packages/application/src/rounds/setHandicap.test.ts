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
import { leaveRound } from "./leaveRound.js";
import { loadRoundState } from "./loadRoundState.js";
import { recordScore } from "./recordScore.js";
import { setHandicap } from "./setHandicap.js";
import { startRound } from "./startRound.js";

// Mirrors leaveRound.test.ts's own local token issuer + client-ops idioms (not part of the
// shared fakes for the same reason those aren't).
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
    leave: leaveRound({ journal, broadcast, clock, ids }),
    set: setHandicap({ journal, broadcast, clock, ids }),
  };
};

// A live round, Ann (host) + Bo — the starting point every case builds on.
const freshLiveRound = async () => {
  const ctx = await setup();
  const host = await ctx.start({ course: ctx.course, host: { tee: "white", courseHandicap: 8 } }, { sub: "sub-host" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white", courseHandicap: 2 }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  return { ...ctx, host, bo, hostClaims, boClaims };
};

describe("setHandicap — any participant corrects any participant", () => {
  it("appends exactly one participant-handicap-set (author = caller, subject = body), broadcasts it, and the fold shows the corrected CH", async () => {
    const round = await freshLiveRound();

    const result = await round.set(round.hostClaims, { golferId: round.bo.golferId, courseHandicap: 13 });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: "participant-handicap-set", golferId: round.bo.golferId, courseHandicap: 13, authorId: round.host.golferId });
    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "participant-handicap-set"))).toBe(true);

    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.courseHandicap).toBe(13);
    // The seat's name/tee are untouched — the event cannot carry them.
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.tee).toBe("white");
  });

  it("accepts a plus handicap (negative int) and self-correction", async () => {
    const round = await freshLiveRound();
    await round.set(round.boClaims, { golferId: round.bo.golferId, courseHandicap: -2 });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.courseHandicap).toBe(-2);
  });

  it("corrects a DEPARTED participant without re-seating them", async () => {
    const round = await freshLiveRound();
    await round.leave(round.boClaims);
    await round.set(round.hostClaims, { golferId: round.bo.golferId, courseHandicap: 13 });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    const bo = state.participants.find((p) => p.golferId === round.bo.golferId);
    expect(bo?.courseHandicap).toBe(13);
    expect(bo?.departed).toBe(true);
  });
});

describe("setHandicap — guards", () => {
  it("throws not-a-participant when the AUTHOR is not seated", async () => {
    const round = await freshLiveRound();
    const stranger: ParticipantClaims = { roundId: round.host.roundId, golferId: golferId("stranger") };
    await expect(round.set(stranger, { golferId: round.bo.golferId, courseHandicap: 13 })).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("throws not-a-participant when the SUBJECT is not seated", async () => {
    const round = await freshLiveRound();
    await expect(round.set(round.hostClaims, { golferId: golferId("stranger"), courseHandicap: 13 })).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("throws round-not-live once the round is final", async () => {
    const round = await freshLiveRound();
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");
    for (let hole = 1; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...boPhone() });
    }
    await round.finalize(round.hostClaims);
    await expect(round.set(round.hostClaims, { golferId: round.bo.golferId, courseHandicap: 13 })).rejects.toMatchObject({ code: "round-not-live" });
  });
});
