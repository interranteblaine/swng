import { describe, expect, it } from "vitest";
import { cellKey, deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, HoleResult, OpId, RoundEvent } from "@swng/domain";
import { createMemoryOutboxStore } from "./outbox.js";
import { createRoundSession } from "./session.js";
import { TransportError } from "./transport.js";
import type { RoundTransport } from "./transport.js";

const ROUND_ID = roundId("round-1");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");
const SERVER_DEVICE = deviceId("server");

const toResult = (score: number | "picked-up"): HoleResult => (score === "picked-up" ? { kind: "picked-up" } : { kind: "strokes", strokes: score });

// The "server log" a fake transport serves — round-created + both golfers joined + a
// stableford game referencing them, mirroring what StartRound/JoinRound/AddGame would
// actually append (application/src/rounds/roundSlice.test.ts), built directly from domain
// primitives since @swng/client may only import @swng/domain + @swng/contracts (lint-enforced).
const buildServerLog = (extraGames: readonly GameConfig[] = []): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`server-op-${(opCounter += 1)}`);

  const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN_ID, BO_ID] };

  const events: RoundEvent[] = [
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", courseHandicap: 8 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: BO_ID, name: "Bo", tee: "white", courseHandicap: 2 }, authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: stableford, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    ...extraGames.map((config): RoundEvent => ({ kind: "game-added", config, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() })),
  ];
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
};

// A scripted, in-memory RoundTransport standing in for the server: push dedupes by opId
// (mirroring recordScore's use case), pull serves everything past `sinceSeq`, and a single
// opId can be pinned to always reject — the "permanent 409" test case. openSocket is unused
// by these tests (session.test.ts drives sync() directly); it returns a no-op closer so the
// object still satisfies RoundTransport.
interface ScriptedTransport extends RoundTransport {
  readonly log: readonly RoundEvent[];
  readonly pushedOpIds: readonly OpId[];
  rejectOpId: OpId | undefined;
}

const createScriptedTransport = (seed: readonly RoundEvent[]): ScriptedTransport => {
  const log: RoundEvent[] = [...seed];
  let nextSeq = log.length + 1;
  const pushedOpIds: OpId[] = [];

  const transport: ScriptedTransport = {
    log,
    pushedOpIds,
    rejectOpId: undefined,
    push: async (event) => {
      pushedOpIds.push(event.opId);
      if (transport.rejectOpId === event.opId) throw new TransportError("server", 409, "round-not-live");
      const existing = log.find((logged) => logged.opId === event.opId);
      if (existing) return { seq: existing.seq, duplicate: true };
      const stamped: RoundEvent = { ...event, seq: nextSeq };
      nextSeq += 1;
      log.push(stamped);
      return { seq: stamped.seq, duplicate: false };
    },
    pull: async (sinceSeq) => {
      const events = log.filter((event) => (event.seq ?? 0) > sinceSeq);
      const maxSeq = events.reduce((max, event) => Math.max(max, event.seq ?? 0), sinceSeq);
      return { events, nextSeq: maxSeq };
    },
    openSocket: () => () => {},
  };
  return transport;
};

describe("createRoundSession", () => {
  it("reflects an optimistic recordScore in state() immediately, authored by this session's golfer", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync(); // ingest genesis + joins + game

    session.recordScore(ANN_ID, 1, toResult(5));

    const cell = session.state().cells[cellKey(ANN_ID, 1)];
    expect(cell).toMatchObject({ result: { kind: "strokes", strokes: 5 }, recordedBy: ANN_ID });
  });

  it("drives the M2 stableford golden card through recordScore and scores 15/19 once the game is ingested", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync();

    const annScores: readonly (number | "picked-up")[] = [5, 6, 3, "picked-up", 5, 4, 5, 6, 5];
    const boScores: readonly number[] = [4, 4, 3, 5, 5, 3, 4, 5, 4];
    for (let hole = 1; hole <= 9; hole += 1) {
      session.recordScore(ANN_ID, hole, toResult(annScores[hole - 1]!));
      session.recordScore(BO_ID, hole, toResult(boScores[hole - 1]!)); // score-for-anyone, from one session
    }

    const stableford = session.games().find((game) => game.kind === "stableford");
    expect(stableford).toMatchObject({
      lines: expect.arrayContaining([
        expect.objectContaining({ golferId: ANN_ID, points: 15 }),
        expect.objectContaining({ golferId: BO_ID, points: 19 }),
      ]),
    });
  });

  it("does not throw from games() on an unknown game kind, and still scores the known games", async () => {
    const unknownGame = { kind: "wolf-9000", id: gameId("game-unknown") } as unknown as GameConfig;
    const transport = createScriptedTransport(buildServerLog([unknownGame]));
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync();

    let games: ReturnType<typeof session.games> = [];
    expect(() => {
      games = session.games();
    }).not.toThrow();

    const kinds = games.map((game) => game.kind);
    expect(kinds).toContain("stableford");
    expect(kinds).not.toContain("wolf-9000");
  });

  it("keeps state() deep-equal before and after the outbox prunes a confirmed duplicate", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync();

    session.recordScore(ANN_ID, 1, toResult(5));
    const beforePrune = session.state();
    expect(session.pending()).toBe(1);

    await session.sync(); // pushes the event (confirms it server-side), pulls it back, prunes the outbox

    expect(session.pending()).toBe(0);
    expect(session.state()).toEqual(beforePrune);
  });

  it("pending() reflects the outbox depth as scores are recorded and confirmed", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync();
    expect(session.pending()).toBe(0);

    session.recordScore(ANN_ID, 1, toResult(4));
    session.recordScore(ANN_ID, 2, toResult(5));
    expect(session.pending()).toBe(2);

    await session.sync();
    expect(session.pending()).toBe(0);
  });

  it("moves a permanently-rejected op into rejected() and drops it from the outbox, without blocking the rest", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync();

    session.recordScore(ANN_ID, 1, toResult(4));
    session.recordScore(ANN_ID, 2, toResult(5));
    const rejectedEventOpId = session.state().cells[cellKey(ANN_ID, 1)]!.opId;
    transport.rejectOpId = rejectedEventOpId;

    await session.sync();

    expect(session.pending()).toBe(0); // the good op still went through; the bad one didn't wedge it
    expect(session.rejected()).toHaveLength(1);
    expect(session.rejected()[0]).toMatchObject({ code: "round-not-live" });
    expect(session.rejected()[0]!.event.opId).toBe(rejectedEventOpId);
  });

  it("never re-mints an opId across a restart sharing the same store", async () => {
    const store = createMemoryOutboxStore();
    const deviceIdValue = deviceId("ann-phone");
    const seed = buildServerLog();

    // Session 1 never syncs (goes straight from launch to scoring, offline the whole
    // time) — so the persisted cursor stays at 0. That keeps this test focused on its one
    // concern, opCounter continuity: full state reconstruction after a restart whose
    // cursor had already advanced past genesis is a known v1 gap (confirmed events are
    // never persisted — "derive, don't store" — and no test in this plan exercises that
    // combination), not something this test is trying to prove.
    const transport1 = createScriptedTransport(seed);
    const session1 = await createRoundSession({ transport: transport1, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceIdValue });
    session1.recordScore(ANN_ID, 1, toResult(4));
    session1.recordScore(ANN_ID, 2, toResult(5));
    await session1.close();

    const transport2 = createScriptedTransport(seed);
    const session2 = await createRoundSession({ transport: transport2, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceIdValue });
    await session2.sync(); // pushes session1's queued ops, pulls the full log back (cursor was 0)
    session2.recordScore(ANN_ID, 3, toResult(3));

    // The restarted session's opCounter resumed from 2 (persisted), not 0 — its new opId
    // does not collide with either opId session1 already minted.
    expect(session2.state().cells[cellKey(ANN_ID, 1)]!.opId).toBe(opId(`${deviceIdValue}-1`));
    expect(session2.state().cells[cellKey(ANN_ID, 2)]!.opId).toBe(opId(`${deviceIdValue}-2`));
    expect(session2.state().cells[cellKey(ANN_ID, 3)]!.opId).toBe(opId(`${deviceIdValue}-3`));
  });

  it("notifies onChange listeners exactly once per ingest batch", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

    let notifications = 0;
    const unsubscribe = session.onChange(() => {
      notifications += 1;
    });

    await session.sync(); // one pull batch (nothing pending to push)
    expect(notifications).toBe(1);

    unsubscribe();
    await session.sync();
    expect(notifications).toBe(1); // unsubscribed — no further notifications
  });
});
