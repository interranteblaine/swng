# Pre-prod hardening — decisions record & design

> Status: **approved in session** (owner + controller walk of the M10 hardening ledger,
> 2026-07-14). This document dispositions every open item standing between the current beta
> and a prod deployment. Items marked DECIDED are settled here; the one item marked OPEN
> blocks prod and gets its own design session.

## Context

M0–M9 plus the post-M9 arcs (snapshot realignment, crew-is-a-grouping, accounts-only
identity, papercut batch) are closed. `docs/implementation-plan.md`'s M10 section carries
the hardening ledger inherited from M7/M9. Several of its entries were resolved or made
moot by later work (claims machinery deleted by accounts-only identity; the rebuild rewritten
paged/cursor-resumable by the snapshot realignment; crew projections deleted outright). This
session walked what actually remains against the current code.

## D1 — Token storage: keep localStorage + CSP (DECIDED, accepted with tripwire)

Cognito ID + refresh tokens stay in `localStorage` (`apps/web/src/auth/tokenStore.ts`).

**Reasoning.** The threat is a malicious script executing in our origin (XSS). Moving
tokens to httpOnly cookies does not stop that attacker acting as the user — injected script
can call the API from the page and the cookie rides along; cookies only prevent the
credential being exfiltrated for later offline use, a second-order gain. The first-order
control is preventing script injection, and it is already deployed: the CloudFront CSP
allows only our own bundled scripts (`script-src 'self'`, no inline, zero third-party
script sources anywhere in the app) and React escapes all rendered text. Rebuilding the
sign-in flow — the highest-risk code we own — for a second-order gain is the wrong trade.

**Tripwire (expires this decision):** the day any third-party script origin is added
(analytics, maps, ads, error reporting), this decision is void and must be re-made.

**Prod pool config that rides along (config-level, part of the prod-stack task):** no
`USER_PASSWORD_AUTH` on the prod client (the flag exists on beta solely so e2e can mint
JWTs — `swngStack.ts:280-286`), token revocation enabled, default Cognito token lifetimes
(ID/access 1h, refresh 30 days) recorded as deliberate.

## D2 — Share links: permanence is the feature (DECIDED, accepted with tripwire)

Spectator watch URLs stay valid forever; no revocation is built.

**Reasoning.** A watch link exposes a read-only scorecard to a person a participant
deliberately sent it to. Tokens are HMAC-signed — not guessable or enumerable. The M9
product promise is "one URL forever" (the link you text in July still works at
Thanksgiving); revocation infrastructure would be complexity defending golf scores from
people we chose to show them to.

**Tripwire:** if rounds ever carry genuinely private data (money settled, personal notes),
revisit before that feature ships.

## D3 — Crew membership model: OPEN — blocks prod

Owner ruling (2026-07-14): the current model does not fold into prod. The flaw is not the
join code itself but the combination **permanent code + no removal**: the only membership
exit in the system is `leaveCrew` (self-removal); there are no roles, no owner, no kick. A
leaked code admits a stranger to a crew's standings forever with no remedy. Join-by-code is
a fossil of the ghost era — post-wall every member is an account, so invites/approval/roles
are all expressible.

**Disposition:** its own design session (brainstorm → spec → plan), owner-driven — invite
vs. code, whether crews have an owner/manager, who removes whom. Explicitly NOT scoped or
pre-designed here. Prod deployment is sequenced after it lands.

## D4 — Projection pipeline (DECIDED: two engineering items, one record)

The pipeline as verified: finalize commits the `round-finalized` event and the round
snapshot in ONE cross-table transaction; the snapshots table's stream feeds
`ProjectorFunction` (at-least-once, per-shard ordered, batch 10); every projector write is
an idempotent upsert on stable keys, so stream retries and rebuild replays land harmlessly.

### D4a — The handicap index is computed on read, not stored (kills the race class)

`projectArchive`'s per-golfer `listLines → computeIndexDetail → putIndex` is the system's
last stored read-modify-write aggregate; two rounds sharing a participant finalizing
near-simultaneously on different shards can store an index short one differential
(self-healing, but a standing race). A transaction cannot fix this — atomicity is not
serialization.

**Decision:** delete the stored `INDEX` snapshot; compute the index at read time from the
history lines, exactly as crew standings already are ("keys are identities, aggregates on
read"). Verified enabling facts: `getMyRecord` is the ONLY reader of
`projectionStore.getIndex` in the system, and it already fetches every history line in the
same request — compute-on-read costs zero additional reads. `golferView` deliberately never
joins the index (its own doc comment), and the web renders nothing from `computedAtMs`.
The wire shape (`GetMyRecordResponse.index`, contracts/golfers.ts:97) is UNCHANGED;
`computedAtMs` becomes the read-time clock, which is when the value is now computed.
The projector becomes a pure per-round upsert fold (line + presence) with no read-modify-
write anywhere.

### D4b — Stream-consumer hygiene (poison-record handling)

Today the event source sets only `startingPosition` + `batchSize` (`swngStack.ts:423-426`):
a deterministically-throwing record would block its shard for 24h of retries and then
vanish with its batchmates. Detection exists (Errors + IteratorAge alarms); the remedy is
manual.

**Decision:** standard consumer hygiene, all config-level — `bisectBatchOnError` (isolate
the poison record from its batchmates), bounded `retryAttempts` (10), an `onFailure` SQS
dead-letter queue, and a paged alarm on DLQ depth > 0 (alarm count 12 → 13). A DLQ'd record
is recovered by `rebuildProjections` (already paged/cursor-resumable) after the bug that
poisoned it is fixed.

### D4c — putLine/index crash window: record only, no work

A crash between the projector's writes fails the Lambda invocation, the stream redelivers
the batch, and the idempotent upserts rerun — the window heals in seconds via the
at-least-once contract, not via manual rebuild. The implementation-plan ledger entry that
described this as rebuild-repaired is corrected as part of this arc's docs task.

## D5 — Stage configuration as typed props (DECIDED, rides the prod-stack task)

Today `stage` drives resource names only — zero behavioral branches exist. The first
behavioral difference (prod's `userPassword: false`) does NOT land as inline
`stage === "prod"` branching: the CDK entry point resolves a typed per-stage config table
(`{ allowPasswordAuth, webOrigins, alarmEmail, throttles, … }`) and `SwngStack` consumes
the config object, never inspecting the stage name. Scales to dev/staging/prod and regions
by growing the table, not the stack. The `WEB_ORIGINS` CDK-context side channel
(`swngStack.ts:273`) folds into the same table. Implemented with the prod-stack plan, not
this one (there is no second stage to configure yet).

## Sequencing

1. **This arc:** D4a + D4b, landed and gated on beta (deploy #8).
2. **Crew membership design session** (D3, owner-driven) → its own spec/plan/execution.
3. **Prod stack plan** (D5 pattern, D1 pool config, anonymous smoke) → deploy prod.
4. **Field test** (`docs/field-test.md`) on prod.

## Owner items

- Click the SNS confirmation email (sent 2026-07-13) or no alarm pages anyone.
- D3 design session — say when.
