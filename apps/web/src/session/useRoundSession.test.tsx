import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryOutboxStore } from "@swng/client";
import { cellKey, deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, OpId, RoundEvent } from "@swng/domain";
import { createScriptedTransport, stampSeq } from "../testSupport/scriptedTransport";
import type { ScriptedTransport } from "../testSupport/scriptedTransport";
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
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, playedAtMs: 1_000, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", strokes: 0 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
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
    // recordScore/sync/flush/connect on an idle view must be safe no-ops, never throw.
    expect(() => result.current.recordScore(ANN_ID, 1, { kind: "strokes", strokes: 4 })).not.toThrow();
    await expect(result.current.sync()).resolves.toBeUndefined();
    // 0, not a throw and not an undefined: no session means no outbox, and the finalize
    // boundary reads this answer as "nothing queued" — the honest reading here.
    await expect(result.current.flush()).resolves.toBe(0);
    expect(() => result.current.connect()).not.toThrow();
  });

  it("connect() is idempotent — calling it again on an already-connected live session doesn't reopen the socket", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceId("ann-tab-4"),
    });
    const useRoundSession = createUseRoundSession(resolveSessionConfig);

    const { result } = renderHook(() => useRoundSession(ROUND_ID));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    // The mount effect's own session.connect() already opened the socket once — this is the
    // "Sync now" button's exact call, fired again while nothing changed (e.g. a double tap,
    // or a tap that lands while the socket never actually dropped).
    expect(transport.socketOpenCalls).toBe(1);
    expect(result.current.connected).toBe(true);

    act(() => {
      result.current.connect();
    });

    expect(transport.socketOpenCalls).toBe(1); // still just the one real socket
    expect(result.current.connected).toBe(true);
  });
});

describe("useRoundSession — wake signals", () => {
  // Runs turns until the pull count stops moving: "nothing more is in flight", without a
  // sleep-and-hope delay. Termination is guaranteed — the session only pulls when something
  // triggers it, and this triggers nothing.
  const settlePulls = async (transport: ScriptedTransport): Promise<void> => {
    let previous = -1;
    while (previous !== transport.pullCalls) {
      previous = transport.pullCalls;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  const liveHook = (transport: ScriptedTransport) => {
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: ROUND_ID,
      golferId: ANN_ID,
      deviceId: deviceId("ann-tab-1"),
    });
    return renderHook(() => createUseRoundSession(resolveSessionConfig)(ROUND_ID));
  };

  it("syncs on the browser's online event, so a queue drains the moment signal returns", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const { result, unmount } = liveHook(transport);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const pullsBefore = transport.pullCalls;

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(transport.pullCalls).toBeGreaterThan(pullsBefore));
    unmount();
  });

  it("syncs on the browser's focus event, covering a tab that regains focus without an online event", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const { result, unmount } = liveHook(transport);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const pullsBefore = transport.pullCalls;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(transport.pullCalls).toBeGreaterThan(pullsBefore));
    unmount();
  });

  it("syncs on visibilitychange while the document is visible, covering a phone waking from a locked screen", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const { result, unmount } = liveHook(transport);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const pullsBefore = transport.pullCalls;

    // happy-dom's default document.visibilityState is "visible" — the positive arm needs no stub.
    expect(document.visibilityState).toBe("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(transport.pullCalls).toBeGreaterThan(pullsBefore));
    unmount();
  });

  it("does not sync on visibilitychange while the document is hidden", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const { result, unmount } = liveHook(transport);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    // Quiesce BEFORE capturing the baseline: connect() fires two triggers of its own (the
    // immediate catch-up and the socket's onOpen), which coalesce into a trailing pass that can
    // still land after hydration. Reading pullsBefore inside that window makes this negative
    // fail for a reason that has nothing to do with visibility.
    await settlePulls(transport);
    const pullsBefore = transport.pullCalls;

    const visibilitySpy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // ...and a turn AFTER it, before asserting. The guard returns synchronously, but the pull a
    // missing guard would cause rides a microtask behind sync()'s own first await — so an
    // assertion made in the same tick as the dispatch passes just as happily with the guard
    // deleted, which is no test at all.
    await settlePulls(transport);

    expect(transport.pullCalls).toBe(pullsBefore);

    visibilitySpy.mockRestore();
    unmount();
  });

  it("removes its listeners on unmount — the exact handler added is the one removed", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const documentAddSpy = vi.spyOn(document, "addEventListener");
    const documentRemoveSpy = vi.spyOn(document, "removeEventListener");

    const { result, unmount } = liveHook(transport);
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    // Capture the ACTUAL handler references the effect registered — asserting removal with a
    // freshly-constructed function of the same name would pass even if removeEventListener were
    // called with the wrong reference (a silent no-op), which is the realistic way this breaks.
    const onlineHandler = windowAddSpy.mock.calls.find(([type]) => type === "online")?.[1];
    const focusHandler = windowAddSpy.mock.calls.find(([type]) => type === "focus")?.[1];
    const visibilityHandler = documentAddSpy.mock.calls.find(([type]) => type === "visibilitychange")?.[1];
    expect(onlineHandler).toBeInstanceOf(Function);
    expect(focusHandler).toBeInstanceOf(Function);
    expect(visibilityHandler).toBeInstanceOf(Function);

    unmount();

    expect(windowRemoveSpy).toHaveBeenCalledWith("online", onlineHandler);
    expect(windowRemoveSpy).toHaveBeenCalledWith("focus", focusHandler);
    expect(documentRemoveSpy).toHaveBeenCalledWith("visibilitychange", visibilityHandler);

    windowAddSpy.mockRestore();
    windowRemoveSpy.mockRestore();
    documentAddSpy.mockRestore();
    documentRemoveSpy.mockRestore();
  });
});
