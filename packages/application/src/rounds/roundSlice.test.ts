import { describe, expect, it } from "vitest";
import type { HoleResult } from "@swng/domain";
import { deviceId, fixtureLinks, golferId, opId } from "@swng/domain";
import type { ParticipantClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import { createCapturingBroadcast, createFixedClock, createInMemoryJournal, createInMemoryRoundStore, createSequentialIds } from "../testing/fakes.js";
import { addGame } from "./addGame.js";
import { finalizeRound } from "./finalizeRound.js";
import { joinRound } from "./joinRound.js";
import { readEvents } from "./readEvents.js";
import { recordScore } from "./recordScore.js";
import { startRound } from "./startRound.js";

// Not part of the exported fakes (testing/fakes.ts) — a real TokenIssuer adapter (HMAC)
// lands in M3 Task 4; this is just enough of the port for startRound/joinRound to call
// `tokens.issue` without erroring. Tests build ParticipantClaims directly, as a real
// dispatcher would after `tokens.verify`.
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

const toResult = (score: number | "picked-up"): HoleResult => (score === "picked-up" ? { kind: "picked-up" } : { kind: "strokes", strokes: score });

// One client device's opId/hlc generator — a fresh counter per phone, so two devices
// recording concurrently never collide on opId even though this suite never exercises
// the concurrent case itself (that's state.properties.test.ts's job, in domain).
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

  return {
    broadcast,
    start: startRound({ journal, store, broadcast, tokens, clock, ids }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, store, broadcast, clock, ids }),
    events: readEvents({ journal }),
  };
};

// A live round with Ann (host) and Bo (joiner) already seated — the starting point every
// focused case below needs, with no game and no scores yet.
const freshLiveRound = async () => {
  const ctx = setup();
  const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
  const bo = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });
  return { ...ctx, host, bo };
};

describe("round use cases — golden path over in-memory ports", () => {
  it("creates, joins, scores (including score-for-anyone), dedupes, and finalizes into the M2 golden stableford numbers", async () => {
    const ctx = setup();

    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });

    // StartRound's single append is exactly genesis + host join + start, in that order,
    // with contiguous seq 1..3 — and every one of those events is server-authored: hlc
    // pinned to deviceId "server", clock-driven (not a constant), authored by the host.
    const genesis = await ctx.events(host.roundId, 0);
    expect(genesis.events.map((event) => event.kind)).toEqual(["round-created", "participant-joined", "round-started"]);
    expect(genesis.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    for (const event of genesis.events) {
      expect(event.hlc.deviceId).toBe("server");
      expect(event.authorId).toBe(host.golferId);
    }
    expect(new Set(genesis.events.map((event) => event.hlc.wallMs)).size).toBe(3);

    const bo = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });
    const boJoined = (await ctx.events(host.roundId, 3)).events[0];
    expect(boJoined).toMatchObject({ kind: "participant-joined", authorId: bo.golferId, hlc: { deviceId: "server" } });

    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
    const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };

    const game = await ctx.addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
    expect(game.seq).toBe(5); // 1..3 genesis, 4 Bo's join, 5 game-added
    const gameAdded = (await ctx.events(host.roundId, 4)).events[0];
    expect(gameAdded).toMatchObject({ kind: "game-added", authorId: host.golferId, hlc: { deviceId: "server" } });

    // M2's golden stableford deck (stableford.test.ts): Ann's h4 is a pickup.
    const annScores: readonly (number | "picked-up")[] = [5, 6, 3, "picked-up", 5, 4, 5, 6, 5];
    const boScores: readonly number[] = [4, 4, 3, 5, 5, 3, 4, 5, 4];

    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");

    // Bo's phone records Ann's h1 — score-for-anyone.
    const annH1Op = boPhone();
    const annH1Result = await ctx.record(boClaims, { golferId: host.golferId, hole: 1, result: toResult(annScores[0]!), ...annH1Op });
    expect(annH1Result.duplicate).toBe(false);

    for (let hole = 2; hole <= 9; hole += 1) {
      await ctx.record(hostClaims, { golferId: host.golferId, hole, result: toResult(annScores[hole - 1]!), ...annPhone() });
    }
    for (let hole = 1; hole <= 9; hole += 1) {
      await ctx.record(boClaims, { golferId: bo.golferId, hole, result: toResult(boScores[hole - 1]!), ...boPhone() });
    }

    // The stored event for Ann's h1 carries Bo's authorship, Ann's golferId as subject.
    const afterScoring = await ctx.events(host.roundId, 0);
    const annH1Event = afterScoring.events.find((event) => event.kind === "score-recorded" && event.golferId === host.golferId && event.hole === 1);
    expect(annH1Event).toMatchObject({ authorId: bo.golferId, golferId: host.golferId });

    // Exact re-send of the same opId is a no-op: duplicate:true, never re-broadcast.
    const dup = await ctx.record(boClaims, { golferId: host.golferId, hole: 1, result: toResult(annScores[0]!), ...annH1Op });
    expect(dup).toEqual({ duplicate: true });
    const broadcastsForThatOp = ctx.broadcast.calls.flatMap((call) => call.events).filter((event) => event.opId === annH1Op.opId);
    expect(broadcastsForThatOp).toHaveLength(1);

    const final = await ctx.finalize(hostClaims);
    expect(final.results).toEqual([
      expect.objectContaining({
        kind: "stableford",
        points: [
          { golferId: host.golferId, points: 15 },
          { golferId: bo.golferId, points: 19 },
        ],
      }),
    ]);
    const finalizedEvent = (await ctx.events(host.roundId, 0)).events.find((event) => event.kind === "round-finalized");
    expect(finalizedEvent).toMatchObject({ authorId: host.golferId, hlc: { deviceId: "server" } });

    // Finalizing an already-final round recomputes and returns identical results — no new
    // event is appended (journal length unchanged).
    const eventsBeforeSecondFinalize = await ctx.events(host.roundId, 0);
    const finalAgain = await ctx.finalize(hostClaims);
    expect(finalAgain).toEqual(final);
    const eventsAfterSecondFinalize = await ctx.events(host.roundId, 0);
    expect(eventsAfterSecondFinalize.events).toHaveLength(eventsBeforeSecondFinalize.events.length);
  });

  it("rejects a join with an unknown join code — bad-join-code", async () => {
    const ctx = setup();
    await expect(ctx.join({ code: "ZZZZZZ", name: "Cal", tee: "white", courseHandicap: 10 })).rejects.toMatchObject({ code: "bad-join-code" });
  });

  it("rejects recordScore from a token whose golfer never joined, before any game exists — not-a-participant", async () => {
    const round = await freshLiveRound();
    const stranger: ParticipantClaims = { roundId: round.host.roundId, golferId: golferId("stranger") };
    const strangerPhone = createClientOps("stranger-phone");
    await expect(
      round.record(stranger, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...strangerPhone() }),
    ).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("rejects recordScore on a finalized round — round-not-live", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    await round.finalize(hostClaims);
    const annPhone = createClientOps("ann-phone");
    await expect(
      round.record(hostClaims, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...annPhone() }),
    ).rejects.toMatchObject({ code: "round-not-live" });
  });

  it("rejects a join after finalize — round-final", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    await round.finalize(hostClaims);
    await expect(round.join({ code: round.host.joinCode, name: "Cal", tee: "white", courseHandicap: 10 })).rejects.toMatchObject({ code: "round-final" });
  });

  it("rejects addGame that references a non-participant — unknown-golfer-in-game", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    await expect(
      round.addStableford(hostClaims, { game: { kind: "stableford", players: [round.host.golferId, golferId("ghost")] } }),
    ).rejects.toMatchObject({ code: "unknown-golfer-in-game" });
  });
});
