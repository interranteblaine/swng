import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMemoryOutboxStore } from "@swng/client";
import { cellKey, deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, OpId, RoundEvent } from "@swng/domain";
import { createScriptedTransport, stampSeq } from "../testSupport/scriptedTransport";
import { createUseRoundSession } from "./useRoundSession";
import type { ResolveSessionConfig } from "./useRoundSession";

const ROUND_ID = roundId("round-1");
const ANN_ID = golferId("ann");
const SERVER_DEVICE = deviceId("server");

// This scenario (creation + one join + start + one stableford game) is specific to this
// file's tests, unlike createScriptedTransport (the generic transport plumbing, shared via
// ../testSupport/scriptedTransport since every apps/web spec needing a live session needs
// one) — every spec builds its own server log tailored to what it's asserting.
const buildServerLog = (): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`server-op-${(opCounter += 1)}`);
  const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN_ID] };
  const events: RoundEvent[] = [
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", courseHandicap: 8 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: stableford, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
  ];
  return stampSeq(events);
};

describe("useRoundSession", () => {
  it("renders hydrated=false until the connect-time catch-up ingests genesis, then flips true", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceId("ann-tab-1"),
    });
    const useRoundSession = createUseRoundSession(resolveSessionConfig);

    const { result } = renderHook(() => useRoundSession(ROUND_ID));

    expect(result.current.hydrated).toBe(false);
    expect(result.current.state).toBeUndefined();
    expect(result.current.games).toEqual([]);

    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.state?.participants).toHaveLength(1);
  });

  it("recordScore re-renders exactly once per change", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceId("ann-tab-2"),
    });
    const useRoundSession = createUseRoundSession(resolveSessionConfig);

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRoundSession(ROUND_ID);
    });

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const rendersAfterHydration = renders;

    // Isolate this recordScore's own optimistic notify from its opportunistic background
    // sync (the hook auto-connects, so recordScore also kicks off a push+pull round trip) —
    // offline makes that round trip a silent no-op instead of a second, later notify once it
    // (redundantly) confirms the same event, which would make this assertion timing-
    // dependent on the fetch microtask instead of deterministic.
    transport.offline = true;
    act(() => {
      result.current.recordScore(ANN_ID, 1, { kind: "strokes", strokes: 4 });
    });

    expect(renders).toBe(rendersAfterHydration + 1);
    expect(result.current.state?.cells[cellKey(ANN_ID, 1)]).toBeDefined();
  });

  it("closes the underlying session on unmount", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceId("ann-tab-3"),
    });
    const useRoundSession = createUseRoundSession(resolveSessionConfig);

    const { result, unmount } = renderHook(() => useRoundSession(ROUND_ID));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    unmount();

    // close() disconnects (among other things) — the socket's close callback, returned by
    // this scripted transport's openSocket, is the direct, unambiguous signal that close()
    // actually ran, not just that the component tree unmounted.
    await waitFor(() => expect(transport.socketCloseCalls).toBe(1));
  });

  it("stays idle (never constructs a session) when resolveSessionConfig has nothing for this round", async () => {
    const resolveSessionConfig: ResolveSessionConfig = () => undefined;
    const useRoundSession = createUseRoundSession(resolveSessionConfig);

    const { result } = renderHook(() => useRoundSession(ROUND_ID));

    expect(result.current).toMatchObject({ hydrated: false, state: undefined, games: [], pending: 0, rejected: [], connected: false });
    // recordScore/sync on an idle view must be safe no-ops, never throw.
    expect(() => result.current.recordScore(ANN_ID, 1, { kind: "strokes", strokes: 4 })).not.toThrow();
    await expect(result.current.sync()).resolves.toBeUndefined();
  });
});
