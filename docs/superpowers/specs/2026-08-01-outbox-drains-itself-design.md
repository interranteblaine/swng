# The outbox drains itself, and never deletes a score

> Status: **proposed** (2026-08-01, owner design session). Scope: `@swng/client`, `apps/web`,
> one application-layer guard + metric. No wire schema change, no data migration.

## 1. The problem

Offline sync is **manual**. Once the socket closes, nothing retries. `session.ts` says so:

> `// No auto-reconnect timer in v1: the UI owns retry cadence... A caller that wants to`
> `// reconnect calls connect() again.`

No caller ever did. The policy fell in the gap between the SDK and the app, so the only thing
that resumes a session is a golfer tapping **"Sync now"** in the offline banner, or reloading.

Three consequences, worst last.

**a. Signal returning is not an event anything listens for.** You walk out of the dead zone with
full bars and the app still says Offline, for the rest of the round. While it says that,
`recordScore` does not even attempt a push (`session.ts:346` guards on `connectedFlag`), so
scoring the back nine produces zero network activity.

**b. The socket drops for reasons unrelated to signal.** API Gateway caps WebSocket connection
duration and idle time well below the length of a round; phones lock and background. So the
"Offline" banner is *expected* to appear mid-round on a perfect connection — and if the socket
dies without a close frame, `connectedFlag` stays true, no banner renders, and **"Sync now" does
not exist**, because it only renders inside the `!connected` branch.

**c. A permanently-rejected score is deleted from the only durable copy.** `session.ts:214-217`
drops the event from `pending` and persists that drop; the compensating record lives in an
in-memory `rejectedOps` array. `PersistedSync` has no field for it, and `StatusChrome.tsx:8-11`
states the consequence: *"a permanently-rejected op is forgotten on reload."*

The durability ordering is backwards. We durably record the forgetting and transiently record the
thing worth keeping.

### Why (c) is the one that has to land first

A wrongly-settled archive is recoverable — the log is the truth, projections re-derive, and
`projectionStore.ts` already names *"a reopen-and-refinalize (a NEW round-finalized event, a
DIFFERENT finalizedAtMs, the SAME roundId)"* as supported by construction. A deleted score is
recoverable by nothing.

And fixing (a) makes (c) worse. Today a phone holding scores against a finalized round mostly
sits there — nobody taps Sync now, so the events stay safe in the outbox. Automatic retry will
find that round on its own, push, take the 409, and delete the scores with no one touching the
phone. **The mechanism built to stop data loss would automate it on this one path.**

**The ordering rule, which is the load-bearing part of this spec: everything that stops swng
misreporting or deleting a score (§2a and §2c's duplicate guard) lands before automatic retry
(§2b).** The metric may land at any point.

## 2. The model

**Scores are never deleted on this device. The outbox drains itself. Refusals are counted.**

Three changes, in this order.

### 2a. Rejected ops are durable (must land first)

`PersistedSync` gains one field:

```ts
export interface PersistedSync {
  readonly pending: readonly RoundEvent[];
  readonly lastSeq: number;
  readonly opCounter: number;
  readonly rejected: readonly RejectedOp[]; // permanently refused, KEPT — never deleted
}
```

`createRoundSession` seeds `rejectedOps` from `persisted?.rejected ?? []`; every `persist()`
snapshot carries it. The IndexedDB adapter stores the whole `PersistedSync` blob under one key
with no per-field schema, so **no version bump and no migration**: a record written before this
field loads with it absent and defaults to `[]`.

No cap. An event is rejected at most once and leaves `pending` when it is, so the list is bounded
by the number of events this device authored for this round.

The visible effect is free and correct: `StatusChrome` already renders the list, so "1 score
couldn't be saved — Bo, hole 15" now survives a reload instead of vanishing.

### 2b. The outbox drains itself

A backoff loop in `@swng/client`. The session is **dirty** when `pending.length > 0`, or when a
connection was requested and the socket is closed.

- While dirty, schedule a retry: base 2s, doubling, capped at 30s.
- A retry reopens the socket if it should be open, then runs the existing `requestSync()` —
  the same serialization gate every other trigger already funnels through.
- Any pass that completes its pull without a `TransportError` resets the backoff to base.
- When clean (nothing pending, socket open) **no timer is scheduled** — zero background cost on
  the happy path.

`recordScore`'s `if (connectedFlag)` guard is **deleted**. It always requests a sync; offline
just means the pass fails transiently and the loop picks it up. This is what removes the
silent-socket-death dead end by construction — there is no state in which the queue has stopped
trying, so no state in which a recovery button is the only way forward.

**Where the DOM lives.** `@swng/client` has no vitest config, so its tests run under node and it
must not reach for `window` (the `globalThis.indexedDB` precedent). The split:

- the **SDK owns the cadence** — backoff, dirty-state, scheduling. Correctness lives here, so
  that a caller wiring nothing still drains.
- the **app owns the wake signals** — `useRoundSession` adds `online`, `visibilitychange →
  visible`, and window `focus` listeners that call `session.sync()`. These are pure accelerators:
  they turn "phone comes out of the pocket at the next tee" into an immediate sync instead of a
  backoff tick. If they were never wired, the loop still drains.

That split is deliberately not a repeat of M4's "the UI owns retry cadence" — the cadence is in
the SDK this time; only the latency optimization is in the app.

Honest boundary: while a tab is fully suspended nothing can run, and Background Sync is not in
Safari. `visibilitychange` is the answer to that case, not a service worker.

**Chrome.** The banner currently reports the socket ("Offline"), which is the wrong subject and
will be wrong on a good connection (§1b). It should report the queue: `N scores saved on this
phone — syncing…`, escalating to `Can't reach swng — your scores are safe here` once the backoff
has reached its 30s cap (four consecutive failed passes — a threshold the loop already tracks, so
the copy is driven by a real state rather than a second timer invented for the chrome). Keep a
manual retry inside that escalated state as a backstop; it must never
be the mechanism, and it must not be reachable only from a state a silent socket death cannot
enter.

### 2c. Refusals are counted, and a re-push is never counted as a loss

`recordScore` throws `round-not-live` (409) when `state.status !== "live"`, covering both `final`
and `abandoned`.

(Section order is not landing order: the duplicate guard below lands **before** §2b, per §1's
ordering rule. Only the metric is free to land last.)

**The guard, discovered while specifying this — an addition to the three items, cut it if you
want the spec smaller.** Not every refused push is a lost score. If Bo's device pushed hole 15
successfully but never pulled the confirmation, hole 15 is still in Bo's `pending`; a later
re-push against the now-final round is refused, and today that reports and (pre-2a) deletes a
score **that is safely on the server**. `loadRoundState` already returns `events`, so the fix
costs no extra read:

> If `command.opId` is already present in the log, return `{ duplicate: true }` — **before** the
> status check. A re-push of an already-recorded score is idempotent regardless of round status.

Without this, 2a persists phantom "couldn't be saved" rows and 2c's metric counts false losses.

**The metric.** With that guard in place, a refusal against a `final` round is a real, unrecorded
score. Emit `deps.metrics?.count("LateScoreRefused")` on exactly that arm — `final` only, not
`abandoned` (a scrapped round counts nowhere, so refusing it loses nothing). `recordScore` gains
`metrics?: Metrics` in its deps, the `startRound`/`finalizeRound` pattern. Add the widget to the
`swng-ops-${stage}` dashboard and an alarm at ≥1 over 15 minutes: this should be near-zero, so
any occurrence is a "go look at that roundId" signal, not a transient to M-of-N away.

## 3. What this deliberately does not build

The multi-device hole stays open, knowingly: device A cannot see device B's outbox, so A's
drain-before-seal guard (`81902d7`) cannot cover B. **No grace period, no HLC acceptance window,
no mutable snapshots, no device acks.**

- A settling delay taxes every round's payoff moment — the group at the 18th green wants the
  numbers *now* — to protect a rare one, and it cannot cover the case that actually matters
  (a phone that is dark at finalize and stays dark). A timer cannot know what it is waiting for.
- Making snapshots replaceable would undo the write-once atom `finalizeRound.ts` is built around,
  and would need a re-settle path, a re-projection trigger, a policy for a shared archive whose
  numbers moved, and a window length nobody can calibrate — all before this has happened once,
  on a product that has just reached prod.

With 2a landed, a wrongly-settled round is rare, visible, and hand-fixable on the `scripts/`
discipline already exercised on prod. `LateScoreRefused` is what earns the right to build more:
zero for a season means the restraint was right; non-zero with roundIds means design the real
thing against real numbers.

Worth recording so it is not rediscovered as a surprise: the dangerous variant is **stale, not
missing**. Bo clears a mis-tapped hole 9 and re-enters it offline; Ann's fold holds the old value;
every game resolves cleanly on the wrong number. No finalize-time readiness check can catch that,
which is itself the argument for preserving data over checking harder at the gate.

## 4. Testing

- **2a**: a rejected op survives a store round-trip; a `PersistedSync` written without `rejected`
  loads as `[]` (the no-migration pin).
- **2b**: under fake timers — a transient failure schedules a retry and the queue drains with no
  caller intervention; backoff doubles to the cap and resets on success; a clean session schedules
  no timer; `close()` cancels the pending timer. In `apps/web` (happy-dom): an `online` event
  triggers a sync, and the listeners are removed on unmount.
- **2c**: a re-push of an already-recorded opId against a final round returns `duplicate: true`
  and emits no metric; a genuinely new score against a final round is refused and counts once;
  an abandoned round refuses without counting.
- **e2e**: `killNetwork.spec.ts` asserts the manual recovery today ("nothing pushes it until Sync
  now"). Its arm 3 becomes: the queue drains **without** the tap. That spec's own comments name
  the absent timer as the reason for the tap, so they change with it.
