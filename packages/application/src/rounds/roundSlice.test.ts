import { describe, expect, it } from "vitest";
import type { HoleResult } from "@swng/domain";
import { cardId, compareHlc, courseId, deviceId, fixtureLinks, golferId, opId, placeholderName, reduceRound } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import {
  createCapturingBroadcast,
  createCapturingLogger,
  createCapturingMetrics,
  createFixedClock,
  createFrozenClock,
  createInMemoryCardStore,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
  createSequentialIds,
  putAndBindGolfer,
  seedCard,
} from "../testing/fakes.js";
import type { GolferStore } from "../ports/golferStore.js";
import { addGame } from "./addGame.js";
import { finalizeRound } from "./finalizeRound.js";
import { joinRound } from "./joinRound.js";
import { leaveRound } from "./leaveRound.js";
import { peekRound } from "./peekRound.js";
import { readEvents } from "./readEvents.js";
import { recordScore } from "./recordScore.js";
import { setStrokes } from "./setStrokes.js";
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

// Accounts-only identity (spec §3): every seat is an account, so tests seed real account golfers
// (a sub-bound row) and pass the caller's own AccountClaims. The seat's golferId and its frozen
// participant name both come from the record, so both are deterministic here.
const ANN = { id: golferId("ann-account"), sub: "sub-ann", name: "Ann" };
const BO = { id: golferId("bo-account"), sub: "sub-bo", name: "Bo" };

const seedAccounts = async (golferStore: GolferStore): Promise<void> => {
  await putAndBindGolfer(golferStore, ANN.id, ANN.sub, ANN.name);
  await putAndBindGolfer(golferStore, BO.id, BO.sub, BO.name);
};

// Course-cards spec §4: StartRound resolves a card by REFERENCE now — setup seeds one lineage
// (fixtureLinks, under CARD_REF) into a fresh CardStore per test and hands the reference back
// so every ctx.start() call below just passes it through.
const CARD_REF = { courseId: courseId("course-1"), cardId: cardId("card-1") };

const setup = async (clock: Clock = createFixedClock(1_000)) => {
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
  const cardStore = createInMemoryCardStore();
  const cardRecord = await seedCard(cardStore, CARD_REF.courseId, CARD_REF.cardId, fixtureLinks);
  const metrics = createCapturingMetrics();

  return {
    broadcast,
    tokens,
    golferStore,
    crewStore,
    projectionStore,
    cardStore,
    cardRecord,
    metrics,
    course: CARD_REF,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    leave: leaveRound({ journal, broadcast, clock, ids }),
    addStableford: addGame({ journal, broadcast, clock, ids }),
    record: recordScore({ journal, broadcast, metrics }),
    setStrokes: setStrokes({ journal, broadcast, clock, ids }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    events: readEvents({ journal }),
    peek: peekRound({ journal, store }),
  };
};

// A live round with Ann (creator) and Bo (joiner) already seated — the starting point every
// focused case below needs, with no game and no scores yet. Both are account golfers seated
// as-self from their own subs.
const freshLiveRound = async () => {
  const ctx = await setup();
  await seedAccounts(ctx.golferStore);
  const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });
  const bo = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: BO.sub });
  return { ...ctx, host, bo };
};

describe("round use cases — golden path over in-memory ports", () => {
  it("creates, joins, scores (including score-for-anyone), dedupes, and finalizes into the M2 golden stableford numbers", async () => {
    const ctx = await setup();
    await seedAccounts(ctx.golferStore);

    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });
    // As-self: the creator seat IS Ann's own account golfer, never a fresh id.
    expect(host.golferId).toBe(ANN.id);

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
    // The creator's participant-joined carries the account golfer's own name (frozen — sealed leaf).
    const hostJoin = genesis.events.find((event) => event.kind === "participant-joined");
    expect(hostJoin).toMatchObject({ participant: { golferId: ANN.id, name: ANN.name } });

    // Deterministic pin on the bug this suite exists to catch: reducing StartRound's own
    // batch must land the round "live", not stuck in "setup" because round-created outraced
    // round-started on the status register's canonical (hlc, opId) order.
    expect(reduceRound(genesis.events).status).toBe("live");

    const bo = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: BO.sub });
    expect(bo.golferId).toBe(BO.id);
    const boJoined = (await ctx.events(host.roundId, 3)).events[0];
    expect(boJoined).toMatchObject({ kind: "participant-joined", authorId: bo.golferId, participant: { golferId: BO.id, name: BO.name }, hlc: { deviceId: "server" } });

    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
    const boClaims: ParticipantClaims = { roundId: bo.roundId, golferId: bo.golferId };

    // The golden deck's own strokes, typed onto the roster (spec 2026-07-30 §2): Ann 3, Bo 0 —
    // the numbers stableford.test.ts's 10/17 lines are built on. Bo joins on 0 already.
    const strokesSet = await ctx.setStrokes(hostClaims, { golferId: host.golferId, strokes: 3 });
    expect(strokesSet.events[0]).toMatchObject({ kind: "participant-strokes-set", golferId: host.golferId, strokes: 3 });

    const game = await ctx.addStableford(hostClaims, { game: { kind: "stableford", players: [host.golferId, bo.golferId] } });
    expect(game.seq).toBe(6); // 1..3 genesis, 4 Bo's join, 5 the strokes-set, 6 game-added
    const gameAdded = (await ctx.events(host.roundId, 5)).events[0];
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
          { golferId: host.golferId, points: 10 },
          { golferId: bo.golferId, points: 17 },
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
    const ctx = await setup();
    await seedAccounts(ctx.golferStore);
    await expect(ctx.join({ code: "ZZZZZZ", tee: "white" }, { sub: BO.sub })).rejects.toMatchObject({ code: "bad-join-code" });
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

  it("accepts a RE-push of an already-recorded score on a finalized round — duplicate, not a refusal", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    const annPhone = createClientOps("ann-phone");
    // One op, pushed twice — the real shape of "the push landed but the pull never confirmed it,
    // so it is still in this device's outbox."
    const op = annPhone();
    await round.record(hostClaims, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...op });
    await round.finalize(hostClaims);

    await expect(round.record(hostClaims, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...op })).resolves.toEqual({ duplicate: true });
  });

  it("rejects a join after finalize — round-final (before ensureGolfer even runs)", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    await round.finalize(hostClaims);
    // A brand-new account (sub-cal) never even gets minted: round-final is thrown ahead of the seat.
    await expect(round.join({ code: round.host.joinCode, tee: "white" }, { sub: "sub-cal" })).rejects.toMatchObject({ code: "round-final" });
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
  it("peekRound returns courseName + tee summaries + createdAt and nothing else", async () => {
    const round = await freshLiveRound();
    const peeked = await round.peek(round.host.joinCode);

    // createdAt (accounts-only identity spec §5, the "course + date" designation) joins the set —
    // still nothing about the round's identity, participants, or scoring. Asserting the exact key
    // set keeps the next field from being added silently.
    expect(Object.keys(peeked).sort()).toEqual(["courseName", "createdAt", "teeSets"]);
    expect(peeked.courseName).toBe(fixtureLinks.courseName);
    // A tee is name + rating/slope, full stop. The `par`/`holes` pair that once rode here served
    // the join-side strokes derivation, which is deleted (spec 2026-07-29 §2b) — and §7 allows no
    // dormant fields, so neither survives. The per-tee key-set assertion below keeps the next field
    // from being added silently, exactly as the response-level one above does.
    expect(peeked.teeSets).toEqual(fixtureLinks.teeSets.map((tee) => ({ name: tee.name, rating: tee.rating, slope: tee.slope })));
    for (const teeSet of peeked.teeSets) {
      expect(Object.keys(teeSet).sort()).toEqual(["name", "rating", "slope"]);
    }
    // The genesis event's own wall time (peekRound reads it off the round-created event).
    expect(typeof peeked.createdAt).toBe("number");
  });

  it("rejects peekRound with an unknown join code — bad-join-code, same shape as join's", async () => {
    const ctx = await setup();
    await expect(ctx.peek("ZZZZZZ")).rejects.toMatchObject({ code: "bad-join-code" });
  });
});

// Accounts-only identity (spec §3): StartRound seats its CREATOR only, always as-self from the
// caller's Bearer — there is no host.name, no supplied golferId, no players[] roster. The seat's
// golferId and frozen participant name both come from the caller's own account golfer record
// (ensureGolfer resolves or mints it).
describe("StartRound — as-self only", () => {
  it("seats the caller's OWN account golfer as the creator: golferId + frozen name come from the record", async () => {
    const ctx = await setup();
    await putAndBindGolfer(ctx.golferStore, ANN.id, ANN.sub, ANN.name);

    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });

    expect(host.golferId).toBe(ANN.id);
    const genesis = await ctx.events(host.roundId, 0);
    const joinEvent = genesis.events.find((event) => event.kind === "participant-joined");
    expect(joinEvent).toMatchObject({ participant: { golferId: ANN.id, name: ANN.name } });
    expect(Object.keys(host).sort()).toEqual(["golferId", "joinCode", "roundId", "token"]);
    expect(genesis.events).toHaveLength(3); // round-created, one participant-joined, round-started — creator only
  });

  it("mints the caller's golfer on first touch when the sub has none yet — the seat carries the placeholder name f(sub)", async () => {
    const ctx = await setup();
    // No golfer seeded for sub-new: ensureGolfer mints one with placeholderName(sub-new).
    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: "sub-new" });

    expect(host.golferId).toBeDefined();
    // The freshly-minted account is now bound to the sub.
    expect((await ctx.golferStore.getBySub("sub-new"))?.golfer.id).toBe(host.golferId);
    const genesis = await ctx.events(host.roundId, 0);
    const joinEvent = genesis.events.find((event) => event.kind === "participant-joined");
    expect(joinEvent).toMatchObject({ participant: { golferId: host.golferId, name: placeholderName("sub-new") } });
  });
});

// Course-cards spec §4: StartRound resolves `command.course` (a reference) through the
// CardStore and freezes the CURRENT card VERBATIM into round-created — no translation, the
// no-translation invariant (spec invariant 3).
describe("StartRound — card resolution (course-cards spec §4)", () => {
  it("freezes the CardStore's current record.card VERBATIM into round-created — same object reference, not a copy", async () => {
    const ctx = await setup();
    await putAndBindGolfer(ctx.golferStore, ANN.id, ANN.sub, ANN.name);

    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });

    const genesis = await ctx.events(host.roundId, 0);
    const appendedRoundCreated = genesis.events[0];
    expect(appendedRoundCreated).toMatchObject({ kind: "round-created", card: ctx.cardRecord.card });
    // The no-translation invariant: the SAME object reference, not merely a deep-equal copy.
    expect((appendedRoundCreated as { card: unknown }).card).toBe(ctx.cardRecord.card);
  });

  it("rejects a cardId that is no longer CURRENT — card-superseded, nothing appended", async () => {
    const ctx = await setup();
    await putAndBindGolfer(ctx.golferStore, ANN.id, ANN.sub, ANN.name);
    // Supersede the lineage so ctx.course.cardId (the ORIGINAL card) is now stale.
    const superseding = { cardId: cardId("card-2"), courseId: ctx.course.courseId, card: fixtureLinks, enteredBy: ctx.cardRecord.enteredBy, enteredAtMs: 1, provenance: "community" as const, supersedes: ctx.course.cardId };
    await ctx.cardStore.supersede(superseding);

    await expect(ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub })).rejects.toMatchObject({
      code: "card-superseded",
    });
    // The card check runs BEFORE any id is minted or journal append attempted — proven here by
    // broadcast.publish (which only ever fires after a successful append) never having been called.
    expect(ctx.broadcast.calls).toHaveLength(0);
  });

  it("rejects an unknown courseId — course-not-found", async () => {
    const ctx = await setup();
    await putAndBindGolfer(ctx.golferStore, ANN.id, ANN.sub, ANN.name);

    await expect(
      ctx.start({ course: { courseId: courseId("nope"), cardId: cardId("nope-card") }, host: { tee: "white" } }, { sub: ANN.sub }),
    ).rejects.toMatchObject({ code: "course-not-found" });
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
    const ctx = await setup(createFrozenClock(1_000));
    await putAndBindGolfer(ctx.golferStore, ANN.id, ANN.sub, ANN.name);

    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });
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

// Accounts-only identity (spec §3): JoinRound is always as-self from the caller's Bearer — no
// name, no supplied golferId. The seat's golferId and frozen name come from the caller's own
// account golfer, and the join event freezes that name (sealed leaf).
describe("JoinRound — as-self only", () => {
  it("seats the caller's OWN account golfer, freezing its name into the participant event", async () => {
    const ctx = await setup();
    await seedAccounts(ctx.golferStore);
    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });

    const joined = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: BO.sub });
    expect(joined.golferId).toBe(BO.id);
    expect(joined.joinCode).toBe(host.joinCode);

    const boJoinedEvent = (await ctx.events(host.roundId, 3)).events[0];
    expect(boJoinedEvent).toMatchObject({ kind: "participant-joined", authorId: BO.id, participant: { golferId: BO.id, name: BO.name } });
    expect(ctx.tokens.verify(joined.token)).toEqual({ scope: "participant", roundId: host.roundId, golferId: BO.id });
  });

  // Brief Step 1: a placeholder-named account (never renamed on the profile) joins fine, and the
  // event carries the placeholder — the join is never gated on having a chosen name.
  it("a placeholder-named golfer joins fine and the event carries the placeholder", async () => {
    const ctx = await setup();
    await putAndBindGolfer(ctx.golferStore, ANN.id, ANN.sub, ANN.name);
    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });

    // Bo has only ever been minted (never PUT a real name), so his account carries the placeholder.
    const joined = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: "sub-placeholder" });

    const boJoinedEvent = (await ctx.events(host.roundId, 3)).events[0];
    expect(boJoinedEvent).toMatchObject({ kind: "participant-joined", participant: { golferId: joined.golferId, name: placeholderName("sub-placeholder") } });
  });

  it("rejects a re-tap from a golfer who is ALREADY a currently-seated participant — golfer-already-in-round", async () => {
    const round = await freshLiveRound(); // Ann (creator) + Bo already seated
    await expect(round.join({ code: round.host.joinCode, tee: "white" }, { sub: BO.sub })).rejects.toMatchObject({
      code: "golfer-already-in-round",
    });
  });

  // spec §4: rejoining is just joining again. A DEPARTED golfer is exempt from the re-tap guard —
  // a fresh participant-joined clears their `departed` flag in the fold.
  it("allows a rejoin after leaving (departed golfer is exempt from the re-tap guard)", async () => {
    const round = await freshLiveRound();
    const boClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.bo.golferId };

    await round.leave(boClaims);
    const rejoined = await round.join({ code: round.host.joinCode, tee: "white" }, { sub: BO.sub });

    expect(rejoined.golferId).toBe(BO.id);
    const events = (await round.events(round.host.roundId, 0)).events;
    // A participant-left then a later participant-joined for Bo — the fold clears `departed`.
    expect(events.filter((event) => event.kind === "participant-joined" && event.participant.golferId === BO.id)).toHaveLength(2);
    expect(reduceRound(events).participants.find((participant) => participant.golferId === BO.id)?.departed).not.toBe(true);
  });

  // The rejoin's other half (whole-branch review C1). Joining asks nothing about anyone's game
  // (spec §9), and the fold seats the LATEST join's payload (domain/round/state.ts step 4) — so a
  // rejoin writing a fresh 0 would silently erase a typed correction across every dot, every
  // standing and the sealed archive. The product advertises the flow it would break: RoundPage's
  // Leave confirm says "You can rejoin anytime with the round code."
  it("a rejoin carries the typed strokes forward — leaving and coming back never resets the seat to 0", async () => {
    const round = await freshLiveRound();
    const annClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    const boClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.bo.golferId };

    await round.setStrokes(annClaims, { golferId: BO.id, strokes: 16 });
    await round.leave(boClaims);
    await round.join({ code: round.host.joinCode, tee: "white" }, { sub: BO.sub });

    const events = (await round.events(round.host.roundId, 0)).events;
    // The EVENT states it, not just the fold: an event asserts what is true when it is written, so
    // the log stays self-contained and a replay anywhere (client, projector, archive) agrees.
    const boJoins = events.filter((event) => event.kind === "participant-joined" && event.participant.golferId === BO.id);
    expect(boJoins).toHaveLength(2);
    expect(boJoins.at(-1)).toMatchObject({ kind: "participant-joined", participant: { golferId: BO.id, strokes: 16 } });

    const seat = reduceRound(events).participants.find((participant) => participant.golferId === BO.id);
    expect(seat?.strokes).toBe(16);
    expect(seat?.departed).not.toBe(true);
    // Ann never left and never had a number typed — hers is untouched at the joining default.
    expect(reduceRound(events).participants.find((participant) => participant.golferId === ANN.id)?.strokes).toBe(0);
  });
});

// Presence (projection-realignment spec §5, Task 13): StartRound/JoinRound each write a LIVE
// pointer (rounds/presence.ts's writePresence) for the account golfer they seat — the creator
// for StartRound, the joiner for JoinRound. Every seat is an account now (accounts-only identity
// spec §3), so presence is always written under a real account golfer's identity.
describe("StartRound/JoinRound — presence (Task 13)", () => {
  it("StartRound writes a LIVE pointer for the creator, carrying the round's own courseName", async () => {
    const ctx = await setup();
    await putAndBindGolfer(ctx.golferStore, ANN.id, ANN.sub, ANN.name);
    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });

    const live = await ctx.projectionStore.listLive(host.golferId);
    expect(live).toEqual([{ roundId: host.roundId, courseName: fixtureLinks.courseName, joinedAtMs: expect.any(Number) }]);
  });

  it("JoinRound writes a LIVE pointer for the joiner", async () => {
    const ctx = await setup();
    await seedAccounts(ctx.golferStore);
    const host = await ctx.start({ course: ctx.course, host: { tee: "white" } }, { sub: ANN.sub });
    const bo = await ctx.join({ code: host.joinCode, tee: "white" }, { sub: BO.sub });

    const live = await ctx.projectionStore.listLive(bo.golferId);
    expect(live).toEqual([{ roundId: host.roundId, courseName: fixtureLinks.courseName, joinedAtMs: expect.any(Number) }]);
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
    await putAndBindGolfer(golferStore, ANN.id, ANN.sub, ANN.name);
    const cardStore = createInMemoryCardStore();
    const course = await seedCard(cardStore, CARD_REF.courseId, CARD_REF.cardId, fixtureLinks);
    const start = startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore: throwingStore, logger, cardStore });

    const host = await start({ course: { courseId: course.courseId, cardId: course.cardId }, host: { tee: "white" } }, { sub: ANN.sub });

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
    await putAndBindGolfer(golferStore, ANN.id, ANN.sub, ANN.name);
    await putAndBindGolfer(golferStore, BO.id, BO.sub, BO.name);
    const cardStore = createInMemoryCardStore();
    const course = await seedCard(cardStore, CARD_REF.courseId, CARD_REF.cardId, fixtureLinks);
    const start = startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore: throwingStore, logger, cardStore });
    const join = joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore: throwingStore, logger });

    const host = await start({ course: { courseId: course.courseId, cardId: course.cardId }, host: { tee: "white" } }, { sub: ANN.sub });
    const bo = await join({ code: host.joinCode, tee: "white" }, { sub: BO.sub });

    expect(bo.golferId).toBeDefined(); // the join succeeded — presence's own failure never propagated
    // 2 warnings: the creator's own StartRound presence write, then Bo's JoinRound one.
    expect(logger.warnings).toHaveLength(2);
    expect(logger.warnings.every((entry) => entry.message === "presence-write-failed")).toBe(true);
  });
});

describe("StartRound — metrics", () => {
  it("emits RoundsCreated once on a successful start", async () => {
    const journal = createInMemoryJournal();
    const store = createInMemoryRoundStore();
    const broadcast = createCapturingBroadcast();
    const tokens = createTestTokenIssuer();
    const clock = createFixedClock(1_000);
    const ids = createSequentialIds("t");
    const golferStore = createInMemoryGolferStore();
    await putAndBindGolfer(golferStore, ANN.id, ANN.sub, ANN.name);
    const projectionStore = createInMemoryProjectionStore();
    const logger = createNullLogger();
    const cardStore = createInMemoryCardStore();
    const course = await seedCard(cardStore, CARD_REF.courseId, CARD_REF.cardId, fixtureLinks);
    const metrics = createCapturingMetrics();
    const start = startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore, metrics });

    const host = await start({ course: { courseId: course.courseId, cardId: course.cardId }, host: { tee: "white" } }, { sub: ANN.sub });

    expect(host.roundId).toBeDefined();
    expect(metrics.calls).toEqual(["RoundsCreated"]);
  });
});

describe("recordScore — metrics", () => {
  it("counts LateScoreRefused when a NEW score is refused by a finalized round", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    await round.finalize(hostClaims);
    const annPhone = createClientOps("ann-phone");

    await expect(round.record(hostClaims, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...annPhone() })).rejects.toMatchObject({
      code: "round-not-live",
    });

    expect(round.metrics.calls).toEqual(["LateScoreRefused"]);
  });

  it("counts nothing for a RE-push of an already-recorded score — that score is not lost", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    const annPhone = createClientOps("ann-phone");
    const op = annPhone();
    await round.record(hostClaims, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...op });
    await round.finalize(hostClaims);

    await expect(round.record(hostClaims, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...op })).resolves.toEqual({ duplicate: true });

    expect(round.metrics.calls).toEqual([]);
  });
});
