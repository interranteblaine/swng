import { opId, reduceRound, scoreGame } from "@swng/domain";
import type { DeviceId, GameConfig, GameState, GolferId, HoleResult, RoundEvent, RoundId, RoundState } from "@swng/domain";
import { createHlcSource } from "./hlc.js";
import { createMemoryOutboxStore } from "./outbox.js";
import type { OutboxStore, PersistedSync } from "./outbox.js";
import { TransportError } from "./transport.js";
import type { RoundTransport } from "./transport.js";

// scoreGame throws on a kind it doesn't recognize (M2 lesson, carried to the client): a
// build must survive a round containing a future game kind rather than crashing games().
// Derived from the same union scoreGame switches on (scoring/game.ts) — the two lists
// must never drift, so this is the one place that names them.
const KNOWN_GAME_KINDS: ReadonlySet<GameConfig["kind"]> = new Set<GameConfig["kind"]>(["stroke-play", "singles-match", "stableford", "fourball-match", "skins"]);

export interface RejectedOp {
  readonly event: RoundEvent;
  readonly code: string;
}

export interface RoundSession {
  readonly roundId: RoundId;
  state(): RoundState; // reduceRound(confirmed ∪ outbox), cached until change
  games(): readonly GameState[]; // scoreGame over state().games filtered to known kinds
  recordScore(golferId: GolferId, hole: number, result: HoleResult): void; // optimistic; opportunistic push when connected
  sync(): Promise<void>; // push outbox oldest-first, then pull since lastSeq
  connect(): void; // open socket (idempotent); socket open triggers sync()
  disconnect(): void;
  connected(): boolean;
  pending(): number; // outbox depth (UI badge)
  rejected(): readonly RejectedOp[]; // permanently rejected ops (UI surfacing)
  onChange(listener: () => void): () => void;
  close(): Promise<void>; // disconnect + final save
}

export interface SessionConfig {
  transport: RoundTransport;
  store?: OutboxStore; // default memory
  roundId: RoundId;
  golferId: GolferId;
  deviceId: DeviceId;
  clock?: { now(): number };
}

// A transient push failure (offline, or the server having a bad moment) must never lose
// or reject an op — it just stays queued for the next sync(). Only a real 4xx (the server
// deliberately refusing this op, e.g. a finalized round) is permanent.
const isTransientPushFailure = (error: TransportError): boolean => error.kind === "network" || (error.status !== undefined && error.status >= 500);

export const createRoundSession = async (config: SessionConfig): Promise<RoundSession> => {
  const { transport } = config;
  const store = config.store ?? createMemoryOutboxStore();
  const clock = config.clock ?? { now: () => Date.now() };
  const hlcSource = createHlcSource(config.deviceId, clock);

  // Confirmed events are deliberately NOT persisted (derive, don't store) — only the
  // outbox, cursor, and opId counter survive a restart; a fresh session re-pulls
  // everything else via sync(), which is the CALLER's choice, not automatic (the
  // kill-network test constructs a session offline and never lets it touch the network).
  const persisted = await store.load(config.roundId);
  let pending: readonly RoundEvent[] = persisted?.pending ?? [];
  // Plan amendment: `persisted.lastSeq` is deliberately NOT read here. It summarizes a
  // confirmed log that v1 never persists (confirmed always starts empty below), so seeding
  // the in-memory cursor from it would make a restarted session pull only events AFTER
  // that point — permanently missing everything before it, with no persisted confirmed
  // copy to fall back on. The in-memory cursor therefore always starts at 0 whenever
  // confirmed is empty at construction, which is unconditionally true in v1. The field
  // stays in `PersistedSync` (and is still written by persist() below) only so a future
  // version that DOES persist confirmed events has a stable storage shape to grow into,
  // without a migration.
  let lastSeq = 0;
  let opCounter = persisted?.opCounter ?? 0;
  let confirmed: readonly RoundEvent[] = [];
  let rejectedOps: readonly RejectedOp[] = [];
  let connectedFlag = false;
  let closeSocket: (() => void) | undefined;
  let cachedState: RoundState | undefined;
  let saveChain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  // Gate state for requestSync() below — see its own comment for the coalescing scheme.
  let syncRunning: Promise<void> | undefined;
  let syncRerunRequested = false;
  let syncRerunWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const invalidateCache = (): void => {
    cachedState = undefined;
  };

  const computeState = (): RoundState => {
    // The fold tolerates an event appearing in both confirmed and pending (opId dedupe
    // inside reduceRound) — this is what makes outbox pruning an optimization rather than
    // a correctness requirement (M4 plan, Global Constraints).
    if (!cachedState) cachedState = reduceRound([...confirmed, ...pending]);
    return cachedState;
  };

  // Chained (not fire-and-forget per call) so concurrent saves never land out of order —
  // each snapshot is captured synchronously at call time, so a slower earlier save can
  // never clobber a faster later one with stale data. Critically, the chain link is wrapped
  // in `attempt.catch(() => {})` BEFORE becoming the next call's `saveChain` — a rejecting
  // store.save() (IndexedDB quota, private mode) must not poison the chain, or every save
  // after the first failure would be silently skipped rather than attempted. The returned
  // `attempt` still carries the real outcome for whichever caller wants to observe it
  // (close(), specifically); in-memory state is authoritative regardless of what persist()
  // does.
  const persist = (): Promise<void> => {
    const snapshot: PersistedSync = { pending, lastSeq, opCounter };
    const attempt = saveChain.then(() => store.save(config.roundId, snapshot));
    saveChain = attempt.catch(() => {});
    return attempt;
  };

  // The three fire-and-forget call sites below don't need (and mustn't block on) this
  // save's outcome — but discarding persist()'s promise with a bare `void` would turn a
  // rejection into an unhandled rejection. This is the SDK's log-and-drop precedent
  // (transport.ts drops a malformed socket message rather than throwing); persistence
  // failure is the same shape of "recoverable, report it, move on."
  const persistInBackground = (): void => {
    persist().catch((error: unknown) => {
      console.warn(`swng client: failed to persist outbox for round ${config.roundId}`, error);
    });
  };

  // Shared by pull batches and socket batches: observe every remote hlc into the
  // HlcSource (the receive rule — a skewed-behind correction must still win the LWW
  // register it corrects), dedupe-append into confirmed, prune the outbox of anything now
  // confirmed, and notify exactly once for the whole batch. `nextSeq` only arrives from a
  // pull — the cursor has exactly one authority, so socket delivery never moves it.
  const ingest = (events: readonly RoundEvent[], nextSeq?: number): void => {
    for (const event of events) hlcSource.observe(event.hlc);

    const knownOpIds = new Set(confirmed.map((event) => event.opId));
    const newlyConfirmed: RoundEvent[] = [];
    for (const event of events) {
      if (knownOpIds.has(event.opId)) continue;
      knownOpIds.add(event.opId);
      newlyConfirmed.push(event);
    }
    if (newlyConfirmed.length > 0) confirmed = [...confirmed, ...newlyConfirmed];

    if (nextSeq !== undefined) lastSeq = nextSeq;

    pending = pending.filter((event) => !knownOpIds.has(event.opId));

    invalidateCache();
    persistInBackground();
    notify();
  };

  // Push semantics (M4 plan, Global Constraints): oldest-first, sequential, one event per
  // call. A transient failure stops the push and leaves the rest queued — offline is not
  // an error, the queue IS the feature. A permanent rejection drops that one entry into
  // rejected() and continues with the rest, so one bad op (e.g. scoring a finalized round)
  // can never wedge the whole queue.
  const pushPending = async (): Promise<void> => {
    const toPush = [...pending];
    for (const event of toPush) {
      try {
        await transport.push(event);
        // Deliberately NOT pruned here on a bare push success — pruning only happens in
        // ingest() once the confirmed copy is actually seen (via pull or socket). Until
        // then the event stays in pending; reduceRound's opId dedupe makes that harmless,
        // and it keeps state() correct even mid-sync rather than momentarily losing a
        // score between "pushed" and "pulled back".
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        if (isTransientPushFailure(error)) return;
        rejectedOps = [...rejectedOps, { event, code: error.code ?? `http-${error.status ?? "unknown"}` }];
        pending = pending.filter((pendingEvent) => pendingEvent.opId !== event.opId);
        invalidateCache();
        persistInBackground();
        notify();
      }
    }
  };

  const doSync = async (): Promise<void> => {
    await pushPending();
    try {
      const { events, nextSeq } = await transport.pull(lastSeq);
      ingest(events, nextSeq);
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      // Offline: sync() resolves without throwing — the queue IS the feature.
    }
  };

  // Serializes the whole sync loop. sync(), recordScore's opportunistic push, and
  // connect()'s socket-open catch-up all funnel through this one gate — without it, each
  // trigger calls doSync() independently, and since pushPending() snapshots `pending`
  // unguarded, two overlapping passes can push the same op twice or double-reject it into
  // rejected(). The scheme: at most one doSync() pass runs at a time; a request that
  // arrives while a pass is running doesn't start a second pass — it just sets a flag and
  // waits. When the running pass finishes, that flag causes exactly ONE more pass to run
  // before any of the coalesced callers' promises resolve, so a late-arriving op (e.g. a
  // recordScore mid-sync) is guaranteed to be picked up by that trailing pass rather than
  // silently waiting for some unrelated future sync() call. Multiple requests that arrive
  // during the same pass all coalesce onto that single trailing pass — they don't queue up
  // additional passes.
  const requestSync = (): Promise<void> => {
    if (syncRunning) {
      syncRerunRequested = true;
      return new Promise<void>((resolve, reject) => {
        syncRerunWaiters.push({ resolve, reject });
      });
    }

    const runPasses = async (): Promise<void> => {
      try {
        for (;;) {
          syncRerunRequested = false;
          const waiters = syncRerunWaiters;
          syncRerunWaiters = [];
          try {
            await doSync();
            for (const waiter of waiters) waiter.resolve();
          } catch (error) {
            for (const waiter of waiters) waiter.reject(error);
            throw error;
          }
          if (!syncRerunRequested) break;
        }
      } finally {
        syncRunning = undefined;
      }
    };

    syncRunning = runPasses();
    return syncRunning;
  };

  const doDisconnect = (): void => {
    if (!connectedFlag) return;
    closeSocket?.();
    closeSocket = undefined;
    connectedFlag = false;
    notify();
  };

  const session: RoundSession = {
    roundId: config.roundId,

    state: () => computeState(),

    games: () => {
      const currentState = computeState();
      return currentState.games.filter((gameConfig) => KNOWN_GAME_KINDS.has(gameConfig.kind)).map((gameConfig) => scoreGame(gameConfig, currentState));
    },

    recordScore: (golferId: GolferId, hole: number, result: HoleResult) => {
      opCounter += 1;
      const event: RoundEvent = {
        kind: "score-recorded",
        opId: opId(`${config.deviceId}-${opCounter}`),
        hlc: hlcSource.next(),
        // The session always authors as itself — score-for-anyone means `golferId` (the
        // subject) can differ from `authorId`, but the author is never anyone but this
        // session's own golfer. The server stamps the same value from the token, so the
        // confirmed copy this optimistic event is later replaced/pruned by is byte-identical.
        authorId: config.golferId,
        golferId,
        hole,
        result,
      };
      pending = [...pending, event];
      invalidateCache();
      persistInBackground();
      notify();
      // Opportunistic, not required for correctness: an unconnected/offline session just
      // leaves this queued for the next explicit sync(). Routed through requestSync() (the
      // full push+pull loop), not a bare push, so it shares the same serialization gate as
      // every other trigger — see requestSync()'s comment.
      if (connectedFlag) void requestSync();
    },

    sync: () => requestSync(),

    connect: () => {
      if (connectedFlag) return; // idempotent
      connectedFlag = true;
      closeSocket = transport.openSocket(
        (events) => ingest(events), // socket events carry no nextSeq — the cursor never moves through them
        () => {
          connectedFlag = false;
          closeSocket = undefined;
          notify();
          // No auto-reconnect timer in v1: the UI owns retry cadence (backoff policy,
          // offline-banner UX, etc. are presentation concerns, not sync-loop concerns).
          // A caller that wants to reconnect calls connect() again.
        },
      );
      notify();
      void requestSync(); // socket open triggers a catch-up sync, through the same gate as every other trigger
    },

    disconnect: () => doDisconnect(),

    connected: () => connectedFlag,

    pending: () => pending.length,

    rejected: () => rejectedOps,

    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close: async () => {
      doDisconnect();
      await persist();
    },
  };

  return session;
};
