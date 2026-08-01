import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellKey, deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, HoleResult, OpId, RoundEvent } from "@swng/domain";
import { createMemoryOutboxStore } from "./outbox.js";
import type { OutboxStore, PersistedSync } from "./outbox.js";
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
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", strokes: 3 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: BO_ID, name: "Bo", tee: "white", strokes: 0 }, authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: stableford, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    ...extraGames.map((config): RoundEvent => ({ kind: "game-added", config, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() })),
  ];
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
};

// A scripted, in-memory RoundTransport standing in for the server: push dedupes by opId
// (mirroring recordScore's use case), pull serves everything past `sinceSeq`, and a single
// opId can be pinned to always reject — the "permanent 409" test case. `offline` flips both
// push and pull to a network TransportError, for the offline-burst tests. openSocket keeps
// the single most recently registered listener so a test can drive it directly:
// `emitSocketEvents` simulates a server broadcast, `triggerSocketClose` simulates the
// connection dropping — both needed for the socket-lifecycle and duplicate-delivery tests.
interface ScriptedTransport extends RoundTransport {
  readonly log: readonly RoundEvent[];
  readonly pushedOpIds: readonly OpId[];
  rejectOpId: OpId | undefined;
  offline: boolean;
  emitSocketEvents(events: readonly RoundEvent[]): void;
  triggerSocketClose(): void;
}

const createScriptedTransport = (seed: readonly RoundEvent[]): ScriptedTransport => {
  const log: RoundEvent[] = [...seed];
  let nextSeq = log.length + 1;
  const pushedOpIds: OpId[] = [];
  let socketListener: { onEvents: (events: readonly RoundEvent[]) => void; onClose: () => void } | undefined;

  const transport: ScriptedTransport = {
    log,
    pushedOpIds,
    rejectOpId: undefined,
    offline: false,
    push: async (event) => {
      if (transport.offline) throw new TransportError("network");
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
      if (transport.offline) throw new TransportError("network");
      const events = log.filter((event) => (event.seq ?? 0) > sinceSeq);
      const maxSeq = events.reduce((max, event) => Math.max(max, event.seq ?? 0), sinceSeq);
      return { events, nextSeq: maxSeq };
    },
    openSocket: (onEvents, onClose, onOpen) => {
      socketListener = { onEvents, onClose };
      onOpen?.(); // this scripted transport's socket "opens" synchronously, right after registering — realistic enough for every test here except the one that deliberately overrides this method to defer it
      return () => {
        if (socketListener?.onEvents === onEvents) socketListener = undefined;
      };
    },
    emitSocketEvents: (events) => {
      socketListener?.onEvents(events);
    },
    triggerSocketClose: () => {
      const listener = socketListener;
      socketListener = undefined;
      listener?.onClose();
    },
  };
  return transport;
};

// Defers a scripted transport's NEXT pull() call until `release()` is invoked, then
// restores normal (immediate) pulling for every call after that. Used to force a real
// overlap between two sync-loop triggers — an await gap a test can land a second trigger
// inside of — without relying on incidental timing.
const withDeferredNextPull = (transport: ScriptedTransport): { release: () => void } => {
  const originalPull = transport.pull.bind(transport);
  let resolveGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  transport.pull = async (sinceSeq: number) => {
    await gate;
    transport.pull = originalPull;
    return originalPull(sinceSeq);
  };
  return { release: () => resolveGate?.() };
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

  it("drives the M2 stableford golden card through recordScore and scores 10/17 once the game is ingested", async () => {
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
        expect.objectContaining({ golferId: ANN_ID, points: 10 }),
        expect.objectContaining({ golferId: BO_ID, points: 17 }),
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

  it("surfaces a terminal, non-scorable state once the round is abandoned", async () => {
    // The server log ends with a round-abandoned event — the scrapped-round terminal state a
    // client lands on by pulling (task-15: another participant scrapped the round). The fold
    // handles the new kind by the append-only rule — nothing in @swng/client's own known-set is
    // event-kind-specific (KNOWN_GAME_KINDS filters GAME kinds only), so it just flows through
    // reduceRound like every other lifecycle event.
    const liveLog = buildServerLog();
    const abandoned: RoundEvent = {
      kind: "round-abandoned",
      authorId: ANN_ID,
      opId: opId("server-abandon"),
      hlc: { wallMs: 9_000, counter: 0, deviceId: SERVER_DEVICE },
      seq: liveLog.length + 1,
    };
    const transport = createScriptedTransport([...liveLog, abandoned]);
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync();

    // Terminal: the fold reports the scrapped status the UI reads to stop offering scoring — and
    // games() still renders without throwing (a terminal round is displayable, just not editable).
    expect(session.state().status).toBe("abandoned");
    expect(() => session.games()).not.toThrow();

    // Non-scorable in practice: the client never gates recordScore on status (the server is the
    // authority), so a score still queues optimistically — but the server refuses it on a
    // scrapped round (round-not-live), and that permanent rejection lands in rejected() rather
    // than sticking in the outbox forever.
    transport.rejectOpId = opId("ann-phone-1");
    session.recordScore(ANN_ID, 1, toResult(5));
    await session.sync();

    expect(session.rejected().map((rejected) => rejected.code)).toContain("round-not-live");
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

describe("createRoundSession — sync + reconnect", () => {
  it("(a) offline burst: recordScore queues while the transport is down; sync() drains oldest-first once it returns, unchanged by the round trip", async () => {
    const annPhone = deviceId("ann-phone");
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: annPhone });
    await session.sync(); // ingest genesis while still online

    transport.offline = true;
    session.recordScore(ANN_ID, 1, toResult(4));
    session.recordScore(ANN_ID, 2, toResult(5));
    session.recordScore(ANN_ID, 3, toResult(3));
    expect(session.pending()).toBe(3);

    const beforeRoundTrip = session.state();
    await expect(session.sync()).resolves.toBeUndefined(); // offline is not an error — the queue IS the feature
    expect(session.pending()).toBe(3); // nothing lost
    expect(session.state()).toEqual(beforeRoundTrip);

    transport.offline = false;
    await session.sync();

    expect(transport.pushedOpIds).toEqual([opId(`${annPhone}-1`), opId(`${annPhone}-2`), opId(`${annPhone}-3`)]); // author order
    expect(session.pending()).toBe(0);
    expect(session.state()).toEqual(beforeRoundTrip); // unchanged by the round trip (now confirmed, not pending)
  });

  it("(b) interleaved remote events: a pull-observed remote hlc, plausibly ahead of the local clock, is beaten by a subsequent local correction to the same cell", async () => {
    const boPhone = deviceId("bo-phone");
    const seed = buildServerLog();
    const remoteScore: RoundEvent = {
      kind: "score-recorded",
      opId: opId(`${boPhone}-1`),
      hlc: { wallMs: 50_000, counter: 0, deviceId: boPhone }, // far ahead of the local clock below
      authorId: BO_ID,
      golferId: BO_ID,
      hole: 5,
      result: toResult(4),
    };
    const transport = createScriptedTransport([...seed, { ...remoteScore, seq: seed.length + 1 }]);

    const session = await createRoundSession({
      transport,
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceId("ann-phone"),
      clock: { now: () => 100 }, // skewed far behind the remote author — observe() is load-bearing
    });

    session.recordScore(ANN_ID, 1, toResult(2)); // this device's own cell, still pending
    await session.sync(); // pulls genesis + bo-phone's remote score; observes its hlc

    // Both devices' cells present after ingest.
    expect(session.state().cells[cellKey(ANN_ID, 1)]).toBeDefined();
    expect(session.state().cells[cellKey(BO_ID, 5)]).toMatchObject({ result: toResult(4), recordedBy: BO_ID });

    session.recordScore(BO_ID, 5, toResult(9)); // score-for-anyone: a local correction to the SAME cell the remote just wrote

    const winner = session.state().cells[cellKey(BO_ID, 5)];
    expect(winner?.result).toEqual(toResult(9)); // the local correction wins the fold, proving observe() floored this device past the remote hlc
    expect(winner?.recordedBy).toBe(ANN_ID); // authored by this session even though scoring BO's cell
  });

  it("(c) duplicate wire delivery: the same confirmed event arriving via socket AND pull is a silent no-op — zero notifies, zero saves (M5: supersedes M4's notify-per-batch)", async () => {
    const transport = createScriptedTransport(buildServerLog());
    let saveCount = 0;
    const store: OutboxStore = {
      load: async () => undefined,
      save: async () => {
        saveCount += 1;
      },
    };
    const session = await createRoundSession({ transport, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

    session.connect(); // registers the scripted transport's socket listener (needed below)
    await session.sync(); // catch-up: ingest genesis

    session.recordScore(ANN_ID, 1, toResult(4)); // connected: also fires its own opportunistic sync
    await session.sync(); // join/await it — the score is pushed AND pulled back (confirmed), pruned from the outbox
    expect(session.pending()).toBe(0);

    const confirmedEvent = transport.log.find((event) => event.kind === "score-recorded" && event.golferId === ANN_ID && event.hole === 1)!;

    let notifications = 0;
    session.onChange(() => {
      notifications += 1;
    });
    const beforeDuplicate = session.state();
    const saveCountBeforeDuplicates = saveCount;

    transport.emitSocketEvents([confirmedEvent]); // "arrives via socket" — an already-confirmed event, redelivered
    expect(notifications).toBe(0); // pure duplicate: nothing newly confirmed, nothing pruned, cursor unchanged — silent
    expect(session.state()).toEqual(beforeDuplicate);

    await session.sync(); // "arrives via pull" too — push is a no-op (nothing pending), pull returns nothing new (cursor already past it)
    expect(notifications).toBe(0); // still silent — the pull's own batch is equally a no-op
    expect(session.state()).toEqual(beforeDuplicate); // deduped by opId: no change from the duplicate delivery
    expect(saveCount).toBe(saveCountBeforeDuplicates); // neither duplicate ingest triggered a persist
  });

  it("(d) socket lifecycle: connect opens and catches up, socket events ingest live, close flips connected(), reconnect + sync converges on what the closed socket missed", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

    expect(session.connected()).toBe(false);
    session.connect();
    expect(session.connected()).toBe(true);
    await session.sync(); // join/await the catch-up sync connect() triggered
    expect(session.state().participants).toHaveLength(2); // genesis pulled via the catch-up

    // A remote device's score arrives live over the socket.
    const live: RoundEvent = { kind: "score-recorded", opId: opId("bo-phone-1"), hlc: { wallMs: 9_000, counter: 0, deviceId: deviceId("bo-phone") }, authorId: BO_ID, golferId: BO_ID, hole: 1, result: toResult(4) };
    const livePush = await transport.push(live);
    transport.emitSocketEvents([{ ...live, seq: livePush.seq! }]);
    expect(session.state().cells[cellKey(BO_ID, 1)]).toBeDefined();

    transport.triggerSocketClose(); // the server drops the connection
    expect(session.connected()).toBe(false);

    // Another device scores while this session's socket is down — only a re-pull can catch it up.
    const missed: RoundEvent = { kind: "score-recorded", opId: opId("bo-phone-2"), hlc: { wallMs: 9_500, counter: 0, deviceId: deviceId("bo-phone") }, authorId: BO_ID, golferId: BO_ID, hole: 2, result: toResult(5) };
    await transport.push(missed);

    session.connect(); // reconnect
    expect(session.connected()).toBe(true);
    await session.sync(); // converge: pulls what the closed socket missed

    expect(session.state().cells[cellKey(BO_ID, 2)]).toMatchObject({ result: toResult(5) });
  });

  it("connect()'s onOpen callback (not just the redundant connect-time sync) fetches an event that lands between the connect-time pull and the real socket's actual open", async () => {
    const transport = createScriptedTransport(buildServerLog());

    // Defer the transport's onOpen invocation under test control, standing in for a real
    // WebSocket whose "open" event fires asynchronously — well after connect() returns and
    // after the connect-time sync's own pull has already completed. That gap is exactly the
    // race Fix 2 closes: events landing in it must still be caught by the SOCKET-OPEN path,
    // not merely by the (redundant, immediate) connect-time sync. onOpen is deliberately NOT
    // forwarded to the real registration below — the socket "hasn't opened yet".
    let deferredOnOpen: (() => void) | undefined;
    const registerSocket = transport.openSocket;
    transport.openSocket = (onEvents: (events: readonly RoundEvent[]) => void, onClose: () => void, onOpen?: () => void) => {
      deferredOnOpen = onOpen;
      return registerSocket(onEvents, onClose);
    };

    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

    session.connect(); // registers the (still-connecting) socket; fires the connect-time sync
    await session.sync(); // join/await that connect-time sync's pull — completes with just genesis

    // A new event lands server-side AFTER the connect-time sync's pull already completed,
    // but BEFORE the real socket has actually opened.
    const late: RoundEvent = { kind: "score-recorded", opId: opId("bo-phone-late"), hlc: { wallMs: 9_000, counter: 0, deviceId: deviceId("bo-phone") }, authorId: BO_ID, golferId: BO_ID, hole: 3, result: toResult(4) };
    await transport.push(late);

    expect(session.state().cells[cellKey(BO_ID, 3)]).toBeUndefined(); // invisible via either path so far

    deferredOnOpen?.(); // the real socket's "open" event finally fires
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the onOpen-triggered sync, through the serialized gate

    // Picked up without any explicit sync() call from the test after the open.
    expect(session.state().cells[cellKey(BO_ID, 3)]).toMatchObject({ result: toResult(4) });
  });

  it("(e) a permanent 409 mid-queue drops only that entry into rejected() and still pushes the rest", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
    await session.sync();

    session.recordScore(ANN_ID, 1, toResult(4));
    session.recordScore(ANN_ID, 2, toResult(5));
    session.recordScore(ANN_ID, 3, toResult(3));
    const middleOpId = session.state().cells[cellKey(ANN_ID, 2)]!.opId;
    transport.rejectOpId = middleOpId;

    await session.sync();

    expect(session.pending()).toBe(0); // the two good ops went through; the bad one didn't wedge the queue
    expect(session.rejected()).toHaveLength(1);
    expect(session.rejected()[0]!.event.opId).toBe(middleOpId);
    expect(session.state().cells[cellKey(ANN_ID, 1)]).toBeDefined();
    expect(session.state().cells[cellKey(ANN_ID, 3)]).toBeDefined();
    expect(session.state().cells[cellKey(ANN_ID, 2)]).toBeUndefined(); // the rejected score never landed
  });

  it("(g) restart HLC floor: a persisted pending event's hlc, far ahead of the restarted session's clock, still loses to a post-restart correction to the SAME cell", async () => {
    const deviceIdValue = deviceId("ann-phone");
    const store = createMemoryOutboxStore();

    // Everything this device knows locally, entirely unconfirmed (confirmed is never
    // persisted — only `pending` survives a restart) — genesis included, so state() can
    // fold without any network call in this test. The final event is the one under test:
    // its hlc.wallMs is far ahead of what a freshly constructed HlcSource would mint (the
    // restarted session's clock below is pinned far behind it) — modeling either a prior
    // session that floored on a skewed-ahead peer, or a device clock that regressed across
    // the restart. Without observing it at construction, a post-restart correction to the
    // same cell mints an hlc that compares LESS than this stale pending event, so LWW would
    // keep the stale value forever.
    const seed = buildServerLog();
    const staleEvent: RoundEvent = {
      kind: "score-recorded",
      opId: opId(`${deviceIdValue}-1`),
      hlc: { wallMs: 50_000, counter: 0, deviceId: deviceIdValue },
      authorId: ANN_ID,
      golferId: BO_ID,
      hole: 5,
      result: toResult(4),
    };
    await store.save(ROUND_ID, { pending: [...seed, staleEvent], lastSeq: 0, opCounter: 1, rejected: [] });

    const transport = createScriptedTransport([]); // never touched — this test never syncs
    const session = await createRoundSession({
      transport,
      store,
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceIdValue,
      clock: { now: () => 100 }, // far behind staleEvent's hlc — observing it at construction is load-bearing
    });

    session.recordScore(BO_ID, 5, toResult(9)); // post-restart correction to the SAME cell

    const winner = session.state().cells[cellKey(BO_ID, 5)];
    expect(winner?.result).toEqual(toResult(9)); // the correction must win the fold, not the stale pending value
  });

  it("(f) restart reconstruction: a second session over the same store re-derives the FULL round, not a since-cursor suffix", async () => {
    const deviceIdValue = deviceId("ann-phone");
    const seed = buildServerLog();
    const store = createMemoryOutboxStore();

    const transport1 = createScriptedTransport(seed);
    const session1 = await createRoundSession({ transport: transport1, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceIdValue });
    await session1.sync(); // cursor advances past genesis; confirmed events are never persisted
    const session1State = session1.state();
    await session1.close();

    // A fresh transport instance over the SAME server log — "app restarted", new HTTP
    // client, same server — sharing only the persisted OutboxStore with session1.
    const transport2 = createScriptedTransport(seed);
    const session2 = await createRoundSession({ transport: transport2, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceIdValue });
    await session2.sync();

    expect(session2.state()).toEqual(session1State);
  });
});

describe("createRoundSession — M5 Task 1: hydrated(), games() identity, close() quiescence", () => {
  describe("hydrated()", () => {
    it("is false on a fresh session, state()/games() throw until a pull ingests genesis, and it never regresses afterward", async () => {
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

      expect(session.hydrated()).toBe(false);
      expect(() => session.state()).toThrow(); // reduceRound refuses to fold a log with no round-created event
      expect(() => session.games()).toThrow(); // games() folds through the same computeState()

      await session.sync(); // first pull ingests genesis (round-created among the events)

      expect(session.hydrated()).toBe(true);
      expect(() => session.state()).not.toThrow();

      // A later, unrelated ingest must not flip it back.
      session.recordScore(ANN_ID, 1, toResult(4));
      await session.sync();
      expect(session.hydrated()).toBe(true);
    });

    it("is true immediately once genesis arrives over the socket, even while the connect-time catch-up pull is still in flight", async () => {
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

      const gate = withDeferredNextPull(transport); // block connect()'s own catch-up pull
      session.connect(); // registers the socket listener; also fires the (now-blocked) catch-up sync

      expect(session.hydrated()).toBe(false); // neither the blocked pull nor the socket has delivered anything yet

      const genesisEvent = transport.log.find((event) => event.kind === "round-created")!;
      transport.emitSocketEvents([genesisEvent]); // genesis arrives live over the socket, ahead of the still-blocked pull

      expect(session.hydrated()).toBe(true); // hydrated from the socket batch alone — no pull needed
      expect(() => session.state()).not.toThrow();

      gate.release();
      await session.sync(); // let the blocked pull settle so it doesn't leak into a later test
    });
  });

  describe("games() identity", () => {
    it("returns the same reference across calls with no change, and a new reference after a recordScore", async () => {
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
      await session.sync();

      const first = session.games();
      const second = session.games();
      expect(second).toBe(first); // useSyncExternalStore treats a fresh reference as "store changed" — must not happen absent a real change

      session.recordScore(ANN_ID, 1, toResult(4));
      const third = session.games();
      expect(third).not.toBe(first); // state changed — a fresh reference is required
    });
  });

  describe("close() quiescence", () => {
    it("awaits an in-flight sync pass before its final persist — no save lands after close() resolves", async () => {
      const transport = createScriptedTransport(buildServerLog());
      let saveCount = 0;
      const store: OutboxStore = {
        load: async () => undefined,
        save: async () => {
          saveCount += 1;
        },
      };
      const session = await createRoundSession({ transport, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
      await session.sync(); // hydrate

      session.recordScore(ANN_ID, 1, toResult(4));
      const gate = withDeferredNextPull(transport);
      const syncPromise = session.sync(); // starts an in-flight pass: pushes hole 1, then blocks on the deferred pull

      let closeResolved = false;
      const closePromise = session.close().then(() => {
        closeResolved = true;
      });

      // The pass is still blocked on its pull — close() must not resolve while it's in flight.
      await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 20))]);
      expect(closeResolved).toBe(false);

      const saveCountBeforeRelease = saveCount;
      gate.release();
      await closePromise;
      await syncPromise; // the pass close() was awaiting also settles from the caller's own perspective

      expect(closeResolved).toBe(true);
      expect(saveCount).toBeGreaterThan(saveCountBeforeRelease); // both the pass's own save and close()'s final save landed

      const saveCountAtCloseResolve = saveCount;
      await new Promise((resolve) => setTimeout(resolve, 20)); // flush anything stray
      expect(saveCount).toBe(saveCountAtCloseResolve); // nothing saved after close() resolved
    });
  });
});

describe("createRoundSession — sync loop hardening (Task 3 required items 1 & 2)", () => {
  describe("item 1: the sync loop is serialized (single in-flight pass + coalesced rerun)", () => {
    it("a recordScore landing mid-sync() is picked up by the trailing run, without the leading run's older op being pushed twice", async () => {
      const annPhone = deviceId("ann-phone");
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: annPhone });

      session.recordScore(ANN_ID, 1, toResult(4)); // an "older" op, queued before connect(), not yet pushed
      const gate = withDeferredNextPull(transport);

      session.connect(); // starts the leading pass: pushes hole 1, then blocks on the deferred pull

      // Land a new op WHILE the leading pass is stuck awaiting its pull. connectedFlag is
      // now true, so this also fires its own opportunistic trigger — both this and the
      // explicit sync() below must coalesce onto a single trailing pass.
      session.recordScore(ANN_ID, 2, toResult(5));
      const syncPromise = session.sync();

      gate.release(); // let the leading pass's pull resolve; it should then run exactly one more pass

      await syncPromise;

      expect(transport.pushedOpIds).toEqual([opId(`${annPhone}-1`), opId(`${annPhone}-2`)]); // each pushed exactly once
      expect(session.pending()).toBe(0);
      expect(session.state().cells[cellKey(ANN_ID, 1)]).toBeDefined();
      expect(session.state().cells[cellKey(ANN_ID, 2)]).toBeDefined();
    });

    it("a permanent rejection under overlapping sync() triggers yields exactly one rejected() entry for that op", async () => {
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
      await session.sync();

      session.recordScore(ANN_ID, 1, toResult(4));
      const rejectedOpId = session.state().cells[cellKey(ANN_ID, 1)]!.opId;
      transport.rejectOpId = rejectedOpId;

      // Two overlapping triggers, no await between them — without the gate, each would
      // independently snapshot `pending` and push (and reject) the same op separately.
      const first = session.sync();
      const second = session.sync();
      await Promise.all([first, second]);

      expect(session.rejected()).toHaveLength(1); // not two
      expect(transport.pushedOpIds.filter((id) => id === rejectedOpId)).toHaveLength(1); // pushed (and rejected) exactly once
    });
  });

  describe("item 2: a failing OutboxStore.save() cannot poison the save chain or vanish", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    const alwaysFailingStore: OutboxStore = {
      load: async () => undefined,
      save: async () => {
        throw new Error("simulated store failure (quota exceeded)");
      },
    };

    it("recordScore and sync() tolerate a persistently failing store without throwing or emitting an unhandled rejection", async () => {
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, store: alwaysFailingStore, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

      expect(() => session.recordScore(ANN_ID, 1, toResult(4))).not.toThrow();
      await expect(session.sync()).resolves.toBeUndefined();

      // In-memory state stays authoritative regardless of the store's outcome.
      expect(session.state().cells[cellKey(ANN_ID, 1)]).toBeDefined();

      // No Node `process` global is available in this browser-safe package's test typing
      // (layer law), so this test can't hook `unhandledRejection` directly — but Vitest
      // itself catches an unhandled rejection surfacing anywhere during a test run and
      // fails that run (proven earlier, pre-fix: this exact scenario produced a top-level
      // "Unhandled Rejection" failure). A flush past the failing save's microtask, plus
      // asserting the failure WAS reported via console.warn, is sufficient: absence of a
      // vitest-level failure here plus a present warnSpy call together mean the rejection
      // was handled, not merely delayed or silently dropped.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnSpy).toHaveBeenCalled(); // reported, not silently dropped
    });

    it("keeps attempting later saves after an earlier save failure, instead of skipping them forever", async () => {
      let saveCount = 0;
      const saveSnapshots: PersistedSync[] = [];
      const store: OutboxStore = {
        load: async () => undefined,
        save: async (_roundId, snapshot) => {
          saveCount += 1;
          saveSnapshots.push(snapshot);
          if (saveCount === 1) throw new Error("simulated transient store failure");
        },
      };
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

      session.recordScore(ANN_ID, 1, toResult(4)); // persist #1 — fails
      session.recordScore(ANN_ID, 2, toResult(5)); // persist #2 — must still be ATTEMPTED, not skipped by a poisoned chain

      // Let both fire-and-forget persist() chains settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(saveCount).toBeGreaterThanOrEqual(2);
      expect(saveSnapshots.at(-1)?.pending).toHaveLength(2); // the latest attempted save reflects the up-to-date snapshot
    });

    it("close() rejects when the final save fails", async () => {
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, store: alwaysFailingStore, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

      await expect(session.close()).rejects.toThrow("simulated store failure");
    });
  });
});

describe("createRoundSession — review fixes: throwing passes must not strand or leak", () => {
  it("finding 1: a rerun waiter queued mid-pass is rejected (not orphaned) when that pass throws a non-TransportError", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });

    // Simulates transport.ts's parse(...) throwing a ContractError on a malformed server
    // response — a real, non-TransportError failure mode the pull path can hit.
    const boom = new Error("malformed server response");
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    transport.pull = async () => {
      await gate;
      throw boom;
    };

    const passA = session.sync(); // leading pass: pushPending is a no-op, then blocks on the gated pull

    // Land a second sync() call WHILE pass A is still stuck awaiting its pull — this queues
    // a rerun waiter onto syncRerunWaiters mid-iteration, after that iteration's snapshot
    // was already taken.
    const passB = session.sync();

    resolveGate?.(); // let pass A's pull reject with a non-TransportError

    await expect(passA).rejects.toBe(boom);

    // Before the fix, passB's waiter is orphaned and never settles — the throwing iteration
    // only rejected its pre-throw snapshot of syncRerunWaiters, not the one queued during the
    // await. Race against a bounded timer so a regression fails fast instead of hanging the
    // runner.
    const settled = await Promise.race([
      passB.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);
    expect(settled).toBe("rejected");
    await expect(passB).rejects.toBe(boom);
  });

  describe("finding 2: opportunistic fire-and-forget sync sites warn-and-drop instead of leaking a rejection", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("recordScore's opportunistic push doesn't emit an unhandled rejection when the pass throws a non-TransportError, and warns instead", async () => {
      const transport = createScriptedTransport(buildServerLog());
      const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("ann-phone") });
      session.connect();
      await session.sync(); // let the catch-up settle so recordScore's own opportunistic sync is isolated

      transport.push = async () => {
        throw new Error("malformed server response");
      };

      // Vitest itself fails the run with an "Unhandled Rejection" if requestSync()'s
      // rejection at this fire-and-forget call site weren't caught — same detection this
      // suite already relies on in the persistence-failure tests above (`item 2`).
      expect(() => session.recordScore(ANN_ID, 1, toResult(4))).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 0)); // flush past the rejected opportunistic sync
      expect(warnSpy).toHaveBeenCalled(); // reported, not silently dropped
    });
  });
});

// A store whose load() returns a record written BEFORE `rejected` existed. The cast is the
// point of the fixture: it reproduces exactly what a real browser's IndexedDB holds for any
// round a golfer opened before this change shipped.
const legacyStore = (sync: Omit<PersistedSync, "rejected">): OutboxStore => ({
  load: async () => sync as PersistedSync,
  save: async () => {},
});

describe("createRoundSession — rejected ops are durable", () => {
  it("seeds rejected() from the store, so a permanently refused score survives a reload", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const store = createMemoryOutboxStore();
    const refused: RoundEvent = {
      kind: "score-recorded",
      opId: opId("device-a-1"),
      hlc: { wallMs: 1_000, counter: 0, deviceId: deviceId("device-a") },
      authorId: ANN_ID,
      golferId: ANN_ID,
      hole: 1,
      result: toResult(4),
    };
    await store.save(ROUND_ID, { pending: [], lastSeq: 0, opCounter: 1, rejected: [{ event: refused, code: "round-not-live" }] });

    const session = await createRoundSession({ transport, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("device-a") });

    expect(session.rejected()).toEqual([{ event: refused, code: "round-not-live" }]);
  });

  it("persists a rejection, so the score is still on the device after a restart", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const store = createMemoryOutboxStore();
    const session = await createRoundSession({ transport, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("device-a") });

    transport.rejectOpId = opId("device-a-1");
    session.recordScore(ANN_ID, 1, toResult(4));
    await session.sync();
    await session.close();

    const restarted = await createRoundSession({ transport, store, roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("device-a") });

    expect(restarted.rejected()).toHaveLength(1);
    expect(restarted.rejected()[0]!.event.opId).toBe(opId("device-a-1"));
  });

  it("tolerates a record written before `rejected` existed — starts empty, never throws", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await createRoundSession({
      transport,
      store: legacyStore({ pending: [], lastSeq: 0, opCounter: 3 }),
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceId("device-a"),
    });

    expect(session.rejected()).toEqual([]);
  });
});

describe("createRoundSession — the outbox drains itself", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const liveSession = async (transport: ScriptedTransport) =>
    createRoundSession({ transport, store: createMemoryOutboxStore(), roundId: ROUND_ID, golferId: ANN_ID, deviceId: deviceId("device-a") });

  it("drains a queue built while offline once the network returns — with no sync() call and no button", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    session.connect();
    await vi.advanceTimersByTimeAsync(0);

    transport.offline = true;
    session.recordScore(ANN_ID, 1, toResult(4));
    session.recordScore(ANN_ID, 2, toResult(5));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.pending()).toBe(2); // still offline: the queue holds

    transport.offline = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.pending()).toBe(0);
  });

  it("backs off on consecutive failures and reports stalled() at the cap", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    transport.offline = true;
    session.connect();
    // A queued score is what makes the session dirty, and it is the defect this whole arc
    // closes: an outbox with something in it that cannot leave the phone. Without it there is
    // nothing a retry could accomplish (isDirty() is false), so no timer is scheduled and no
    // backoff climbs — correctly, since an empty outbox under a live socket is not stuck.
    session.recordScore(ANN_ID, 1, toResult(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.stalled()).toBe(false);

    // Four consecutive failures drive the delay 2s → 4s → 8s → 16s → the 30s cap, which is what
    // stalled() reports. Advanced well past the point where that lands rather than up to it:
    // connect() fires two triggers of its own, so the exact wall-clock arrival depends on how
    // many passes coalesce — which is not what this test is pinning.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.stalled()).toBe(true);
  });

  it("a successful pass resets the backoff and clears stalled()", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    transport.offline = true;
    session.connect();
    session.recordScore(ANN_ID, 1, toResult(4)); // the queued score that makes the session dirty — see the test above
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.stalled()).toBe(true);

    transport.offline = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.stalled()).toBe(false);
    expect(session.pending()).toBe(0); // the successful pass that cleared stalled() also drained the queue
  });

  it("schedules no timer at all when the session is clean — zero background cost on the happy path", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    session.connect();
    await vi.advanceTimersByTimeAsync(100);

    expect(session.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() cancels the retry timer", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    transport.offline = true;
    session.connect();
    session.recordScore(ANN_ID, 1, toResult(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await session.close();

    expect(vi.getTimerCount()).toBe(0);
  });

  // The sequence this task itself makes reachable: the new onClose handler schedules a retry,
  // so a session can hold a live timer while connectedFlag is already false. If doDisconnect's
  // `if (!connectedFlag) return;` guard ran BEFORE the loop was stopped, close() would skip both
  // `wantsConnection = false` and clearRetry() — and the surviving timer's own callback
  // (`wantsConnection && !connectedFlag` → doConnect()) would re-open the socket on a closed
  // session and sync forever. disconnect() shares the guard and is fixed by the same hoist.
  it("close() cancels the retry timer even when the socket had ALREADY dropped, and never reopens it", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    session.connect();
    session.recordScore(ANN_ID, 1, toResult(4));
    await vi.advanceTimersByTimeAsync(0);

    transport.offline = true;
    transport.triggerSocketClose(); // connectedFlag goes false; onClose schedules the retry
    expect(session.connected()).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await session.close();

    expect(vi.getTimerCount()).toBe(0); // the loop is stopped, not merely disconnected
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.connected()).toBe(false); // a closed session never re-opens its own socket
  });

  // onPassSettled reads its delay BEFORE doubling retryDelayMs. Swapping those two lines leaves
  // every other test in this file green — it merely doubles the first wait — so this is the one
  // assertion standing between that ordering and a silent regression.
  it("arms the FIRST retry at the 2s base, not the delay this pass just doubled to", async () => {
    const transport = createScriptedTransport(buildServerLog());
    let pushAttempts = 0;
    const realPush = transport.push.bind(transport);
    transport.push = async (event) => {
      pushAttempts += 1; // counts attempts, including the ones that throw while offline
      return realPush(event);
    };

    const session = await liveSession(transport);
    session.connect();
    await vi.advanceTimersByTimeAsync(0); // a clean pass: backoff at its base, no timer armed

    // Exactly ONE failed pass — connect()'s own double trigger has already settled above, so
    // this recordScore is the only thing driving the loop.
    transport.offline = true;
    session.recordScore(ANN_ID, 1, toResult(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(pushAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(pushAttempts).toBe(1); // not yet — the retry is armed for 2s, not 1.999s

    await vi.advanceTimersByTimeAsync(1);
    expect(pushAttempts).toBe(2); // fired at exactly 2s: the base delay, not the doubled 4s
  });

  // A pass can die on something that is NOT a TransportError — a contract-parse failure under
  // deploy skew, or a bug in ingest/reduceRound/hlcSource.observe. That must still leave the
  // loop armed: a dirty session whose retry is dead is exactly the state the spec forbids ("no
  // state in which the queue has stopped trying"), and it is worse than useless downstream —
  // the chrome would claim "syncing…" forever while nothing syncs.
  it("keeps retrying after a pass dies on a non-transport error, and drains once the failure clears", async () => {
    // Restored in a finally: an assertion failing mid-test would otherwise leave console.warn
    // stubbed for every later test in this file — silencing warnings exactly when they matter.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const transport = createScriptedTransport(buildServerLog());
      const session = await liveSession(transport);
      session.connect();
      await vi.advanceTimersByTimeAsync(0);

      // The server starts answering with a body that fails contract parsing: a plain Error, so
      // every TransportError-shaped path in the sync loop is bypassed.
      const workingPull = transport.pull.bind(transport);
      transport.pull = async () => {
        throw new Error("malformed server response");
      };

      session.recordScore(ANN_ID, 1, toResult(4));
      await vi.advanceTimersByTimeAsync(0);

      expect(session.pending()).toBe(1); // dirty: the score is queued and unsent
      expect(vi.getTimerCount()).toBeGreaterThan(0); // ...and the loop is still armed

      // The real point: a scheduled timer that never drains would satisfy the assertion above
      // on its own. Recovery is the contract.
      transport.pull = workingPull;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(session.pending()).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("never touches the network for a session that never called connect()", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);

    session.recordScore(ANN_ID, 1, toResult(4));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(transport.pushedOpIds).toEqual([]);
    expect(session.pending()).toBe(1);
  });

  // stalled() is consumed as "we are still trying and it is still not working". On a session
  // with no retry loop behind it, the first half is false — so the flag must stay down no
  // matter how many passes fail, or the chrome asserts an effort that isn't happening.
  it("never reports stalled() on a session that isn't retrying", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    transport.offline = true;

    // Four failed passes — enough to drive the backoff to its cap — driven by explicit sync()
    // calls on a session that never connected, so no loop was ever licensed.
    session.recordScore(ANN_ID, 1, toResult(4));
    for (let pass = 0; pass < 4; pass += 1) await session.sync();

    expect(session.stalled()).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // and indeed nothing is trying

    // Same claim on the way out: a session stalled with a live loop must drop the claim when
    // the loop stops, not carry it past disconnect().
    const connected = await liveSession(transport);
    connected.connect();
    connected.recordScore(ANN_ID, 1, toResult(4));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connected.stalled()).toBe(true);

    connected.disconnect();

    expect(connected.stalled()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // And a user-initiated reconnect starts fresh rather than inheriting the dead network's
    // patience: if disconnect() left the backoff at its 30s cap, the very first failure after
    // reconnecting would re-raise stalled() immediately.
    connected.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(connected.stalled()).toBe(false);
  });
});
