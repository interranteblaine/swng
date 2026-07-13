import { describe, expect, it } from "vitest";
import type { HoleResult } from "@swng/domain";
import { addMember, compareHlc, crewId, deviceId, fixtureLinks, golferId, opId, reduceRound } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import {
  createCapturingBroadcast,
  createCapturingLogger,
  createFixedClock,
  createFrozenClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
  createSequentialIds,
  putAndBindGolfer,
} from "../testing/fakes.js";
import { addGame } from "./addGame.js";
import { finalizeRound } from "./finalizeRound.js";
import { joinRound } from "./joinRound.js";
import { peekRound } from "./peekRound.js";
import { readEvents } from "./readEvents.js";
import { recordScore } from "./recordScore.js";
import { startRound } from "./startRound.js";

// Not part of the exported fakes (testing/fakes.ts) — a real TokenIssuer adapter (HMAC)
// lands in M3 Task 4; this is just enough of the port for startRound/joinRound to call
// `tokens.issue` without erroring. Tests build ParticipantClaims directly, as a real
// dispatcher would after `tokens.verify`.
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

const toResult = (score: number | "picked-up"): HoleResult => (score === "picked-up" ? { kind: "picked-up" } : { kind: "strokes", strokes: score });

// One client device's opId/hlc generator — a fresh counter per phone, so two devices
// recording concurrently never collide on opId even though this suite never exercises
// the concurrent case itself (that's state.properties.test.ts's job, in domain).
const createClientOps = (device: string) => {
  let opCounter = 0;
  let wallMs = 5_000;
  return () => ({ opId: opId(`${device}-op-${(opCounter += 1)}`), hlc: { wallMs: wallMs++, counter: 0, deviceId: deviceId(device) } });
};

const setup = (clock: Clock = createFixedClock(1_000)) => {
  const snapshots = createInMemorySnapshotStore();
  const journal = createInMemoryJournal(snapshots);
  const store = createInMemoryRoundStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const ids = createSequentialIds("t");
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();
  const projectionStore = createInMemoryProjectionStore();
  const logger = createNullLogger();

  return {
    broadcast,
    tokens,
    golferStore,
    crewStore,
    projectionStore,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore, logger }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore, logger }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    events: readEvents({ journal }),
    peek: peekRound({ journal, store }),
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

    // Deterministic pin on the bug this suite exists to catch: reducing StartRound's own
    // batch must land the round "live", not stuck in "setup" because round-created outraced
    // round-started on the status register's canonical (hlc, opId) order.
    expect(reduceRound(genesis.events).status).toBe("live");

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

  // requireParticipant (recordScore's first guard) only ever checks the AUTHOR (claims.golferId)
  // — see "rejects recordScore from a token whose golfer never joined" above. mayScore's own
  // participant check on the SUBJECT (command.golferId) is a separate branch that guard never
  // reaches: a real participant recording a score for someone who never joined.
  it("rejects recordScore for a subject who never joined, from a real participant's token — not-a-participant", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    const hostPhone = createClientOps("host-phone");
    await expect(
      round.record(hostClaims, { golferId: golferId("ghost"), hole: 1, result: toResult(4), ...hostPhone() }),
    ).rejects.toMatchObject({ code: "not-a-participant" });
  });

  // readEvents' nextSeq fallback (readEvents.ts: "the fallback to sinceSeq only fires on an
  // empty page, keeping the client's cursor unchanged") — pinned here for a cursor already
  // beyond the round's head (genesis + Bo's join tops out at seq 4), so the journal hands
  // back an empty page and nextSeq must echo the caller's cursor, not silently reset it.
  it("readEvents beyond the head returns an empty page with nextSeq pinned to the caller's cursor", async () => {
    const round = await freshLiveRound();
    const beyondHead = await round.events(round.host.roundId, 100);
    expect(beyondHead).toEqual({ events: [], nextSeq: 100 });
  });

  // Capability discipline (M6 Task 2 brief): a pre-join peek gets exactly courseName + tee
  // rating/slope summaries — nothing about the round's identity, participants, or scoring.
  // Asserting the exact key set (not just "has these fields") is what pins that a field
  // can't be silently added later without this test catching it.
  it("peekRound returns courseName + tee summaries and nothing else", async () => {
    const round = await freshLiveRound();
    const peeked = await round.peek(round.host.joinCode);

    expect(Object.keys(peeked).sort()).toEqual(["courseName", "teeSets"]);
    expect(peeked.courseName).toBe(fixtureLinks.courseName);
    expect(peeked.teeSets).toEqual(fixtureLinks.teeSets.map((tee) => ({ name: tee.name, rating: tee.rating, slope: tee.slope })));
    for (const teeSet of peeked.teeSets) {
      expect(Object.keys(teeSet).sort()).toEqual(["name", "rating", "slope"]);
    }
  });

  it("rejects peekRound with an unknown join code — bad-join-code, same shape as join's", async () => {
    const ctx = setup();
    await expect(ctx.peek("ZZZZZZ")).rejects.toMatchObject({ code: "bad-join-code" });
  });
});

// Task 5b (ghost continuity, .superpowers/sdd/task-5b-brief.md): a joiner may present an
// existing GolferId so the SAME ghost recurs across rounds — reuse is allowed IFF the golfer
// is unclaimed. Absent-golferId behavior is pinned by the untouched suite above (setup()'s
// join is the exact same function; these tests only exercise the NEW branch).
describe("joinRound — supplied golferId (Task 5b)", () => {
  it("uses the supplied golferId for the participant event, the response, and the issued token", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const ghost = golferId("ghost-1");

    const joined = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2, golferId: ghost });
    expect(joined.golferId).toBe(ghost);

    const boJoinedEvent = (await ctx.events(host.roundId, 3)).events[0];
    expect(boJoinedEvent).toMatchObject({ kind: "participant-joined", authorId: ghost, participant: { golferId: ghost } });

    expect(ctx.tokens.verify(joined.token)).toEqual({ scope: "participant", roundId: host.roundId, golferId: ghost });
  });

  it("reuses the SAME supplied golferId across two different rounds — continuity", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-2");

    const roundA = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const joinedA = await ctx.join({ code: roundA.joinCode, name: "Bo", tee: "white", courseHandicap: 2, golferId: ghost });
    expect(joinedA.golferId).toBe(ghost);

    const roundB = await ctx.start({ card: fixtureLinks, host: { name: "Cal", tee: "white", courseHandicap: 5 } });
    const joinedB = await ctx.join({ code: roundB.joinCode, name: "Bo", tee: "white", courseHandicap: 2, golferId: ghost });
    expect(joinedB.golferId).toBe(ghost);
    expect(joinedB.roundId).not.toBe(joinedA.roundId);
  });

  // golferStore.ts's port doc invariant: absence of a GOLFER row means unclaimed (rows are
  // lazy) — only a row WITH sub blocks reuse. `.claim` is the fake's own real path to a
  // sub-bound row (mirrors claimGolfer.ts's usage), not a hand-built object.
  it("rejects a join with a claimed golferId — golfer-claimed", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-1", "Real Person");

    await expect(
      ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2, golferId: claimed }),
    ).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("rejects a join with a golferId that's already a participant in THIS round — golfer-already-in-round", async () => {
    const round = await freshLiveRound(); // Ann (host) + Bo already joined with a freshly-minted golferId
    await expect(
      round.join({ code: round.host.joinCode, name: "Bo again", tee: "white", courseHandicap: 3, golferId: round.bo.golferId }),
    ).rejects.toMatchObject({ code: "golfer-already-in-round" });
  });
});

// A clock frozen at a single wallMs reproduces the real-world condition createFixedClock's
// 1ms-per-call advance can never hit: several server events minted within the same
// millisecond. Before createServerHlcSource (serverEnvelope.ts), every one of StartRound's
// three envelopes stamped `counter: 0` off the same frozen wallMs — identical hlcs, so the
// status register's canonical (hlc, then opId) order fell back to comparing random UUIDs,
// making round-created vs. round-started win the tie on a coin flip. This is the fault this
// suite exists to pin: it must FAIL against that pre-fix construction (identical hlcs, no
// guaranteed order) and PASS once hlcs are strictly increasing within the batch.
describe("StartRound's batch under a frozen clock (regression: same-ms server events)", () => {
  it("stamps round-created, participant-joined, and round-started with strictly increasing hlc, and reduces to status live", async () => {
    const ctx = setup(createFrozenClock(1_000));

    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const genesis = await ctx.events(host.roundId, 0);

    expect(genesis.events.map((event) => event.kind)).toEqual(["round-created", "participant-joined", "round-started"]);

    // Every event shares the frozen wallMs — the collision this test forces — so ordering
    // can only come from the counter createServerHlcSource increments per stamp.
    expect(new Set(genesis.events.map((event) => event.hlc.wallMs)).size).toBe(1);
    expect(genesis.events.map((event) => event.hlc.counter)).toEqual([0, 1, 2]);

    for (let i = 1; i < genesis.events.length; i += 1) {
      expect(compareHlc(genesis.events[i - 1]!.hlc, genesis.events[i]!.hlc)).toBeLessThan(0);
    }

    expect(reduceRound(genesis.events).status).toBe("live");
  });
});

// StartRound's identity fields (golferId as-self create, an initial `players` roster) and the
// co-membership consent arm threaded through the shared resolver. Round-is-a-sealed-leaf: there
// is no crewId on the request and no round crew tag — a signed-in host seating a claimed fellow
// crew member is authorized by CO-MEMBERSHIP (the caller's own crews ∩ the target's), derived
// inside golferIdentity.ts. Builds crew fixtures directly on the shared crewStore (domain's
// addMember + crewStore.put), self-contained like golferIdentity.test.ts's own fixtures.
describe("StartRound — as-self create, an initial players roster, and co-membership seating", () => {
  it("golferId (as-self): a claimed golfer whose OWN sub matches becomes the host, no fresh id minted", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");

    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId }, { sub: "sub-ann" });

    expect(host.golferId).toBe(annId);
    const genesis = await ctx.events(host.roundId, 0);
    const joinEvent = genesis.events.find((event) => event.kind === "participant-joined");
    expect(joinEvent).toMatchObject({ participant: { golferId: annId } });
  });

  it("golferId claimed by a STRANGER (no matching sub, no crew): rejected — golfer-claimed, round never created", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-ann", "Ann");

    await expect(
      ctx.start({ card: fixtureLinks, host: { name: "Bo", tee: "white", courseHandicap: 8 }, golferId: claimed }, { sub: "sub-stranger" }),
    ).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("round-created never carries a crewId, even when the host is signed in and in a crew (sealed leaf)", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    const crew = addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: annId, name: "Ann", role: "organizer" });
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    const host = await ctx.start(
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId },
      { sub: "sub-ann" },
    );

    const genesis = await ctx.events(host.roundId, 0);
    expect(genesis.events[0]).toMatchObject({ kind: "round-created" });
    expect(genesis.events[0]).not.toHaveProperty("crewId");
  });

  it("co-membership: a claimed fellow crew member (not the caller) can be seated via the players array", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    const boId = golferId("bo-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    await putAndBindGolfer(ctx.golferStore, boId, "sub-bo", "Bo"); // Bo is claimed by a DIFFERENT sub than the caller
    const crew = addMember(
      addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: annId, name: "Ann", role: "organizer" }),
      { golferId: boId, name: "Bo", role: "member" },
    );
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    // No crewId on the request — Ann and Bo share crew-1, and that's the whole consent.
    const host = await ctx.start(
      {
        card: fixtureLinks,
        host: { name: "Ann", tee: "white", courseHandicap: 8 },
        golferId: annId,
        players: [{ name: "Bo", tee: "white", courseHandicap: 2, golferId: boId }],
      },
      { sub: "sub-ann" },
    );

    const genesis = await ctx.events(host.roundId, 0);
    const boJoin = genesis.events.find((event) => event.kind === "participant-joined" && event.participant.golferId === boId);
    expect(boJoin).toMatchObject({ participant: { golferId: boId, name: "Bo" } });
  });

  it("co-membership does NOT extend to a golfer claimed by someone the caller shares no crew with — golfer-claimed", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    const outsiderId = golferId("outsider");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    await putAndBindGolfer(ctx.golferStore, outsiderId, "sub-outsider", "Outsider");
    // Ann is in crew-1; the outsider is claimed and in NO crew Ann belongs to.
    const crew = addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: annId, name: "Ann", role: "organizer" });
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    await expect(
      ctx.start(
        {
          card: fixtureLinks,
          host: { name: "Ann", tee: "white", courseHandicap: 8 },
          golferId: annId,
          players: [{ name: "Outsider", tee: "white", courseHandicap: 2, golferId: outsiderId }],
        },
        { sub: "sub-ann" },
      ),
    ).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("players (no crew): appends participant-joined events in request order, right after the host, all before round-started", async () => {
    const ctx = setup();

    const host = await ctx.start({
      card: fixtureLinks,
      host: { name: "Ann", tee: "white", courseHandicap: 8 },
      players: [
        { name: "Bo", tee: "white", courseHandicap: 2 },
        { name: "Cal", tee: "white", courseHandicap: 10 },
      ],
    });

    const genesis = await ctx.events(host.roundId, 0);
    expect(genesis.events.map((event) => event.kind)).toEqual([
      "round-created",
      "participant-joined", // host
      "participant-joined", // Bo
      "participant-joined", // Cal
      "round-started",
    ]);
    expect(genesis.events.map((event) => (event.kind === "participant-joined" ? event.participant.name : undefined))).toEqual([
      undefined,
      "Ann",
      "Bo",
      "Cal",
      undefined,
    ]);
    // seq is strictly contiguous — one journal append, not N separate ones.
    expect(genesis.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  // Papercut 1 (M9 hardening): the SAME golferId can't hold two roster seats in one batch.
  it("players[] with the SAME golferId twice is rejected — golfer-already-in-round, round never created", async () => {
    const ctx = setup();
    const dup = golferId("dup-player");

    await expect(
      ctx.start({
        card: fixtureLinks,
        host: { name: "Ann", tee: "white", courseHandicap: 8 },
        players: [
          { name: "Bo", tee: "white", courseHandicap: 2, golferId: dup },
          { name: "Bo again", tee: "white", courseHandicap: 4, golferId: dup },
        ],
      }),
    ).rejects.toMatchObject({ code: "golfer-already-in-round" });
  });

  it("a player golferId matching the host's own supplied golferId is rejected — golfer-already-in-round", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");

    await expect(
      ctx.start(
        {
          card: fixtureLinks,
          host: { name: "Ann", tee: "white", courseHandicap: 8 },
          golferId: annId,
          players: [{ name: "Ann again", tee: "white", courseHandicap: 8, golferId: annId }],
        },
        { sub: "sub-ann" },
      ),
    ).rejects.toMatchObject({ code: "golfer-already-in-round" });
  });

  it("players entries reuse an UNCLAIMED existing golferId as-is (same T5b rule as JoinRound), never minting a fresh one for it", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-recurring");

    const host = await ctx.start({
      card: fixtureLinks,
      host: { name: "Ann", tee: "white", courseHandicap: 8 },
      players: [{ name: "Bo", tee: "white", courseHandicap: 2, golferId: ghost }],
    });

    const genesis = await ctx.events(host.roundId, 0);
    const boJoin = genesis.events.find((event) => event.kind === "participant-joined" && event.participant.name === "Bo");
    expect(boJoin).toMatchObject({ participant: { golferId: ghost } });
  });

  // Pins the plain path: an absent golferId/players request is byte-identical to the
  // pre-M8 behavior — the golden-path test earlier in this file already exercises this exact
  // call shape and passes UNTOUCHED; this is an explicit second pin on the shape of the
  // response and the genesis event (no crewId, no players artifact leaks in when absent).
  it("with none of the optional fields set, StartRound's response shape is unchanged — no crewId/players artifact", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    expect(Object.keys(host).sort()).toEqual(["golferId", "joinCode", "roundId", "token"]);

    const genesis = await ctx.events(host.roundId, 0);
    expect(genesis.events).toHaveLength(3); // round-created, one participant-joined, round-started
    expect(genesis.events[0]).not.toHaveProperty("crewId");
  });
});

// JoinRound's own claims-carrying arms (the resolver is shared with StartRound/addParticipant
// — golferIdentity.ts). T5b's existing "claimed -> golfer-claimed" test above passes NO claims
// (ctx.sub always undefined there), so it only ever exercises arm 4 (claimed-stranger) — these
// tests are the sub-gated as-self and co-membership arms becoming reachable through JoinRound.
// Round-is-a-sealed-leaf: the round carries no crew tag, so co-membership is derived purely from
// the caller's own crews ∩ the target's, never from the round.
describe("JoinRound — as-self and co-membership arms (claims threaded through)", () => {
  it("as-self: a signed-in caller supplying their OWN claimed golferId is allowed", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const boId = golferId("bo-account");
    await putAndBindGolfer(ctx.golferStore, boId, "sub-bo", "Bo");

    const joined = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2, golferId: boId }, { sub: "sub-bo" });
    expect(joined.golferId).toBe(boId);
  });

  it("co-membership: a signed-in fellow crew member can seat a claimed crew-mate they share a crew with — even joining on their behalf", async () => {
    const ctx = setup();
    const boId = golferId("bo-account");
    const calId = golferId("cal-account");
    await putAndBindGolfer(ctx.golferStore, boId, "sub-bo", "Bo");
    await putAndBindGolfer(ctx.golferStore, calId, "sub-cal", "Cal");
    // Bo and Cal share a crew — the consent for Cal to seat Bo flows from THAT, not from any
    // tag on the round (which has none).
    const crew = addMember(
      addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: calId, name: "Cal", role: "organizer" }),
      { golferId: boId, name: "Bo", role: "member" },
    );
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });

    // Cal (signed in as sub-cal, not Bo) seats Bo via JoinRound — allowed by co-membership.
    const joined = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2, golferId: boId }, { sub: "sub-cal" });
    expect(joined.golferId).toBe(boId);
  });

  it("co-membership does NOT apply when the caller shares no crew with the claimed target — falls through to golfer-claimed", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-someone", "Someone");

    // The caller's sub resolves to no golfer at all (no crews to intersect), so no consent.
    await expect(
      ctx.join({ code: host.joinCode, name: "X", tee: "white", courseHandicap: 2, golferId: claimed }, { sub: "sub-a-stranger" }),
    ).rejects.toMatchObject({ code: "golfer-claimed" });
  });
});

// Presence (projection-realignment spec §5, Task 13): StartRound/JoinRound each write a LIVE
// pointer (rounds/presence.ts's writePresence) for every golfer they seat — the host + every
// `players[]` entry for StartRound, the joiner for JoinRound. addParticipant's own presence
// write is pinned in addParticipant.test.ts instead (a separate file, separate setup).
describe("StartRound/JoinRound — presence (Task 13)", () => {
  it("StartRound writes a LIVE pointer for the host, carrying the round's own courseName", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });

    const live = await ctx.projectionStore.listLive(host.golferId);
    expect(live).toEqual([{ roundId: host.roundId, courseName: fixtureLinks.courseName, joinedAtMs: expect.any(Number) }]);
  });

  it("StartRound writes a LIVE pointer for every players[] entry too, not just the host", async () => {
    const ctx = setup();
    const host = await ctx.start({
      card: fixtureLinks,
      host: { name: "Ann", tee: "white", courseHandicap: 8 },
      players: [{ name: "Bo", tee: "white", courseHandicap: 2, golferId: golferId("bo-ghost") }],
    });

    const boLive = await ctx.projectionStore.listLive(golferId("bo-ghost"));
    expect(boLive).toEqual([{ roundId: host.roundId, courseName: fixtureLinks.courseName, joinedAtMs: expect.any(Number) }]);
  });

  it("JoinRound writes a LIVE pointer for the joiner", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const bo = await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });

    const live = await ctx.projectionStore.listLive(bo.golferId);
    expect(live).toEqual([{ roundId: host.roundId, courseName: fixtureLinks.courseName, joinedAtMs: expect.any(Number) }]);
  });

  // A ghost's presence is written under the SAME GolferId a later claim inherits — no special
  // casing needed; this just pins that a SUPPLIED (not freshly minted) golferId still gets a
  // pointer, same as the freshly-minted case above.
  it("a ghost golferId reused across StartRound calls still gets its own LIVE pointer per round", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-recurring");

    const roundA = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: ghost });
    const roundB = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: ghost });

    const live = await ctx.projectionStore.listLive(ghost);
    expect(live.map((entry) => entry.roundId).sort()).toEqual([roundA.roundId, roundB.roundId].sort());
  });

  // The binding resolution (task-13-brief.md): "a discovery nicety must never block play." A
  // putLive that always throws must not stop the round from starting or being joined — and
  // the failure must be logged, not silently swallowed.
  it("a putLive failure does NOT fail StartRound — logged via logger.warn, round still starts", async () => {
    const throwingStore: ProjectionStore = {
      ...createInMemoryProjectionStore(),
      putLive: async () => {
        throw new Error("presence table unavailable");
      },
    };
    const logger = createCapturingLogger();
    const journal = createInMemoryJournal();
    const store = createInMemoryRoundStore();
    const broadcast = createCapturingBroadcast();
    const tokens = createTestTokenIssuer();
    const clock = createFixedClock(1_000);
    const ids = createSequentialIds("t");
    const golferStore = createInMemoryGolferStore();
    const crewStore = createInMemoryCrewStore();
    const start = startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore: throwingStore, logger });

    const host = await start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });

    expect(host.roundId).toBeDefined(); // the round started — presence's own failure never propagated
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toBe("presence-write-failed");
  });

  it("a putLive failure does NOT fail JoinRound — logged via logger.warn, join still succeeds", async () => {
    const throwingStore: ProjectionStore = {
      ...createInMemoryProjectionStore(),
      putLive: async () => {
        throw new Error("presence table unavailable");
      },
    };
    const logger = createCapturingLogger();
    const journal = createInMemoryJournal();
    const store = createInMemoryRoundStore();
    const broadcast = createCapturingBroadcast();
    const tokens = createTestTokenIssuer();
    const clock = createFixedClock(1_000);
    const ids = createSequentialIds("t");
    const golferStore = createInMemoryGolferStore();
    const crewStore = createInMemoryCrewStore();
    const start = startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore: throwingStore, logger });
    const join = joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore: throwingStore, logger });

    const host = await start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const bo = await join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 2 });

    expect(bo.golferId).toBeDefined(); // the join succeeded — presence's own failure never propagated
    // 2 warnings: the host's own StartRound presence write, then Bo's JoinRound one.
    expect(logger.warnings).toHaveLength(2);
    expect(logger.warnings.every((entry) => entry.message === "presence-write-failed")).toBe(true);
  });
});
