import { describe, expect, it } from "vitest";
import { deviceId, fixtureLinks, opId, reduceRound } from "@swng/domain";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createCapturingBroadcast,
  createFixedClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
  createSequentialIds,
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

const setup = () => {
  const snapshots = createInMemorySnapshotStore();
  const journal = createInMemoryJournal(snapshots);
  const store = createInMemoryRoundStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("t");
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();
  const projectionStore = createInMemoryProjectionStore();
  const logger = createNullLogger();

  return {
    broadcast,
    projectionStore,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore, logger }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore, logger }),
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
const freshLiveRoundWithGame = async () => {
  const ctx = setup();
  const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
  const bo = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });
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
