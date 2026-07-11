import { describe, expect, it } from "vitest";
import { deviceId, fixtureLinks, gameId, opId } from "@swng/domain";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createCapturingBroadcast,
  createFixedClock,
  createInMemoryCrewStore,
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
import { terminateGame } from "./terminateGame.js";

// Not part of the shared fakes (testing/fakes.ts) — same local idiom as roundSlice.test.ts's
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

// One client device's opId/hlc generator — matches roundSlice.test.ts/finalizeRound.test.ts's
// own createClientOps.
const createClientOps = (device: string) => {
  let opCounter = 0;
  let wallMs = 5_000;
  return () => ({ opId: opId(`${device}-op-${(opCounter += 1)}`), hlc: { wallMs: wallMs++, counter: 0, deviceId: deviceId(device) } });
};

const setup = () => {
  const journal = createInMemoryJournal();
  const store = createInMemoryRoundStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("t");
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();

  return {
    broadcast,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, store, broadcast, clock, ids }),
    terminate: terminateGame({ journal, broadcast, clock, ids }),
    events: readEvents({ journal }),
  };
};

// A live round, Ann (host) + Bo, with a stableford game over both already added — live but
// unscored, the starting point every case below builds on.
const freshLiveRoundWithGame = async () => {
  const ctx = setup();
  const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
  const bo = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });
  const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
  const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };
  const added = await ctx.addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
  return { ...ctx, host, bo, hostClaims, boClaims, gameId: added.gameId };
};

describe("terminateGame — happy path", () => {
  it("appends exactly one game-terminated event, broadcasts it, and marks the game terminated in the fold", async () => {
    const round = await freshLiveRoundWithGame();

    const result = await round.terminate(round.hostClaims, round.gameId);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: "game-terminated", gameId: round.gameId });

    const afterTerminate = await round.events(round.host.roundId, 0);
    const terminations = afterTerminate.events.filter((event) => event.kind === "game-terminated");
    expect(terminations).toHaveLength(1);

    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "game-terminated"))).toBe(true);
  });

  it("any participant (not just the host) may terminate", async () => {
    const round = await freshLiveRoundWithGame();
    const result = await round.terminate(round.boClaims, round.gameId);
    expect(result.events).toHaveLength(1);
  });
});

describe("terminateGame — idempotent no-op", () => {
  it("terminating an already-terminated game appends nothing and returns an empty events tail", async () => {
    const round = await freshLiveRoundWithGame();
    await round.terminate(round.hostClaims, round.gameId);

    const second = await round.terminate(round.hostClaims, round.gameId);
    expect(second.events).toEqual([]);

    const afterBoth = await round.events(round.host.roundId, 0);
    const terminations = afterBoth.events.filter((event) => event.kind === "game-terminated");
    expect(terminations).toHaveLength(1); // still exactly one, not two
  });
});

describe("terminateGame — unknown-game", () => {
  it("throws unknown-game for a gameId never added to this round", async () => {
    const round = await freshLiveRoundWithGame();
    await expect(round.terminate(round.hostClaims, gameId("never-added"))).rejects.toMatchObject({ code: "unknown-game" });
  });
});

describe("terminateGame — round-not-live", () => {
  it("throws round-not-live once the round is final", async () => {
    const round = await freshLiveRoundWithGame();
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");
    // Resolve the stableford game fully (fixtureLinks' 9 holes, both golfers) so finalize
    // can succeed without needing termination itself.
    for (let hole = 1; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...boPhone() });
    }
    await round.finalize(round.hostClaims);

    await expect(round.terminate(round.hostClaims, round.gameId)).rejects.toMatchObject({ code: "round-not-live" });
  });
});

describe("terminateGame — composes with finalize (M7 plan: 'end round early')", () => {
  it("terminating the sole unresolved game unblocks finalize, and the archive excludes it from results", async () => {
    const round = await freshLiveRoundWithGame();
    // Leave the stableford game permanently unresolved (score nobody) — finalize must fail
    // until the game is terminated.
    await expect(round.finalize(round.hostClaims)).rejects.toMatchObject({ code: "game-unresolved" });

    await round.terminate(round.hostClaims, round.gameId);
    const finalized = await round.finalize(round.hostClaims);

    expect(finalized.results).toHaveLength(0); // the terminated game never produced a result
  });
});
