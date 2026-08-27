import { describe, expect, it } from "vitest";
import { cardId, courseId, deviceId, fixtureLinks, golferId, opId, roundId } from "@swng/domain";
import type { RoundEvent } from "@swng/domain";
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
import { getRoundView } from "./getRoundView.js";
import { joinRound } from "./joinRound.js";
import { recordScore } from "./recordScore.js";
import { startRound } from "./startRound.js";

// Mirrors finalizeRound.test.ts's own local token issuer — not part of the shared fakes for
// the same reason those aren't.
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
    snapshots,
    course,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    abandon: abandonRound({ journal, broadcast, clock, ids, projectionStore, logger }),
    view: getRoundView({ journal, snapshots, golferStore }),
  };
};

// A live round, Ann (host) + Bo, with a stableford game over both already added — live but
// unscored, the starting point most cases build on.
const freshLiveRoundWithGame = async () => {
  const ctx = await setup();
  const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: "sub-ann" });
  const bo = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: "sub-bo" });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  await ctx.addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
  return { ...ctx, host, bo, hostClaims, boClaims };
};

// Scores all 9 holes for both players (fixtureLinks is a nine-hole card) so the stableford
// game resolves — the precondition for a successful finalize.
const scoreAll = async (round: Awaited<ReturnType<typeof freshLiveRoundWithGame>>) => {
  for (let hole = 1; hole <= 9; hole += 1) {
    await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: toResult(4), opId: opId(`ann-op-${hole}`), hlc: { wallMs: 5_000 + hole, counter: 0, deviceId: deviceId("ann-phone") } });
    await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: toResult(4), opId: opId(`bo-op-${hole}`), hlc: { wallMs: 5_000 + hole, counter: 1, deviceId: deviceId("bo-phone") } });
  }
};

// A round genesis with NO round-started — the fold reads "setup" (round/state.ts's own
// LIFECYCLE_STATUS table), a status startRound never actually produces (it always appends
// round-created + participant-joined + round-started together). Crafted directly against the
// journal so this route's "setup requires the roster too" guard has a real state to refuse.
const setupOnlyRound = async () => {
  const ctx = await setup();
  const id = roundId("round-setup");
  const host = golferId("ann-setup");
  const events: readonly RoundEvent[] = [
    { kind: "round-created", roundId: id, card: fixtureLinks, playedAtMs: 1_000, opId: opId("op-created"), hlc: { wallMs: 1_000, counter: 0, deviceId: deviceId("server") }, authorId: host },
    { kind: "participant-joined", participant: { golferId: host, name: "Ann", tee: "white", strokes: 0 }, opId: opId("op-joined"), hlc: { wallMs: 1_001, counter: 0, deviceId: deviceId("server") }, authorId: host },
  ];
  await ctx.journal.append(id, events);
  return { ...ctx, roundId: id, host };
};

describe("getRoundView", () => {
  it("folds a live round for someone on the roster", async () => {
    const round = await freshLiveRoundWithGame();
    const view = await round.view({ sub: "sub-ann" }, round.host.roundId);

    expect(view.status).toBe("live");
    expect(view.participants).toHaveLength(2);
    expect(view.games).toHaveLength(1);
  });

  it("REFUSES a live round to a golfer who is not on the roster", async () => {
    const round = await freshLiveRoundWithGame();
    await expect(round.view({ sub: "sub-stranger" }, round.host.roundId)).rejects.toThrow(/participant/);
  });

  it("serves a finalized round to any signed-in golfer, matching GET /archive", async () => {
    const round = await freshLiveRoundWithGame();
    await scoreAll(round);
    await round.finalize(round.hostClaims);

    const view = await round.view({ sub: "sub-stranger" }, round.host.roundId);
    expect(view.status).toBe("final");
    expect(view.participants).toHaveLength(2);
  });

  it("REFUSES a setup round to a golfer who is not on the roster", async () => {
    const round = await setupOnlyRound();
    await expect(round.view({ sub: "sub-stranger" }, round.roundId)).rejects.toThrow(/participant/);
  });

  it("REFUSES an abandoned round to a golfer who is not on the roster", async () => {
    const round = await freshLiveRoundWithGame();
    await round.abandon(round.hostClaims);
    await expect(round.view({ sub: "sub-stranger" }, round.host.roundId)).rejects.toThrow(/participant/);
  });

  it("reports round-not-found when neither store has it", async () => {
    const ctx = await setup();
    await expect(ctx.view({ sub: "sub-ann" }, roundId("round-nowhere"))).rejects.toMatchObject({ code: "round-not-found" });
  });

  it("reports unresolved games in words for a live round", async () => {
    const round = await freshLiveRoundWithGame();
    const view = await round.view({ sub: "sub-ann" }, round.host.roundId);

    expect(view.unresolved).toHaveLength(1);
    expect(view.unresolved[0]!.missing).toMatch(/unscored for/);
  });
});
