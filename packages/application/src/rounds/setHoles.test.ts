import { describe, expect, it } from "vitest";
import { cardId, courseId, deviceId, fixtureLinks, fixtureLinks18, golferId, opId } from "@swng/domain";
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
import { setHoles } from "./setHoles.js";
import { startRound } from "./startRound.js";

// Mirrors setPlayedAt.test.ts's own local token issuer + client-ops idioms.
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

// card defaults to the 18-hole fixtureLinks18 — front/back are two genuinely different nines on
// it, unlike the one-nine fixtureLinks card, which has its own dedicated setup below.
const setup = async (card = fixtureLinks18) => {
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
  const cardRecord = await seedCard(cardStore, courseId("course-1"), cardId("card-1"), card);
  const course = { courseId: cardRecord.courseId, cardId: cardRecord.cardId };

  return {
    journal,
    broadcast,
    course,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    set: setHoles({ journal, broadcast, clock, ids }),
  };
};

// A live round, Ann (host) + Bo, on the 18-hole fixtureLinks18 card — front and back are real,
// distinct nines here, so a correction that names one actually moves something.
const freshLiveRound = async () => {
  const ctx = await setup();
  const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: "sub-host" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  return { ...ctx, host, bo, hostClaims, boClaims };
};

// A live round on the one-nine fixtureLinks card — the case setHoles' own guard exists for
// (spec correction, 2026-08-03 §3): a nine selection here must be refused exactly like
// startRound's door refuses it at creation.
const freshLiveRoundOnOneNineCard = async () => {
  const ctx = await setup(fixtureLinks);
  const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: "sub-host" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  return { ...ctx, host, hostClaims };
};

describe("setHoles", () => {
  it("appends a round-holes-set while the round is live", async () => {
    const round = await freshLiveRound();

    const result = await round.set(round.hostClaims, { holes: "front" });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "round-holes-set",
      holes: "front",
      authorId: round.host.golferId,
    });
    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "round-holes-set"))).toBe(true);

    // The correction actually moves the round's holes selection, through the ONE shared fold rule.
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.holes).toBe("front");
  });

  it("accepts a correction from any participant, not just the one who started the round", async () => {
    const round = await freshLiveRound();
    await round.set(round.boClaims, { holes: "back" });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.holes).toBe("back");
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
    await expect(round.set(round.hostClaims, { holes: "front" })).rejects.toMatchObject({ code: "round-not-live" });
  });

  it("refuses a caller who is not a participant", async () => {
    const round = await freshLiveRound();
    const stranger: ParticipantClaims = { roundId: round.host.roundId, golferId: golferId("stranger") };
    await expect(round.set(stranger, { holes: "front" })).rejects.toMatchObject({ code: "not-a-participant" });
  });

  // Gap closed 2026-08-03 (spec correction §3): setHoles used to leave a one-nine card entirely
  // unguarded, on purpose — an API caller could set "back" on it and the join screen would then
  // assert something false about a course that has only one nine. Both non-"all" selections are
  // rejected the same way startRound's own door rejects them at creation.
  it("rejects a front-nine correction against a card with only one nine, with holes-not-on-this-card", async () => {
    const round = await freshLiveRoundOnOneNineCard();
    await expect(round.set(round.hostClaims, { holes: "front" })).rejects.toMatchObject({ code: "holes-not-on-this-card" });
  });

  it("rejects a back-nine correction against a card with only one nine, with holes-not-on-this-card", async () => {
    const round = await freshLiveRoundOnOneNineCard();
    await expect(round.set(round.hostClaims, { holes: "back" })).rejects.toMatchObject({ code: "holes-not-on-this-card" });
  });

  it("still accepts 'all' against a one-nine card — that selection never names a second nine", async () => {
    const round = await freshLiveRoundOnOneNineCard();
    const result = await round.set(round.hostClaims, { holes: "all" });
    expect(result.events).toHaveLength(1);
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.holes).toBe("all");
  });
});
