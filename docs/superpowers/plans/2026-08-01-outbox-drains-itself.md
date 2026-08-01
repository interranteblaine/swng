# The Outbox Drains Itself Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Queued scores drain on their own and are never deleted from the device, and a refusal against a finalized round is counted.

**Architecture:** Three changes to `@swng/client`'s sync loop plus one application-layer guard. Rejected ops become part of the persisted outbox shape. A backoff loop inside the SDK retries while the session is dirty; `apps/web` adds DOM wake signals (`online`/`visibilitychange`/`focus`) as pure accelerators. `recordScore` treats a re-push of an already-recorded opId as idempotent, and counts a genuinely-new score refused by a `final` round as `LateScoreRefused`.

**Tech Stack:** TypeScript (ESM, nodenext), pnpm monorepo, Vitest (node for `@swng/client`, happy-dom for `apps/web`), React 19, AWS CDK (`aws-cdk-lib`), Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-01-outbox-drains-itself-design.md`

## Global Constraints

- **Task order is load-bearing.** Tasks 1 and 2 (stop deleting / stop misreporting a score) MUST land before Task 3 (automatic retry). Auto-drain finds finalized rounds on its own and would delete those scores unattended. Do not reorder.
- **No wire schema change.** `packages/contracts` is not modified by any task in this plan.
- **No data migration.** The IndexedDB adapter stores the whole `PersistedSync` blob under one key with no per-field schema, so a record written before `rejected` existed loads with it absent. Every read of a persisted field defends with `?? <default>`, matching the existing `persisted?.pending ?? []` idiom.
- **Layering.** `@swng/client` may import `@swng/domain` and `@swng/contracts` only (lint-enforced). `@swng/client` has no vitest config, so its tests run under **node** — it must never reference `window` or `document`. All DOM code lives in `apps/web` (happy-dom).
- **`pnpm validate` must pass at every commit** (lint + typecheck + build + test). Run it before every commit step, not just at the end.
- Tests are Vitest, co-located as `*.test.ts` / `*.test.tsx`, importing from `vitest` explicitly.
- Relative imports inside a package use the `.js` extension (nodenext). Typecheck enforces this; build and vitest do not.

---

### Task 1: Rejected ops are durable

A permanently-refused score is currently dropped from `pending`, that drop is persisted, and the only remaining copy lives in an in-memory array. This task makes the refused op part of the persisted shape so a reload no longer destroys it.

**Files:**
- Modify: `packages/client/src/outbox.ts`
- Modify: `packages/client/src/session.ts:12-15` (delete the local `RejectedOp`), `:89` (seed from persisted), `:133` (include in the snapshot)
- Test: `packages/client/src/outbox.test.ts`, `packages/client/src/session.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RejectedOp` now originates in `outbox.ts` (`{ readonly event: RoundEvent; readonly code: string }`) and `PersistedSync` gains `readonly rejected: readonly RejectedOp[]`. Task 3 relies on both.

- [ ] **Step 1: Write the failing store test**

Add to `packages/client/src/outbox.test.ts`, after the existing `SCORE_EVENT` const:

```ts
const REJECTED_OP: RejectedOp = { event: SCORE_EVENT, code: "round-not-live" };
```

and add this import alongside the existing `PersistedSync` type import:

```ts
import type { PersistedSync, RejectedOp } from "./outbox.js";
```

Then add this test inside the existing `describe("createMemoryOutboxStore", ...)` block:

```ts
  it("round-trips a rejected op — a permanently refused score is never dropped from the persisted shape", async () => {
    const store = createMemoryOutboxStore();
    const sync: PersistedSync = { pending: [], lastSeq: 5, opCounter: 1, rejected: [REJECTED_OP] };

    await store.save(roundId("round-1"), sync);

    await expect(store.load(roundId("round-1"))).resolves.toEqual(sync);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @swng/client vitest run src/outbox.test.ts`
Expected: FAIL — TypeScript reports `rejected` does not exist on `PersistedSync`, and the pre-existing literals in this file are missing it.

- [ ] **Step 3: Add `RejectedOp` and the `rejected` field**

Replace the type block at the top of `packages/client/src/outbox.ts` with:

```ts
import type { RoundEvent, RoundId } from "@swng/domain";

// An op the server refused PERMANENTLY (a real 4xx — a finalized round, a score for someone
// who never joined), as opposed to a transient failure that just stays queued. It is kept,
// never deleted: an unpushed event exists nowhere but this device, so dropping it is the only
// unrecoverable thing this SDK can do. The archive it failed to reach is re-derivable; this
// is not.
export interface RejectedOp {
  readonly event: RoundEvent;
  readonly code: string;
}

// What a session needs to survive a restart: the still-unconfirmed outbox, the ops that were
// refused, the pull cursor, and the opId counter. Confirmed events are deliberately NOT part
// of this shape (derive, don't store) — a restarted session re-pulls them from the server
// instead.
export interface PersistedSync {
  readonly pending: readonly RoundEvent[];
  readonly lastSeq: number;
  // Highest opId counter minted on this device — persisted so a restarted session can
  // NEVER re-mint an opId it already used (a reused opId would make the server silently
  // drop the new event as a duplicate of the old one).
  readonly opCounter: number;
  // Required on the type, defaulted on read: a record written before this field existed loads
  // without it, and `persisted?.rejected ?? []` is what tolerates that — the same defence the
  // equally-required `pending` already gets. No migration, no store version bump.
  readonly rejected: readonly RejectedOp[];
}
```

- [ ] **Step 4: Fix the compile-forced literals**

`rejected: []` must be added to every existing `PersistedSync` literal in `packages/client/src/outbox.test.ts`, `packages/client/src/indexedDbOutbox.test.ts`, and `packages/client/src/session.test.ts`. Find them with:

Run: `rg -n "opCounter:" packages/client/src`

- [ ] **Step 5: Run the store test to verify it passes**

Run: `pnpm -F @swng/client vitest run src/outbox.test.ts src/indexedDbOutbox.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing session tests**

Add to `packages/client/src/session.test.ts`. The `legacyStore` helper simulates a record written before the field existed — the cast is at the store boundary, deliberately, and is the only place in the codebase that constructs the old shape:

```ts
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
```

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm -F @swng/client vitest run src/session.test.ts -t "rejected ops are durable"`
Expected: FAIL — the first case returns `[]` (rejected is never seeded), the second returns `[]` after restart.

- [ ] **Step 8: Seed and persist `rejectedOps`**

In `packages/client/src/session.ts`:

Delete the local interface at lines 12-15:

```ts
export interface RejectedOp {
  readonly event: RoundEvent;
  readonly code: string;
}
```

Change the outbox import to bring `RejectedOp` in from its new home:

```ts
import type { OutboxStore, PersistedSync, RejectedOp } from "./outbox.js";
```

Seed it from the persisted record (replacing `let rejectedOps: readonly RejectedOp[] = [];`):

```ts
  // Seeded, not started empty: a refused op is the ONLY copy of that score anywhere, so it
  // survives the restart exactly as `pending` does.
  let rejectedOps: readonly RejectedOp[] = persisted?.rejected ?? [];
```

And include it in the snapshot inside `persist()`:

```ts
    const snapshot: PersistedSync = { pending, lastSeq, opCounter, rejected: rejectedOps };
```

- [ ] **Step 9: Run the whole client suite**

Run: `pnpm -F @swng/client test`
Expected: PASS

- [ ] **Step 10: Validate and commit**

Run: `pnpm validate`
Expected: exit 0

```bash
git add packages/client/src/outbox.ts packages/client/src/session.ts packages/client/src/outbox.test.ts packages/client/src/session.test.ts packages/client/src/indexedDbOutbox.test.ts
git commit -m "fix(client): a refused score stays on the device"
```

---

### Task 2: A re-push is idempotent, whatever the round's status

If a device pushed a score successfully but never pulled the confirmation, the score is still in its outbox. A later re-push against a now-final round is refused — reporting (and, before Task 1, deleting) a score that is safely on the server. `loadRoundState` already returns the events, so this costs no extra read.

**Files:**
- Modify: `packages/application/src/rounds/recordScore.ts:16-18`
- Test: `packages/application/src/rounds/roundSlice.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `recordScore` returns `{ duplicate: true }` for an opId already in the log, before the status check. Task 6 adds a metric to the status arm this guard now protects.

- [ ] **Step 1: Write the failing test**

Add to `packages/client`… no — add to `packages/application/src/rounds/roundSlice.test.ts`, directly after the existing `it("rejects recordScore on a finalized round — round-not-live", ...)` case:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @swng/application vitest run src/rounds/roundSlice.test.ts -t "RE-push"`
Expected: FAIL — rejects with `{ code: "round-not-live" }` instead of resolving.

- [ ] **Step 3: Add the guard**

In `packages/application/src/rounds/recordScore.ts`, replace lines 16-18 with:

```ts
    const { events, state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    // A re-push of a score this log ALREADY holds is idempotent whatever the round's status.
    // The shape it exists for: a device pushed successfully but never pulled the confirmation,
    // so the event is still in its outbox; a later drain finds the round finalized. Refusing
    // there would report — and, before the outbox kept them, delete — a score that is safely
    // stored. This runs after the auth check (a stranger learns nothing) and before the status
    // check (the status is exactly what must not matter here). No extra read: loadRoundState
    // already returned the events.
    if (events.some((event) => event.opId === command.opId)) return { duplicate: true };
    if (state.status !== "live") throw new ApplicationError("round-not-live");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @swng/application vitest run src/rounds/roundSlice.test.ts`
Expected: PASS — including the existing "rejects recordScore on a finalized round" case, which uses a fresh opId and must still throw.

- [ ] **Step 5: Validate and commit**

Run: `pnpm validate`
Expected: exit 0

```bash
git add packages/application/src/rounds/recordScore.ts packages/application/src/rounds/roundSlice.test.ts
git commit -m "fix(rounds): a re-pushed score is a duplicate, not a refusal"
```

---

### Task 3: The outbox drains itself

The SDK gains a backoff loop. While the session is dirty it keeps trying on its own; when it is clean, no timer exists.

**Files:**
- Modify: `packages/client/src/session.ts`
- Test: `packages/client/src/session.test.ts`

**Interfaces:**
- Consumes: `RejectedOp`/`PersistedSync` from Task 1.
- Produces: `RoundSession` gains `stalled(): boolean` — true once consecutive failed passes have driven the backoff to its 30s cap (four failures). Tasks 4 and 5 consume it. `pushPending` becomes `Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/client/src/session.test.ts`. These use fake timers; `advanceTimersByTimeAsync` is required (not the sync variant) so the promise chains inside a pass actually run:

```ts
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
    await vi.advanceTimersByTimeAsync(0);
    expect(session.stalled()).toBe(false);

    // 2s + 4s + 8s + 16s of retries = the fourth consecutive failure, which is the cap.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.stalled()).toBe(true);
  });

  it("a successful pass resets the backoff and clears stalled()", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);
    transport.offline = true;
    session.connect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.stalled()).toBe(true);

    transport.offline = false;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.stalled()).toBe(false);
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

  it("never touches the network for a session that never called connect()", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const session = await liveSession(transport);

    session.recordScore(ANN_ID, 1, toResult(4));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(transport.pushedOpIds).toEqual([]);
    expect(session.pending()).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @swng/client vitest run src/session.test.ts -t "drains itself"`
Expected: FAIL — `session.stalled` is not a function; the queue never drains without an explicit `sync()`.

- [ ] **Step 3: Add the retry constants and state**

In `packages/client/src/session.ts`, add below the existing `isTransientPushFailure` const:

```ts
// Retry cadence for the self-draining outbox. The SDK owns this deliberately: M4 deferred
// "retry cadence" to the UI and no UI ever claimed it, so the policy existed nowhere and a
// dropped socket meant a golfer had to press a button to make a queued score leave the phone.
// Correctness lives here; apps/web's wake signals (online/visibilitychange/focus) are pure
// accelerators on top.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
```

And add to the session's state block, next to `let connectedFlag = false;`:

```ts
  // connect() was called and no disconnect()/close() has happened since. This — not the socket
  // flag — is what licenses the loop to touch the network, preserving M4's contract that a
  // session which never connects never makes a request on its own.
  let wantsConnection = false;
  let retryDelayMs = RETRY_BASE_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stalledFlag = false;
  let closedFlag = false;
```

- [ ] **Step 4: Make `pushPending` report transient failure**

Change its signature and the two exit points in `packages/client/src/session.ts`:

```ts
  const pushPending = async (): Promise<boolean> => {
    const toPush = [...pending];
    for (const event of toPush) {
      try {
        await transport.push(event);
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
```

(The `// Deliberately NOT pruned here on a bare push success` comment inside the `try` stays exactly as it is.)

- [ ] **Step 5: Add the loop and settle both arms of `doSync`**

Replace `doSync` in `packages/client/src/session.ts` with the following, and add the four helpers below it (before `requestSync`):

```ts
  const doSync = async (): Promise<void> => {
    const pushOk = await pushPending();
    try {
      const { events, nextSeq } = await transport.pull(lastSeq);
      ingest(events, nextSeq);
      onPassSettled(pushOk);
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      // Offline: sync() resolves without throwing — the queue IS the feature.
      onPassSettled(false);
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
  // forever. Delay sequence on consecutive failures: 2s, 4s, 8s, 16s, then the 30s cap, which is
  // what stalled() reports.
  const onPassSettled = (ok: boolean): void => {
    const wasStalled = stalledFlag;
    const delayMs = ok ? RETRY_BASE_MS : retryDelayMs;
    if (ok) {
      retryDelayMs = RETRY_BASE_MS;
      stalledFlag = false;
    } else {
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
      if (retryDelayMs >= RETRY_MAX_MS) stalledFlag = true;
    }
    if (isDirty()) scheduleRetry(delayMs);
    else clearRetry();
    if (stalledFlag !== wasStalled) notify();
  };
```

- [ ] **Step 6: Extract `doConnect` and schedule a retry when the socket drops**

`scheduleRetry` references `doConnect`, so the connect body moves out of the object literal. Add this immediately above `doDisconnect` in `packages/client/src/session.ts` — it is the existing `connect` body, unchanged except for the two marked lines:

```ts
  const doConnect = (): void => {
    if (connectedFlag) return; // idempotent
    wantsConnection = true; // NEW: licenses the retry loop
    connectedFlag = true;
    closeSocket = transport.openSocket(
      (events) => ingest(events), // socket events carry no nextSeq — the cursor never moves through them
      () => {
        connectedFlag = false;
        closeSocket = undefined;
        notify();
        // The socket dropping is itself a dirty state: reconnection rides the same backoff as
        // a stuck push, so there is no reachable state in which the session has stopped trying.
        scheduleRetry(retryDelayMs); // NEW
      },
      () => requestSyncInBackground(),
    );
    notify();
    requestSyncInBackground();
  };
```

Then, in the session object literal, replace the whole `connect: () => { ... }` property with:

```ts
    connect: () => doConnect(),
```

- [ ] **Step 7: Stop gating the push on the socket, and clean up on disconnect/close**

In `recordScore`, replace `if (connectedFlag) requestSyncInBackground();` with:

```ts
      // Gated on wantsConnection, NOT connectedFlag: a live socket is not what makes an HTTP
      // push possible, and binding the attempt to it is what made a silently-dead socket
      // unrecoverable (no banner, so no "Sync now" button, so nothing left to press). If this
      // attempt fails, onPassSettled schedules the retry that finishes the job.
      if (wantsConnection) requestSyncInBackground();
```

In `doDisconnect`, add the two lines after `connectedFlag = false;`:

```ts
    wantsConnection = false;
    clearRetry();
```

In `close`, add before `doDisconnect()`:

```ts
      closedFlag = true;
```

- [ ] **Step 8: Expose `stalled()`**

Add to the `RoundSession` interface, below `connected(): boolean;`:

```ts
  // True once consecutive failed sync passes have driven the retry backoff to its cap (four
  // failures). The chrome's escalation signal — "we are still trying and it is still not
  // working" — as distinct from connected(), which only ever described the socket.
  stalled(): boolean;
```

And to the session object literal, below `connected: () => connectedFlag,`:

```ts
    stalled: () => stalledFlag,
```

- [ ] **Step 9: Run the client suite**

Run: `pnpm -F @swng/client test`
Expected: PASS — including the pre-existing socket-lifecycle and convergence tests.

- [ ] **Step 10: Validate and commit**

Run: `pnpm validate`
Expected: exit 0

```bash
git add packages/client/src/session.ts packages/client/src/session.test.ts
git commit -m "feat(client): the outbox drains itself"
```

---

### Task 4: The hook exposes `stalled` and wires the wake signals

`useRoundSession` surfaces the new state and adds the three DOM events that turn "the phone came out of the pocket" into an immediate sync instead of a backoff tick.

**Files:**
- Modify: `apps/web/src/session/useRoundSession.ts`
- Test: `apps/web/src/session/useRoundSession.test.tsx`

**Interfaces:**
- Consumes: `session.stalled()` from Task 3.
- Produces: `RoundSessionView` gains `readonly stalled: boolean`. Task 5 consumes it.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/session/useRoundSession.test.tsx`:

This file has no shared render helper — each test builds its own `resolveSessionConfig` inline and calls `renderHook(() => useRoundSession(ROUND_ID))`. Follow that, reusing the file's existing `buildServerLog`, `ROUND_ID`, and `ANN_ID`:

```ts
describe("useRoundSession — wake signals", () => {
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

  it("removes its listeners on unmount — a dispatched event after teardown syncs nothing", async () => {
    const transport = createScriptedTransport(buildServerLog());
    const { result, unmount } = liveHook(transport);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    unmount();
    const pullsAfterUnmount = transport.pullCalls;

    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(transport.pullCalls).toBe(pullsAfterUnmount);
  });
});
```

Add `ScriptedTransport` to the existing `createScriptedTransport` import as a type import.

This needs a pull counter on the shared double. In `apps/web/src/testSupport/scriptedTransport.ts`, add `pullCalls: number;` to the `ScriptedTransport` interface, initialise it to `0` in the object literal, and increment it as the first statement of `pull` — **before** the `offline` throw, so a failed attempt still counts as an attempt.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @swng/web vitest run src/session/useRoundSession.test.tsx -t "wake signals"`
Expected: FAIL — `pullCalls` never increases; no listener exists.

- [ ] **Step 3: Add `stalled` to the snapshot**

In `apps/web/src/session/useRoundSession.ts`, add `readonly stalled: boolean;` to both `RoundSessionView` and `Snapshot`, add `stalled: false` to `IDLE_SNAPSHOT`, and add `stalled: session.stalled(),` to the object `snapshotOf` returns.

- [ ] **Step 4: Add the wake listeners**

Add this effect in `useRoundSession`, immediately after the existing session-construction `useEffect`:

```ts
    // Wake signals. These are pure accelerators — @swng/client's backoff loop drains the outbox
    // on its own whether or not anything here is wired; these just collapse the wait when the
    // device tells us something changed. `focus` and `visibilitychange` are what cover a phone
    // coming back from a locked screen, where no `online` event fires because the radio never
    // actually dropped. Nothing can run while a tab is fully suspended (Background Sync is not
    // in Safari) — visibilitychange firing on resume is the answer to that, not a service worker.
    useEffect(() => {
      const wake = (): void => {
        // Swallowed: an explicit caller owns reporting its own sync failure, and this one has no
        // caller — same warn-and-drop shape as the SDK's own opportunistic triggers.
        void sessionRef.current?.sync().catch(() => {});
      };
      const onVisibility = (): void => {
        if (document.visibilityState === "visible") wake();
      };
      window.addEventListener("online", wake);
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.removeEventListener("online", wake);
        window.removeEventListener("focus", wake);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }, []);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F @swng/web vitest run src/session/useRoundSession.test.tsx`
Expected: PASS

- [ ] **Step 6: Validate and commit**

Run: `pnpm validate`
Expected: exit 0

```bash
git add apps/web/src/session/useRoundSession.ts apps/web/src/session/useRoundSession.test.tsx apps/web/src/testSupport/scriptedTransport.ts
git commit -m "feat(web): the round session wakes on signal, focus, and visibility"
```

---

### Task 5: The chrome describes the queue, not the socket

"Offline" describes the WebSocket, which will be closed on a perfect connection (API Gateway caps connection duration well below the length of a round; phones lock and background). The banner's subject becomes the queue.

**Files:**
- Modify: `apps/web/src/round/StatusChrome.tsx`, `apps/web/src/routes/RoundPage.tsx`
- Test: `apps/web/src/round/StatusChrome.test.tsx`

**Interfaces:**
- Consumes: `RoundSessionView.stalled` from Task 4.
- Produces: `StatusChromeProps` drops `connected` and gains `stalled: boolean`. `onReconnect` keeps its name and meaning.

- [ ] **Step 1: Write the failing tests**

Replace the `describe("StatusChrome — offline banner", ...)` block in `apps/web/src/round/StatusChrome.test.tsx` with:

```ts
describe("StatusChrome — the queue is the subject", () => {
  it("names the queue, and where the scores are, while it drains", () => {
    render(<StatusChrome stalled={false} pending={2} rejected={[]} participants={participants} onReconnect={NOOP} />);

    expect(screen.getByRole("status")).toHaveTextContent("2 scores saved on this phone — syncing…");
    expect(screen.queryByRole("button", { name: "Try now" })).toBeNull();
  });

  it("says nothing at all when there is nothing queued and nothing wrong", () => {
    render(<StatusChrome stalled={false} pending={0} rejected={[]} participants={participants} onReconnect={NOOP} />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("escalates only once stalled, and keeps a manual retry there as a backstop", () => {
    const onReconnect = vi.fn();
    render(<StatusChrome stalled pending={2} rejected={[]} participants={participants} onReconnect={onReconnect} />);

    expect(screen.getByRole("status")).toHaveTextContent("Can't reach swng — your scores are safe here.");
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @swng/web vitest run src/round/StatusChrome.test.tsx`
Expected: FAIL — TypeScript rejects the missing `connected` prop; the copy does not match.

- [ ] **Step 3: Rewrite the props and the banner**

In `apps/web/src/round/StatusChrome.tsx`, replace the `connected` prop with:

```ts
  // NOT the socket. The socket closes on a perfectly good connection — API Gateway caps
  // connection duration well below the length of a round, and phones lock and background — so
  // "Offline" was a claim about our own plumbing that a golfer with full bars could read as a
  // claim about theirs. `stalled` says the only thing worth saying: we are still trying, and it
  // is still not working.
  readonly stalled: boolean;
```

and replace the `{!connected && (...)}` block and the `{pending > 0 && (...)}` block with:

```tsx
      {stalled ? (
        <div role="status" className="flex items-center justify-between gap-2 border border-gold bg-goldwash px-3 py-2 text-sm text-forest">
          <p>Can&apos;t reach swng — your scores are safe here.</p>
          <button type="button" onClick={onReconnect} className="min-h-8 shrink-0 border border-forest px-2 text-xs font-medium text-forest">
            Try now
          </button>
        </div>
      ) : (
        pending > 0 && (
          <p role="status" className="text-xs text-fairway">
            {pending} score{pending === 1 ? "" : "s"} saved on this phone — syncing…
          </p>
        )
      )}
```

Update the component signature to `{ stalled, pending, rejected, participants, onReconnect }` and the `onReconnect` doc comment: it is now a backstop inside the escalated state, not the only way to resume.

- [ ] **Step 4: Update the one call site**

There is exactly one, at `apps/web/src/routes/RoundPage.tsx:496`, and it reads the hook view directly — no props chain to thread (`LiveRoundProps.pending` is a separate prop feeding `FinalizeControl`, and is not touched by this task):

```tsx
        <StatusChrome
          stalled={session.stalled}
          pending={session.pending}
          rejected={session.rejected}
          participants={session.state.participants}
          onReconnect={reconnect}
        />
```

Confirm with `rg -n "<StatusChrome" apps/web/src` that no second call site has appeared.

- [ ] **Step 5: Run the web suite**

Run: `pnpm -F @swng/web test`
Expected: PASS

- [ ] **Step 6: Validate and commit**

Run: `pnpm validate`
Expected: exit 0

```bash
git add apps/web/src/round/StatusChrome.tsx apps/web/src/round/StatusChrome.test.tsx apps/web/src/routes/RoundPage.tsx
git commit -m "feat(web): the status chrome describes the queue, not the socket"
```

---

### Task 6: `LateScoreRefused` — count the real losses

With Task 2's guard in place, a refusal against a `final` round is a genuinely unrecorded score. Count exactly that, so the decision to build anything more for the multi-device case is earned by data.

**Files:**
- Modify: `packages/application/src/rounds/recordScore.ts`, `packages/lambda/src/compositionRoot.ts:324`, `apps/infra-cdk/lib/swngStack.ts`
- Test: `packages/application/src/rounds/roundSlice.test.ts`, `apps/infra-cdk/test/swngStack.test.ts`

**Interfaces:**
- Consumes: Task 2's duplicate guard (without it this metric counts scores that are safely stored).
- Produces: EMF metric `LateScoreRefused` in namespace `swng`, dimension `Stage`.

- [ ] **Step 1: Write the failing tests**

Two files, because the `final` and `abandoned` arms live in two harnesses that already do the relevant setup. Neither `setup()` currently returns `journal`, so wire the fake into the harness's own `record` rather than constructing a second use case.

**a. `packages/application/src/rounds/roundSlice.test.ts`** — in `setup()`, add `const metrics = createCapturingMetrics();` beside the other fakes, change the wiring to `record: recordScore({ journal, broadcast, metrics }),`, and add `metrics,` to the returned object. Then:

```ts
describe("recordScore — metrics", () => {
  it("counts LateScoreRefused when a NEW score is refused by a finalized round", async () => {
    const round = await freshLiveRound();
    const hostClaims: ParticipantClaims = { roundId: round.host.roundId, golferId: round.host.golferId };
    await round.finalize(hostClaims);
    const annPhone = createClientOps("ann-phone");

    await expect(round.record(hostClaims, { golferId: round.host.golferId, hole: 1, result: toResult(4), ...annPhone() })).rejects.toMatchObject({ code: "round-not-live" });

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
```

**b. `packages/application/src/rounds/abandonRound.test.ts`** — this harness already wires both `record` and `abandon` (`:79`, `:81`). Make the same three edits to its `setup()` (`createCapturingMetrics()`, `record: recordScore({ journal, broadcast, metrics })`, return `metrics`), then add:

```ts
describe("recordScore on a scrapped round — metrics", () => {
  it("counts nothing: an abandoned round settles nothing, so a refused score loses nothing", async () => {
    const round = await setup();
    const claims = await liveRoundWithHost(round); // reuse whatever this file already uses to seat a host
    await round.abandon(claims);

    await expect(round.record(claims, { golferId: claims.golferId, hole: 1, result: toResult(4), ...clientOp() })).rejects.toMatchObject({ code: "round-not-live" });

    expect(round.metrics.calls).toEqual([]);
  });
});
```

Read this file's existing abandon tests and reuse their exact seating helper and op-minting helper in place of the two placeholder calls above — every abandon test in the file already builds a live round with a participant, so copy that setup verbatim rather than inventing a second one.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @swng/application vitest run src/rounds/roundSlice.test.ts -t "recordScore — metrics"`
Expected: FAIL — `recordScore` does not accept `metrics`.

- [ ] **Step 3: Emit the metric**

In `packages/application/src/rounds/recordScore.ts`, add the import:

```ts
import type { Metrics } from "../ports/metrics.js";
```

widen the deps to `(deps: { journal: EventJournal; broadcast: Broadcast; metrics?: Metrics })`, and replace the status check with:

```ts
    if (state.status !== "live") {
      // `final` ONLY. A score refused by a finalized round is a real, unrecorded score: it was
      // played, it is on someone's phone, and the settled archive does not contain it. An
      // abandoned round settles nothing and counts nowhere, so refusing it loses nothing. This
      // sits AFTER the duplicate guard above deliberately — without it, a device re-pushing a
      // score that is already stored would inflate this metric with losses that never happened.
      if (state.status === "final") deps.metrics?.count("LateScoreRefused");
      throw new ApplicationError("round-not-live");
    }
```

- [ ] **Step 4: Wire it in the composition root**

In `packages/lambda/src/compositionRoot.ts:324`:

```ts
    recordScore: recordScore({ journal, broadcast, metrics }),
```

- [ ] **Step 5: Run the application + lambda suites**

Run: `pnpm -F @swng/application test && pnpm -F @swng/lambda test`
Expected: PASS

- [ ] **Step 6: Add the alarm and the dashboard widget**

In `apps/infra-cdk/lib/swngStack.ts`, add this alarm beside the existing `SignupSpikeAlarm` (same `paged(...)` wrapper):

```ts
    paged(
      new Alarm(this, "LateScoreRefusedAlarm", {
        alarmDescription: "A score was refused because its round had already finalized — a played score that is not in the settled archive. Expected to be zero; any occurrence names a round worth looking at.",
        metric: new Metric({
          namespace: "swng",
          metricName: "LateScoreRefused",
          dimensionsMap: { Stage: stage },
          period: FIFTEEN_MINUTES,
          statistic: "Sum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // Not an M-of-N transient: this is a discrete "go look" event, not a blip to ride out.
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
```

Define `FIFTEEN_MINUTES` next to the existing `FIVE_MINUTES` const (`const FIFTEEN_MINUTES = Duration.minutes(15);`), and add the metric to the business widget:

```ts
        left: [swngCount("RoundsCreated"), swngCount("RoundsFinalized"), swngCount("Signups"), swngCount("LateScoreRefused")],
```

- [ ] **Step 7: Pin the alarm in the stack test**

`apps/infra-cdk/test/swngStack.test.ts` asserts the alarm count in **two** places that both fail on an 8th alarm — `template.resourceCountIs("AWS::CloudWatch::Alarm", 7)` (`:909`) and `expect(alarmEntries.length).toBe(7)` inside the "every alarm targets the one AlarmsTopic" test (`:919`). Change both to `8`, and update the count test's title to name the addition (it enumerates the set). Then add, inside the same `describe("alarms ...")` block:

```ts
    it("alarms on any late score refused — a played score missing from a settled archive", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "swng",
        MetricName: "LateScoreRefused",
        Statistic: "Sum",
        Period: 900,
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });
```

The topic test's loop is the reason the count matters twice: it proves the new alarm actually pages rather than ringing nowhere.

- [ ] **Step 8: Validate and commit**

Run: `pnpm validate`
Expected: exit 0

```bash
git add packages/application/src/rounds/recordScore.ts packages/application/src/rounds/roundSlice.test.ts packages/lambda/src/compositionRoot.ts apps/infra-cdk/lib/swngStack.ts apps/infra-cdk/test/swngStack.test.ts
git commit -m "feat(ops): count a score refused by a finalized round"
```

---

### Task 7: E2E reconciliation — the queue drains without the tap

Two specs assert the manual recovery, and their comments name the absent timer as the reason for it. Both oracles are now stale in the product's favour: the correct assertion is that nobody taps anything.

**Files:**
- Modify: `apps/web/e2e/killNetwork.spec.ts`, `apps/web/e2e/fieldTest.spec.ts`

**Interfaces:**
- Consumes: Tasks 3-5.
- Produces: nothing downstream.

- [ ] **Step 1: Find every assertion on the old chrome and the old recovery**

Run: `rg -n "Sync now|Offline|scores? syncing" apps/web/e2e`

Every hit is either a tap to remove or copy to re-derive. Note them all before editing — the copy changed in Task 5 (`Offline — scores queue…` → `N scores saved on this phone — syncing…` / `Can't reach swng — your scores are safe here.`), so a locator can silently stop matching without failing loudly.

- [ ] **Step 2: Reconcile `killNetwork.spec.ts` arm 1**

Test 2's title and body claim the queue cannot move without a tap. Retitle it to `"2: B's socket is force-closed (network otherwise fine) — B's OWN new score renders locally and queues"`, replace the `Offline` banner assertion with the new queue copy, and replace the stale explanatory comment (the one citing `if (connectedFlag)` and "no reconnect timer") with the current mechanism: the push is attempted, the socket is what dropped, and the backoff loop owns the recovery.

Test 3 becomes the drain-without-a-tap assertion. Delete the `getByRole("button", { name: "Sync now" }).click()` line and give the drain assertion room for the backoff (base 2s, and the socket must re-open first):

```ts
    await expect(pageB.getByText(/saved on this phone/)).not.toBeVisible({ timeout: 20_000 });
```

Keep every existing convergence assertion in that test unchanged — the "no dupes" pin and the exact `"●65"` cell pin are what prove the drain is correct, not merely that it happened, and they are unaffected by how the sync was triggered.

- [ ] **Step 3: Reconcile `fieldTest.spec.ts` step 6**

Step 6 taps `Sync now` after B's offline stretch. B is CDP-offline there, so bringing the context back online fires the browser's own `online` event and Task 4's wake listener syncs immediately. Delete the tap, retitle the step to say the queue drains on its own when signal returns, and leave the skins-refold and cross-browser assertions exactly as they are.

- [ ] **Step 4: Run the two specs against beta**

Run: `pnpm e2e:field -- killNetwork.spec.ts fieldTest.spec.ts`
Expected: PASS. This requires AWS credentials and the deployed beta stack, and is NOT part of `pnpm validate`. If the app changes here have not been deployed yet, this step runs at close-out instead — note that and carry on.

- [ ] **Step 5: Validate and commit**

Run: `pnpm validate`
Expected: exit 0

```bash
git add apps/web/e2e/killNetwork.spec.ts apps/web/e2e/fieldTest.spec.ts
git commit -m "test(e2e): the queue drains without the tap"
```

---

## Close-out

Not a task — the controller runs this after Task 7, per the repo's standing close-out discipline.

- `pnpm validate` (exit 0) and `pnpm test:contract` at HEAD.
- **`deploy:beta` LAMBDA-FIRST — required, not precedent.** (Corrected 2026-08-01 after the whole-branch review; the original text here claimed either order was safe, and it was wrong.) Both orders *parse* — no wire schema changed, and `{ duplicate: true }` is already in `recordScoreResponseSchema`. But web-first puts new bundles on real phones that auto-retry against a server still lacking Task 2's duplicate guard: every re-push of an already-recorded score takes a 409 and lands in `rejected` as "couldn't be saved," unattended, which is the exact misreporting Task 2 exists to prevent. Old bundle + new Lambda is strictly better than today. The ordering rule that governs the tasks governs the deploy too.
- `publish:web:beta` (Tasks 4, 5).
- `e2e:beta` ×2, then the full `e2e:field`.
- An adversarial USE pass on the deployed surface, driving the actual failure this arc exists for: put a phone offline mid-round, score three holes, restore signal **without touching anything**, and watch the queue drain. Then force the socket closed with the network healthy and confirm the same. Read the chrome copy on a phone viewport as a design artifact, not just a locator.
- No data wipe. Nothing stored changes shape; the one new persisted field defaults on read.
