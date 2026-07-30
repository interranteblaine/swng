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
import { setBasis } from "./setBasis.js";
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
    set: setBasis({ journal, broadcast, clock, ids }),
  };
};

// A live round, Ann (host, states +8) + Bo (states +2) on the NINE-hole fixtureLinks card — the
// starting point every case builds on. Bo's +2 anchors the field, so the fold's own derived strokes
// here are Ann (8 − 2) / 2 = 3 and Bo 0 (spec 2026-07-29 §2b: halve the difference once, at the
// end). Every expectation below is re-derived from the corrected roster, never assumed unchanged.
const freshLiveRound = async () => {
  const ctx = await setup();
  const host = await ctx.start({ course: ctx.course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } }, { sub: "sub-host" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: 2 } }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  return { ...ctx, host, bo, hostClaims, boClaims };
};

describe("setBasis — any participant corrects any participant", () => {
  it("appends exactly one participant-basis-set (author = caller, subject = body), broadcasts it, and the fold re-derives the WHOLE roster's strokes", async () => {
    const round = await freshLiveRound();

    const result = await round.set(round.hostClaims, { golferId: round.bo.golferId, basis: { kind: "normally-shoots", overPar: 13 } });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "participant-basis-set",
      golferId: round.bo.golferId,
      basis: { kind: "normally-shoots", overPar: 13 },
      authorId: round.host.golferId,
    });
    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "participant-basis-set"))).toBe(true);

    const { state } = await loadRoundState(round.journal, round.host.roundId);
    const bo = state.participants.find((p) => p.golferId === round.bo.golferId);
    expect(bo?.basis).toEqual({ kind: "normally-shoots", overPar: 13 });
    // A correction moves EVERYONE, not just the subject (spec §2b): Ann's +8 is now the field's
    // lowest, so she drops to 0 and Bo takes (13 − 8) / 2 = 2.5 → 3 on this nine-hole card.
    expect(bo?.strokes).toBe(3);
    expect(state.participants.find((p) => p.golferId === round.host.golferId)?.strokes).toBe(0);
    // The seat's name/tee are untouched — the event cannot carry them.
    expect(bo?.tee).toBe("white");
  });

  it("accepts an under-par normal score and self-correction", async () => {
    const round = await freshLiveRound();
    await round.set(round.boClaims, { golferId: round.bo.golferId, basis: { kind: "normally-shoots", overPar: -2 } });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.basis).toEqual({ kind: "normally-shoots", overPar: -2 });
    // Bo now anchors two UNDER par, so Ann's strokes widen to (8 − −2) / 2 = 5.
    expect(state.participants.find((p) => p.golferId === round.host.golferId)?.strokes).toBe(5);
  });

  it("accepts the SECOND constructor — a literal strokes assertion, never halved", async () => {
    // Spec §2a: "just give him 13" is a different kind of statement, not a fudge of a normal
    // score — so it survives the nine-hole halving that a stated normal score goes through.
    const round = await freshLiveRound();
    await round.set(round.hostClaims, { golferId: round.bo.golferId, basis: { kind: "strokes", strokes: 13 } });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    const bo = state.participants.find((p) => p.golferId === round.bo.golferId);
    expect(bo?.basis).toEqual({ kind: "strokes", strokes: 13 });
    expect(bo?.strokes).toBe(13);
  });

  it("corrects a DEPARTED participant without re-seating them", async () => {
    const round = await freshLiveRound();
    await round.leave(round.boClaims);
    await round.set(round.hostClaims, { golferId: round.bo.golferId, basis: { kind: "normally-shoots", overPar: 13 } });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    const bo = state.participants.find((p) => p.golferId === round.bo.golferId);
    expect(bo?.basis).toEqual({ kind: "normally-shoots", overPar: 13 });
    expect(bo?.departed).toBe(true);
    // Ann is the only PRESENT stated normal score, so she anchors at 0 and Bo — departed but
    // still settling — resolves (13 − 8) / 2 = 3 against her (spec §2b).
    expect(bo?.strokes).toBe(3);
    expect(state.participants.find((p) => p.golferId === round.host.golferId)?.strokes).toBe(0);
  });
});

describe("setBasis — guards", () => {
  it("throws not-a-participant when the AUTHOR is not seated", async () => {
    const round = await freshLiveRound();
    const stranger: ParticipantClaims = { roundId: round.host.roundId, golferId: golferId("stranger") };
    await expect(round.set(stranger, { golferId: round.bo.golferId, basis: { kind: "normally-shoots", overPar: 13 } })).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("throws not-a-participant when the SUBJECT is not seated", async () => {
    const round = await freshLiveRound();
    await expect(round.set(round.hostClaims, { golferId: golferId("stranger"), basis: { kind: "normally-shoots", overPar: 13 } })).rejects.toMatchObject({ code: "not-a-participant" });
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
    await expect(round.set(round.hostClaims, { golferId: round.bo.golferId, basis: { kind: "normally-shoots", overPar: 13 } })).rejects.toMatchObject({ code: "round-not-live" });
  });
});
