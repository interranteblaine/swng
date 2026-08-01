import { opId, reduceRound, scoreGame } from "@swng/domain";
import type { DeviceId, GameState, GolferId, HoleResult, RoundEvent, RoundId, RoundState } from "@swng/domain";
import { createHlcSource } from "./hlc.js";
import { createMemoryOutboxStore } from "./outbox.js";
import type { OutboxStore, PersistedSync, RejectedOp } from "./outbox.js";
// The known-game-kinds set lives in scoring.ts now — ONE list shared by this live fold and
// foldAndScore's read-only one, not two copies to keep in sync. See its doc comment there.
import { KNOWN_GAME_KINDS } from "./scoring.js";
import { TransportError } from "./transport.js";
import type { RoundTransport } from "./transport.js";

export interface RoundSession {
  readonly roundId: RoundId;
  state(): RoundState; // reduceRound(confirmed ∪ outbox), cached until change; THROWS until hydrated()
  games(): readonly GameState[]; // scoreGame over state().games filtered to known kinds; THROWS until hydrated().
  // identity-stable — same array reference until the underlying state changes (required for
  // useSyncExternalStore, which treats a fresh reference as "store changed" and loops)
  recordScore(golferId: GolferId, hole: number, result: HoleResult): void; // optimistic; opportunistic push once connect() has been called (see wantsConnection)
  sync(): Promise<void>; // push outbox oldest-first, then pull since lastSeq
  connect(): void; // open socket (idempotent); socket open triggers sync()
  disconnect(): void;
  connected(): boolean;
  // True once a sync pass has failed having ALREADY waited out the backoff's 30s cap (the fifth
  // consecutive failure, t≈30s — the fourth merely sets the cap) and the loop is still running —
  // which includes the stretch while a retry pass is
  // actually in flight, when no timer is armed. The chrome's escalation signal — "we are still trying
  // and it is still not working" — as distinct from connected(), which only ever described the
  // socket. Both halves are load-bearing: it never reports stalled on a session that has
  // stopped retrying (one that never connected, or has been disconnected/closed), because the
  // chrome built on it would then be claiming an effort that isn't happening.
  stalled(): boolean;
  pending(): number; // outbox depth (UI badge)
  rejected(): readonly RejectedOp[]; // permanently rejected ops (UI surfacing)
  onChange(listener: () => void): () => void;
  // True once a round-created event is held (in confirmed or pending) — the render guard:
  // state()/games() throw (via reduceRound's genesis check) until this is true. Never
  // regresses to false once set.
  hydrated(): boolean;
  close(): Promise<void>; // disconnect + awaits any in-flight sync pass + final save
}

export interface SessionConfig {
  transport: RoundTransport;
  store?: OutboxStore; // default memory
  roundId: RoundId;
  golferId: GolferId;
  // Must be unique per LIVE SESSION, not per browser/user. Two concurrent sessions sharing
  // both a store AND a deviceId load the same persisted opCounter and mint colliding opIds
  // for different events — the server dedupes by opId, so one side's score is silently
  // discarded rather than both landing. (M5 must mint a fresh deviceId per browser tab, not
  // reuse one per device/user.)
  deviceId: DeviceId;
  clock?: { now(): number };
}

// A transient push failure (offline, or the server having a bad moment) must never lose
// or reject an op — it just stays queued for the next sync(). Only a real SEMANTIC refusal
// (the server deliberately refusing this op, e.g. a finalized round) is permanent.
//
// 408 and 429 are transient despite being 4xx, and deliberately so: 429 is what this app's own
// API Gateway stage throttle answers with under load, and 408 is a request the edge timed out.
// Neither says anything about the score — they both say "try again". A rejected op is kept on
// the device but never retried, so for a queue whose whole thesis is that a lost score is
// recoverable by nothing, retry-forever beats refuse for anything short of a real refusal.
const TRANSIENT_HTTP_STATUSES = new Set([408, 429]);
const isTransientPushFailure = (error: TransportError): boolean =>
  error.kind === "network" || (error.status !== undefined && (error.status >= 500 || TRANSIENT_HTTP_STATUSES.has(error.status)));

// Retry cadence for the self-draining outbox. The SDK owns this deliberately: M4 deferred
// "retry cadence" to the UI and no UI ever claimed it, so the policy existed nowhere and a
// dropped socket meant a golfer had to press a button to make a queued score leave the phone.
// Correctness lives here; apps/web's wake signals (online/visibilitychange/focus) are pure
// accelerators on top.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

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
  // The floor must survive a restart, same invariant as the persisted opCounter just below:
  // a persisted pending event can carry an hlc ahead of THIS restart's clock (this device
  // floored on a skewed-ahead peer in the prior session, or its wall clock regressed across
  // the restart itself), and a fresh HlcSource has no memory of that. Without this, a
  // post-restart recordScore correcting that same cell mints an hlc that compares LESS than
  // the pending event it's meant to beat — both push fine (distinct opIds), but LWW keeps
  // the stale value forever, on every device that ever pulls it.
  for (const event of pending) hlcSource.observe(event.hlc);
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
  // Seeded, not started empty: a refused op is the ONLY copy of that score anywhere, so it
  // survives the restart exactly as `pending` does.
  let rejectedOps: readonly RejectedOp[] = persisted?.rejected ?? [];
  let connectedFlag = false;
  // connect() was called and no disconnect()/close() has happened since. This — not the socket
  // flag — is what licenses the loop to touch the network, preserving M4's contract that a
  // session which never connects never makes a request on its own.
  let wantsConnection = false;
  let retryDelayMs = RETRY_BASE_MS;
  // Consecutive socket failures with no intervening connection that LIVED — the reconnect arm's
  // OWN ladder, separate from retryDelayMs because the two fail for different reasons.
  // retryDelayMs is keyed on a sync PASS settling badly; a socket that cannot stay up while HTTPS
  // is perfectly fine (a captive/hotel network blocking WS upgrades, a proxy killing the upgrade,
  // a middlebox that permits the upgrade and then kills the tunnel, a server-side close right
  // after accept) fails no pass at all — every catch-up pull succeeds and resets THAT ladder to
  // its base, so the reconnect would sit at the 2s floor for the rest of the round, paying a
  // $connect invocation and a connection-registry write every two seconds.
  let socketFailures = 0;
  // When the current socket reached OPEN, or undefined if it hasn't (or there isn't one). The
  // ladder is keyed on this rather than on the open EVENT because "it opened" cannot tell a real
  // connection from one accepted and killed 200ms later: the accept-then-die case fires onopen
  // every cycle, so an event-keyed reset re-handshakes at the 2s floor forever — the same hammer
  // in a narrower scenario. Having LIVED is the property that distinguishes them.
  let socketOpenedAtMs: number | undefined;
  // Whether the LAST settled pass succeeded — read only to spot the transition below.
  let lastPassOk = true;
  // A pure function of the count, so BOTH arming sites (the socket's own close handler and
  // onPassSettled, which re-arms after the catch-up pull that follows it) compute the same
  // delay for the same cycle instead of racing each other to a different one.
  const reconnectDelayMs = (): number => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, socketFailures - 1), RETRY_MAX_MS);
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stalledFlag = false;
  let closedFlag = false;
  let closeSocket: (() => void) | undefined;
  let cachedState: RoundState | undefined;
  let cachedGames: readonly GameState[] | undefined; // invalidated in lockstep with cachedState — see invalidateCache()
  // Seeded from the persisted pending itself: a restart can load a pending array that
  // already carries genesis (this device queued its own copy locally, never confirmed it),
  // in which case state() is already foldable without ever calling ingest() this session.
  let hydratedFlag = pending.some((event) => event.kind === "round-created");
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
    cachedGames = undefined;
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
    const snapshot: PersistedSync = { pending, lastSeq, opCounter, rejected: rejectedOps };
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
    // The receive rule runs unconditionally, even for a batch that turns out to be a pure
    // duplicate below — a true duplicate's hlcs were already observed on ITS first
    // delivery, so re-observing them here is a no-op, but the floor must never depend on
    // which delivery path (or how many) an event happens to arrive by.
    for (const event of events) hlcSource.observe(event.hlc);

    const knownOpIds = new Set(confirmed.map((event) => event.opId));
    const newlyConfirmed: RoundEvent[] = [];
    for (const event of events) {
      if (knownOpIds.has(event.opId)) continue;
      knownOpIds.add(event.opId);
      newlyConfirmed.push(event);
    }

    const prunedPending = pending.filter((event) => !knownOpIds.has(event.opId));
    const pruned = prunedPending.length !== pending.length;
    const seqChanged = nextSeq !== undefined && nextSeq !== lastSeq;

    // A socket echo or pull re-delivery of an already-confirmed batch: nothing newly
    // confirmed, nothing pruned from the outbox, and the cursor unchanged (or absent, as
    // every socket batch's is). confirmed/pending/lastSeq are therefore byte-identical to
    // before this call — there is nothing new to cache, persist, or notify a listener
    // about. This supersedes M4's "notify once per duplicate batch": M5 renders on notify,
    // so a no-op batch waking a render is a real cost, not a formality.
    if (newlyConfirmed.length === 0 && !pruned && !seqChanged) return;

    if (newlyConfirmed.length > 0) {
      confirmed = [...confirmed, ...newlyConfirmed];
      if (!hydratedFlag && newlyConfirmed.some((event) => event.kind === "round-created")) hydratedFlag = true;
    }

    if (nextSeq !== undefined) lastSeq = nextSeq;

    pending = prunedPending;

    invalidateCache();
    persistInBackground();
    notify();
  };

  // Push semantics (M4 plan, Global Constraints): oldest-first, sequential, one event per
  // call. A transient failure stops the push and leaves the rest queued — offline is not
  // an error, the queue IS the feature. A permanent rejection drops that one entry into
  // rejected() and continues with the rest, so one bad op (e.g. scoring a finalized round)
  // can never wedge the whole queue.
  const pushPending = async (): Promise<boolean> => {
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
        if (isTransientPushFailure(error)) return false;
        rejectedOps = [...rejectedOps, { event, code: error.code ?? `http-${error.status ?? "unknown"}` }];
        pending = pending.filter((pendingEvent) => pendingEvent.opId !== event.opId);
        invalidateCache();
        persistInBackground();
        notify();
      }
    }
    return true;
  };

  // pushPending() is INSIDE the try deliberately: its own non-TransportError rethrow would
  // otherwise escape before any settling could happen, exactly as the pull path's did.
  const doSync = async (): Promise<void> => {
    try {
      const pushOk = await pushPending();
      const { events, nextSeq } = await transport.pull(lastSeq);
      ingest(events, nextSeq);
      onPassSettled(pushOk);
    } catch (error) {
      // Settle FIRST, whatever the failure: a pass that dies on a non-transport error
      // (a contract-parse failure under deploy skew, a bug in ingest) must still leave the
      // retry loop armed while the session is dirty. The spec's invariant is that no state
      // exists in which the queue has stopped trying.
      onPassSettled(false);
      if (!(error instanceof TransportError)) throw error;
      // Offline: sync() resolves without throwing — the queue IS the feature.
    }
  };

  // Dirty = a retry has something to accomplish: an outbox to drain, or a socket to re-open.
  // Gated on wantsConnection so a session constructed offline and never connected stays exactly
  // as inert as it was before this loop existed.
  const isDirty = (): boolean => wantsConnection && (pending.length > 0 || !connectedFlag);

  const clearRetry = (): void => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  // Assign-and-notify in one place, so the flag can never change without the chrome hearing
  // about it — and so every site that stops the loop also drops the claim that it is running.
  const setStalled = (next: boolean): void => {
    if (stalledFlag === next) return;
    stalledFlag = next;
    notify();
  };

  const scheduleRetry = (delayMs: number): void => {
    if (closedFlag || retryTimer !== undefined || !isDirty()) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      // A dead socket is re-opened rather than merely re-synced: doConnect fires its own
      // catch-up sync, so this covers both halves of "dirty" in one branch.
      if (wantsConnection && !connectedFlag) doConnect();
      else requestSyncInBackground();
    }, delayMs);
  };

  // The one place that decides whether the loop is making progress. A pass counts as a success
  // only if it BOTH drained the push queue without a transient failure AND completed its pull —
  // otherwise a permanently-stuck push under a healthy pull would hold the backoff at its floor
  // forever. Delay sequence on consecutive failures: 2s, 4s, 8s, 16s, then the 30s cap; the first
  // failure to arrive having already waited that cap out — the fifth, at t≈30s — is what
  // stalled() reports.
  const onPassSettled = (ok: boolean): void => {
    // A pass that succeeds after one that FAILED is evidence the network itself came back, so the
    // socket failures counted during the outage no longer predict anything and the reconnect
    // starts fresh. Without this, a phone that walks out of a dead zone drains its queue at once
    // (the online/focus wake calls sync()) and then waits out the dead network's 30s cap before
    // its socket returns — the very delay this arm removed from the OTHER direction. A pass that
    // merely keeps succeeding is deliberately NOT evidence: that is exactly the blocked-upgrade
    // case, where every catch-up pull succeeds while no socket ever opens.
    if (ok && !lastPassOk) socketFailures = 0;
    lastPassOk = ok;

    // Read BEFORE the mutation below: the first retry after a failure must fire at the current
    // delay, not the one this pass just doubled to. (Swapping these two lines is invisible to
    // every other assertion in the suite — it just doubles the first wait — so it has its own
    // regression test.)
    //
    // A pass that SUCCEEDED leaves exactly one reason to still be dirty per isDirty(): either a
    // queue that survived a healthy round trip (momentary — the base delay is right), or a
    // socket that isn't up, which is the reconnect arm's business and must be armed from ITS
    // ladder. Handing the socket case RETRY_BASE_MS here is what kept the reconnect pinned at
    // the 2s floor: the pull it fires on every attempt succeeds, so this branch reset the delay
    // the close handler had just chosen.
    const delayMs = ok ? (connectedFlag ? RETRY_BASE_MS : reconnectDelayMs()) : retryDelayMs;
    // Read before the doubling too, and for its own reason: this asks whether the failure that
    // just landed had ALREADY waited out the full cap, which is the escalation signal below. The
    // fourth consecutive failure is the one that SETS the cap, and it lands at t≈14s — far too
    // early to call trouble, since fourteen seconds of failed syncs is ordinary play on a course
    // (a stand of trees, a valley). The fifth is the first to fail having waited the whole 30s,
    // and 30s is a real dead zone rather than a walk past some trees.
    const failedAtTheCap = !ok && retryDelayMs >= RETRY_MAX_MS;
    retryDelayMs = ok ? RETRY_BASE_MS : Math.min(retryDelayMs * 2, RETRY_MAX_MS);

    // Cleared before arming, never left in place: scheduleRetry declines while a timer is
    // already pending, so without this a freshly-computed (shorter) delay would be silently
    // discarded — a session stalled at the 30s cap that then has ONE good pass would still sit
    // out the old 30s wait before reconnecting.
    clearRetry();
    const retrying = isDirty();
    if (retrying) scheduleRetry(delayMs);

    // Only ever true while a retry is actually armed. stalled() is the chrome's "we are still
    // trying and it is still not working" — on a session that is NOT retrying (one that never
    // connected, so failing sync() calls are the caller's own business) the first half of that
    // sentence would be a lie.
    setStalled(retrying && failedAtTheCap);
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
            // A requestSync() that landed WHILE doSync() was in flight queues its waiter
            // onto syncRerunWaiters after this iteration's snapshot was already taken above
            // — a throw here would otherwise leave that waiter stranded (the loop exits, and
            // `finally` below only clears syncRunning), so its caller's sync()/close() await
            // would hang forever. Drain and reject whatever landed mid-pass too, with the
            // same error, before rethrowing.
            const strandedWaiters = syncRerunWaiters;
            syncRerunWaiters = [];
            for (const waiter of strandedWaiters) waiter.reject(error);
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

  // The two opportunistic (not explicitly awaited) trigger sites below don't need — and
  // mustn't block on — this sync's outcome, but discarding requestSync()'s promise with a
  // bare `void` would turn a throwing pass (a non-TransportError bug, e.g. a malformed
  // server response failing contract parsing) into an unhandled rejection. Same log-and-drop
  // precedent as persistInBackground() above; an explicit session.sync() caller still gets
  // the real rejection, since THEIR promise is returned to them, not discarded here.
  const requestSyncInBackground = (): void => {
    requestSync().catch((error: unknown) => {
      console.warn(`swng client: opportunistic sync failed for round ${config.roundId}`, error);
    });
  };

  // The socket is down — whether it closed after being accepted, or was never constructed at
  // all. connectedFlag going stale-true is the hazard both paths share: the retry timer reads it
  // to choose between reconnecting and merely re-syncing, so a session that wrongly believes it
  // holds a socket never opens another one.
  const onSocketDown = (): void => {
    const openedAtMs = socketOpenedAtMs;
    socketOpenedAtMs = undefined;
    connectedFlag = false;
    closeSocket = undefined;
    notify();
    // A socket the caller shut down deliberately (disconnect()/close(), whose own close fires
    // this handler on a real WebSocket) never failed at anything, so it must not push the ladder
    // along — wantsConnection is precisely "the caller still wants a socket".
    if (!wantsConnection) return;
    // A connection that LIVED at least the base delay did its job and its drop is a fresh event,
    // so the ladder restarts at its first rung; one that died faster than the retry it would earn
    // never really connected, whether or not it managed to fire onopen first.
    const lived = openedAtMs !== undefined && clock.now() - openedAtMs >= RETRY_BASE_MS;
    socketFailures = lived ? 1 : socketFailures + 1;
    // The socket dropping is itself a dirty state: reconnection rides a backoff of its own, so
    // there is no reachable state in which the session has stopped trying — and no state in
    // which it retries at a fixed floor forever either.
    scheduleRetry(reconnectDelayMs());
  };

  const doConnect = (): void => {
    // A closed session stays closed: without this, connect() after close() re-licenses the loop
    // (wantsConnection = true) while closedFlag makes every scheduleRetry decline — a session
    // that claims to be connected and can never retry, with no way out.
    if (closedFlag) return;
    if (connectedFlag) return; // idempotent
    wantsConnection = true; // licenses the retry loop
    connectedFlag = true;
    try {
      closeSocket = transport.openSocket(
        (events) => ingest(events), // socket events carry no nextSeq — the cursor never moves through them
        onSocketDown,
        // The REAL trigger for the catch-up sync: a real WebSocket is CONNECTING (not
        // OPEN) for a while after openSocket() returns, and events landing in that gap
        // reach neither the pull just below (already ran) nor the socket (not open yet)
        // unless something re-syncs exactly when it opens. Through the same serialized gate as
        // every other trigger; warn-and-drop, see requestSyncInBackground()'s comment.
        () => {
          // Stamped, not reset: reaching open starts the clock that onSocketDown reads to decide
          // whether this was a real connection. "openSocket() was called" is evidence of nothing,
          // and "onopen fired" is barely more — see socketOpenedAtMs's own comment.
          socketOpenedAtMs = clock.now();
          requestSyncInBackground();
        },
      );
    } catch (error) {
      // Effectively unreachable today (the URL is fixed for the session's life), but the state
      // it would otherwise leave is not self-correcting. Swallowed rather than rethrown — this
      // runs from the retry timer as well as from connect(), where an escaping throw would be an
      // uncaught error rather than something a caller could act on. Same log-and-drop precedent
      // as persistInBackground().
      console.warn(`swng client: failed to open the round socket for ${config.roundId}`, error);
      onSocketDown();
    }
    notify();
    // Also fire a sync immediately, without waiting for the real open: this is what
    // catches up a session that's constructed and connected while already offline (the
    // socket may never open, or take a long time to fail), and it's free — the onOpen
    // sync above just coalesces onto it (or vice versa) through the same gate rather than
    // running twice.
    requestSyncInBackground();
  };

  const doDisconnect = (): void => {
    // Stopping the loop is unconditional, ABOVE the already-disconnected guard: the socket
    // dropping schedules a retry while connectedFlag is already false, so a guard-first order
    // would let close()/disconnect() skip these two lines entirely and leave a live timer whose
    // callback re-opens the socket (`wantsConnection && !connectedFlag` → doConnect()) on a
    // session the caller has finished with. Pinned by the close()-after-drop test.
    wantsConnection = false;
    clearRetry();
    setStalled(false); // nothing is trying any more, so stalled() must not outlive the loop
    // A user-initiated reconnect deserves a fresh attempt, not the dead network's leftover
    // patience: without this, stall → disconnect() → connect() re-raises stalled() on the very
    // first failure and then waits the full 30s cap before trying again. Both ladders, for the
    // same reason.
    retryDelayMs = RETRY_BASE_MS;
    socketFailures = 0;
    socketOpenedAtMs = undefined;
    lastPassOk = true;
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
      // Cached beside cachedState, invalidated by the same invalidateCache() call — same
      // trigger, so the two can never drift out of sync with each other.
      if (!cachedGames) {
        const currentState = computeState();
        cachedGames = currentState.games.filter((gameConfig) => KNOWN_GAME_KINDS.has(gameConfig.kind)).map((gameConfig) => scoreGame(gameConfig, currentState));
      }
      return cachedGames;
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
      // every other trigger — see requestSync()'s comment. Warn-and-drop, not `void`
      // directly — see requestSyncInBackground()'s comment.
      // Gated on wantsConnection, NOT connectedFlag: a live socket is not what makes an HTTP
      // push possible, and binding the attempt to it is what made a silently-dead socket
      // unrecoverable (no banner, so no "Sync now" button, so nothing left to press). If this
      // attempt fails, onPassSettled schedules the retry that finishes the job.
      if (wantsConnection) requestSyncInBackground();
    },

    sync: () => requestSync(),

    connect: () => doConnect(),

    disconnect: () => doDisconnect(),

    connected: () => connectedFlag,

    stalled: () => stalledFlag,

    pending: () => pending.length,

    rejected: () => rejectedOps,

    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    hydrated: () => hydratedFlag,

    close: async () => {
      closedFlag = true;
      doDisconnect();
      // Await whatever sync pass is currently in flight BEFORE the final persist — a
      // pass is bounded by the transport's own REQUEST_TIMEOUT_MS (offline is a resolved
      // outcome, and a hung connection is aborted rather than waited on forever), so this
      // never turns close() into a hang. Swallowed here deliberately: the pass's own
      // caller (an explicit sync(), or requestSyncInBackground()'s warn-and-drop) already
      // owns reporting that rejection — close() rejecting is reserved for its OWN final
      // save failing (M4 semantics), not for a concurrent pass's unrelated failure. Waiting
      // for it first also means the final snapshot persist() captures reflects the pass's
      // settled pending/lastSeq, not a stale mid-pass snapshot.
      const inFlightPass = syncRunning;
      if (inFlightPass) await inFlightPass.catch(() => {});
      await persist();
    },
  };

  return session;
};
