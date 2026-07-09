import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createHttpTransport, createIndexedDbOutboxStore, createRoundSession } from "@swng/client";
import type { RejectedOp, RoundSession, SessionConfig } from "@swng/client";
import type { GameState, GolferId, HoleResult, RoundId, RoundState } from "@swng/domain";
import { config } from "../config";
import { credentialStore, tabDeviceId } from "../identity";

export interface RoundSessionView {
  readonly hydrated: boolean;
  readonly state: RoundState | undefined;
  readonly games: readonly GameState[];
  readonly pending: number;
  readonly rejected: readonly RejectedOp[];
  readonly connected: boolean;
  recordScore(golferId: GolferId, hole: number, result: HoleResult): void;
  sync(): Promise<void>;
}

// What createRoundSession needs to construct THIS round's session, resolved from a roundId
// alone — the saved credential (token + golferId) and the per-tab deviceId. Injected as a
// single function (module-level DI, chosen over a second hook parameter because the public
// signature below — useRoundSession: (roundId) => RoundSessionView — is the brief's own
// interface; a config parameter would change it) so tests can swap in a scripted
// RoundTransport + an in-memory OutboxStore without touching IndexedDB or the network. The
// default below is the only place that touches localStorage/sessionStorage/fetch/WebSocket.
// `undefined` means "no saved credential for this round" — the hook then stays idle rather
// than constructing a session with nothing to authenticate it (e.g. a direct link to a round
// this tab never joined).
export type ResolveSessionConfig = (roundId: RoundId) => SessionConfig | undefined;

const resolveRealSessionConfig: ResolveSessionConfig = (roundId) => {
  const credential = credentialStore.load(roundId);
  if (!credential) return undefined;
  const deviceId = tabDeviceId();
  return {
    roundId,
    golferId: credential.golferId,
    deviceId,
    transport: createHttpTransport({ httpUrl: config.httpUrl, wsUrl: config.wsUrl, roundId, token: credential.token }),
    store: createIndexedDbOutboxStore({ databaseName: `swng-outbox-${deviceId}` }),
  };
};

interface Snapshot {
  readonly hydrated: boolean;
  readonly state: RoundState | undefined;
  readonly games: readonly GameState[];
  readonly pending: number;
  readonly rejected: readonly RejectedOp[];
  readonly connected: boolean;
}

const EMPTY_GAMES: readonly GameState[] = [];
const EMPTY_REJECTED: readonly RejectedOp[] = [];
// No session yet (still constructing, or no credential for this round at all) — same shape
// a real session reports before its own hydrated() flips.
const IDLE_SNAPSHOT: Snapshot = { hydrated: false, state: undefined, games: EMPTY_GAMES, pending: 0, rejected: EMPTY_REJECTED, connected: false };

// state()/games() throw until session.hydrated() — the render guard from @swng/client's own
// M5 handoff (createRoundSession's own doc comment). Guarded here so this is the only place
// in the seam that has to know that.
const snapshotOf = (session: RoundSession): Snapshot => {
  const hydrated = session.hydrated();
  return {
    hydrated,
    state: hydrated ? session.state() : undefined,
    games: hydrated ? session.games() : EMPTY_GAMES,
    pending: session.pending(),
    rejected: session.rejected(),
    connected: session.connected(),
  };
};

// The ONE React<->SDK seam (M5 plan): this factory builds the hook itself, parameterized
// over how a roundId resolves into a live session's config — `useRoundSession` below is just
// this factory applied to the real world (resolveRealSessionConfig); tests apply it to a
// scripted transport + a memory outbox store instead.
export const createUseRoundSession = (resolveSessionConfig: ResolveSessionConfig = resolveRealSessionConfig): ((roundId: RoundId) => RoundSessionView) => {
  return function useRoundSession(roundId: RoundId): RoundSessionView {
    const sessionRef = useRef<RoundSession | undefined>(undefined);
    const snapshotRef = useRef<Snapshot>(IDLE_SNAPSHOT);
    const listenersRef = useRef<Set<() => void>>(new Set());

    // Stable forever (empty deps): useSyncExternalStore re-subscribes whenever `subscribe`'s
    // identity changes, so a fresh function here every render would mean "unsubscribe +
    // resubscribe on every render" for no reason.
    const subscribe = useCallback((onStoreChange: () => void) => {
      listenersRef.current.add(onStoreChange);
      return () => {
        listenersRef.current.delete(onStoreChange);
      };
    }, []);

    // Just reads the ref's current value — snapshotRef.current only ever changes inside
    // notify() below, in lockstep with the listener calls that tell React to re-read it, so
    // this never hands back a "changed" reference without a real change (the useSyncExternalStore
    // contract games()'s own identity stability — T1/M5 handoff — makes safe).
    const getSnapshot = useCallback(() => snapshotRef.current, []);

    // Deps: [roundId] only. resolveSessionConfig is captured once from createUseRoundSession's
    // own closure (module scope for the real hook, a fixed test double per test) — never a
    // per-render value, so it's correctly not a dependency here.
    useEffect(() => {
      let cancelled = false;

      const notify = (): void => {
        const session = sessionRef.current;
        snapshotRef.current = session ? snapshotOf(session) : IDLE_SNAPSHOT;
        for (const listener of listenersRef.current) listener();
      };

      const sessionConfig = resolveSessionConfig(roundId);
      if (!sessionConfig) return; // no saved credential for this round: stay idle

      void (async () => {
        try {
          const session = await createRoundSession(sessionConfig);
          if (cancelled) {
            void session.close();
            return;
          }
          sessionRef.current = session;
          session.onChange(notify);
          notify(); // move off IDLE_SNAPSHOT now that a session exists (still not hydrated yet)
          session.connect();
        } catch (error) {
          // Warn-and-drop, matching @swng/client's own precedent for background failures
          // (persistInBackground/requestSyncInBackground in session.ts) — a store.load()
          // failure here must not crash the app; it just leaves this round permanently idle.
          console.warn(`swng web: failed to construct the round session for ${roundId}`, error);
        }
      })();

      return () => {
        cancelled = true;
        const session = sessionRef.current;
        sessionRef.current = undefined;
        if (session) void session.close();
      };
    }, [roundId]);

    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    const recordScore = useCallback((golferIdValue: GolferId, hole: number, result: HoleResult) => {
      sessionRef.current?.recordScore(golferIdValue, hole, result);
    }, []);

    const sync = useCallback(() => sessionRef.current?.sync() ?? Promise.resolve(), []);

    return { ...snapshot, recordScore, sync };
  };
};

export const useRoundSession = createUseRoundSession();
