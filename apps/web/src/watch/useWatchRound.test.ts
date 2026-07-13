import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, OpId, RoundEvent } from "@swng/domain";
import { createScriptedTransport, stampSeq } from "../testSupport/scriptedTransport";
import type { ScriptedTransport } from "../testSupport/scriptedTransport";
import { createUseWatchRound } from "./useWatchRound";

// KNOWN FLAKE, seen once (2026-07-13, full-suite run only): three "Unhandled Rejection:
// window is not defined" errors surfaced from this file while every test in the run passed —
// some async path in the hook or these tests outlived happy-dom's environment teardown.
// Isolated (7/7) and repeated full-suite reruns were clean, so it's a latent teardown race,
// not randomness in the assertions. If it recurs: hunt the pending promise/timer that escapes
// the test's lifecycle (an un-awaited transport callback is the likely shape) — don't rerun
// until green and move on.
const ROUND_ID = roundId("round-1");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");
const SERVER_DEVICE = deviceId("server");

// One live round's worth of server log (creation + two joins + start + one stableford game) —
// same per-file "build a scenario-specific server log" idiom as useRoundSession.test.tsx's own
// buildServerLog.
const buildServerLog = (): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`server-op-${(opCounter += 1)}`);
  const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN_ID, BO_ID] };
  const events: RoundEvent[] = [
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", courseHandicap: 8 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: BO_ID, name: "Bo", tee: "white", courseHandicap: 2 }, authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: stableford, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
  ];
  return stampSeq(events);
};

describe("useWatchRound", () => {
  it("renders hydrated=false until the connect-time catch-up pull ingests genesis, then flips true", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const useWatchRound = createUseWatchRound(() => transport);

    const { result } = renderHook(() => useWatchRound(ROUND_ID, "spectator-token"));

    expect(result.current.hydrated).toBe(false);
    expect(result.current.state).toBeUndefined();
    expect(result.current.games).toEqual([]);

    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.state?.participants).toHaveLength(2);
    expect(result.current.games).toHaveLength(1);
    expect(result.current.games[0]?.kind).toBe("stableford");
  });

  it("never calls transport.push — a spectator authors nothing", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const pushCalls: unknown[] = [];
    const spiedTransport: ScriptedTransport = {
      ...transport,
      push: async (event) => {
        pushCalls.push(event);
        return transport.push(event);
      },
    };
    const useWatchRound = createUseWatchRound(() => spiedTransport);

    const { result } = renderHook(() => useWatchRound(ROUND_ID, "spectator-token"));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(pushCalls).toEqual([]);
  });

  it("a score-recorded event delivered over the socket updates state — no poll tick needed", async () => {
    const transport = createScriptedTransport(buildServerLog());
    // Wraps openSocket to capture the hook's own onEvents callback — the cleanest way to
    // simulate "the server broadcast this over an already-open socket" without a poll ever
    // running, since createScriptedTransport itself has no server-push simulation beyond its
    // one onOpen catch-up call.
    let capturedOnEvents: ((events: readonly RoundEvent[]) => void) | undefined;
    const spiedTransport: ScriptedTransport = {
      ...transport,
      openSocket: (onEvents, onClose, onOpen) => {
        capturedOnEvents = onEvents;
        return transport.openSocket(onEvents, onClose, onOpen);
      },
    };
    const useWatchRound = createUseWatchRound(() => spiedTransport);

    const { result } = renderHook(() => useWatchRound(ROUND_ID, "spectator-token"));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.state?.cells).toEqual({});
    expect(capturedOnEvents).toBeDefined();

    const scored: RoundEvent = {
      kind: "score-recorded",
      golferId: ANN_ID,
      hole: 1,
      result: { kind: "strokes", strokes: 4 },
      authorId: ANN_ID,
      opId: opId("server-op-score-1"),
      hlc: { wallMs: 9_000, counter: 0, deviceId: SERVER_DEVICE },
      seq: 100,
    };
    capturedOnEvents!([scored]);

    await waitFor(() => expect(result.current.state?.cells[`${ANN_ID}#1`]).toBeDefined());
  });

  // Papercut 14 (M9 hardening): a mistyped/dead link's every pull fails identically to a
  // transient blip — before this fix, error was indistinguishable from "still loading," so
  // WatchPage spun forever. `transport.offline` (createScriptedTransport's own doc comment)
  // makes every pull/push throw a TransportError, exactly as a real dead round/token would.
  it("surfaces error=true once a pull fails and this round has NEVER hydrated — not perpetual loading", async () => {
    const transport = createScriptedTransport(buildServerLog());
    transport.offline = true;
    const useWatchRound = createUseWatchRound(() => transport, 20);

    const { result } = renderHook(() => useWatchRound(ROUND_ID, "dead-token"));

    expect(result.current.error).toBe(false); // not yet — the first pull hasn't landed
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.state).toBeUndefined();
  });

  it("a later successful pull clears the error and hydrates normally — a transient blip self-heals", async () => {
    const transport = createScriptedTransport(buildServerLog());
    transport.offline = true;
    const useWatchRound = createUseWatchRound(() => transport, 20);

    const { result } = renderHook(() => useWatchRound(ROUND_ID, "spectator-token"));
    await waitFor(() => expect(result.current.error).toBe(true));

    transport.offline = false;
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.error).toBe(false);
  });

  it("never surfaces error once a round HAS hydrated — a later failed pull still just warns-and-drops", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const useWatchRound = createUseWatchRound(() => transport, 20);

    const { result } = renderHook(() => useWatchRound(ROUND_ID, "spectator-token"));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    transport.offline = true; // every poll from here on fails
    await new Promise((resolve) => setTimeout(resolve, 60)); // let a couple of poll ticks run

    expect(result.current.error).toBe(false);
    expect(result.current.hydrated).toBe(true); // the already-hydrated view is undisturbed
  });

  it("polls transport.pull on an interval and folds newly-arrived events in", async () => {
    const transport = createScriptedTransport(buildServerLog());
    // A short poll interval (the hook's own second DI seam) — the assertion is "eventually
    // arrives via the poll loop," not "arrives within the real production 4s cadence."
    const useWatchRound = createUseWatchRound(() => transport, 20);

    const { result } = renderHook(() => useWatchRound(ROUND_ID, "spectator-token"));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    await transport.push({
      kind: "score-recorded",
      golferId: BO_ID,
      hole: 1,
      result: { kind: "strokes", strokes: 5 },
      authorId: BO_ID,
      opId: opId("server-op-score-2"),
      hlc: { wallMs: 9_500, counter: 0, deviceId: SERVER_DEVICE },
    });

    await waitFor(() => expect(result.current.state?.cells[`${BO_ID}#1`]).toBeDefined());
  });
});
