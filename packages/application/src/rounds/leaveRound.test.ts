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
import { readEvents } from "./readEvents.js";
import { recordScore } from "./recordScore.js";
import { startRound } from "./startRound.js";

// Mirrors terminateGame.test.ts's own local token issuer + client-ops idioms (not part of the
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
    events: readEvents({ journal }),
  };
};

// A live round, Ann (host) + Bo — the starting point every case builds on.
const freshLiveRound = async () => {
  const ctx = await setup();
  const host = await ctx.start({ course: ctx.course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } }, { sub: "sub-host" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: 2 } }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  return { ...ctx, host, bo, hostClaims, boClaims };
};

describe("leaveRound — self-only append", () => {
  it("appends exactly one participant-left for the TOKEN's own golferId, broadcasts it, and marks that golfer departed in the fold", async () => {
    const round = await freshLiveRound();

    const result = await round.leave(round.boClaims);

    expect(result.events).toHaveLength(1);
    // The subject is the token's own golferId — leave is self-only by construction (no body to
    // name anyone else), and the domain author is the same golfer.
    expect(result.events[0]).toMatchObject({ kind: "participant-left", golferId: round.bo.golferId, authorId: round.bo.golferId });

    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "participant-left"))).toBe(true);

    const { state } = await loadRoundState(round.journal, round.host.roundId);
    const boSeat = state.participants.find((p) => p.golferId === round.bo.golferId);
    expect(boSeat?.departed).toBe(true);
    // Ann never left — only the leaver is marked departed.
    expect(state.participants.find((p) => p.golferId === round.host.golferId)?.departed).toBeUndefined();
  });

  it("never leaves anyone but the caller: a second participant's leave marks only THAT golfer", async () => {
    const round = await freshLiveRound();
    await round.leave(round.hostClaims);

    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.participants.find((p) => p.golferId === round.host.golferId)?.departed).toBe(true);
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.departed).toBeUndefined();
  });
});

describe("leaveRound — not a participant", () => {
  it("throws not-a-participant for a token whose golferId was never seated", async () => {
    const round = await freshLiveRound();
    const stranger: ParticipantClaims = { roundId: round.host.roundId, golferId: golferId("stranger") };
    await expect(round.leave(stranger)).rejects.toMatchObject({ code: "not-a-participant" });
  });
});

describe("leaveRound — idempotent in effect", () => {
  it("leaving twice appends two events but folds to the same result (still departed, still seated)", async () => {
    const round = await freshLiveRound();

    const first = await round.leave(round.boClaims);
    const second = await round.leave(round.boClaims);
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1); // NOT deduped to [] — two events, unlike terminateGame's no-op

    const afterBoth = await round.events(round.host.roundId, 0);
    expect(afterBoth.events.filter((event) => event.kind === "participant-left")).toHaveLength(2);

    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.departed).toBe(true);
  });
});

describe("leaveRound — round-not-live", () => {
  it("throws round-not-live once the round is final (sealed leaf — nothing appends after finalize)", async () => {
    const round = await freshLiveRound();
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");
    // No games added, so finalize needs no game resolution — just score a hole for each so the
    // round is a real, finalizable round.
    for (let hole = 1; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...boPhone() });
    }
    await round.finalize(round.hostClaims);

    await expect(round.leave(round.hostClaims)).rejects.toMatchObject({ code: "round-not-live" });
  });
});
