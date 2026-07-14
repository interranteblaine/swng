# Pre-prod Hardening (D4a + D4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two decided engineering items from `docs/superpowers/specs/2026-07-14-pre-prod-hardening-design.md` — the handicap index computed on read (D4a, deleting the stored `INDEX` snapshot and its cross-shard race) and projector stream-consumer hygiene (D4b, bisect + bounded retries + DLQ + alarm) — gated on beta as deploy #8.

**Architecture:** D4a deletes the projector's per-golfer `listLines → computeIndexDetail → putIndex` read-modify-write and moves the identical domain fold into `getMyRecord`, the index's only reader, which already holds every history line (zero added reads; wire shape unchanged). D4b is pure CDK config on the existing event source plus one SQS queue and one alarm. Crews redesign (D3) and the prod stack (D1/D5) are explicitly OUT of this plan.

**Tech Stack:** existing monorepo (TypeScript ESM, Vitest, DynamoDB + DynamoDB Local contract tests, CDK).

## Global Constraints

- The spec is `docs/superpowers/specs/2026-07-14-pre-prod-hardening-design.md`; D4a/D4b govern.
- **Wire compatibility:** `GetMyRecordResponse` (contracts/golfers.ts:97,:102) is byte-shape UNCHANGED — `index?: { value, computedAtMs, differentialsUsed }` stays; `computedAtMs` becomes the read-time clock. No contract, route, or event changes anywhere (routes stay 34 HTTP/36 total).
- **Old data tolerates:** existing `INDEX` rows in the projections table become dead data that NOTHING reads; they must be harmless in place (listLines queries `ROUND#`-prefixed sks and never surfaces them). The controller deletes them in H-T3 via a one-time script — never a migration inside request paths.
- The projector stays THE one implementation both the stream trigger and `rebuildProjections` call; no forked math. Scoring/handicap math stays in `@swng/domain` (`combineNineHoleDifferentials`, `computeIndexDetail`) — application code only glues.
- Every task: `pnpm validate` green before commit; H-T1 also `pnpm test:contract` (adapters-dynamodb changes). Deploys controller-run only (`pnpm deploy:beta`, swng-beta, never `InfraCdkStack-*`). No pushes to any remote.
- e2e watch-outs (do NOT weaken): `apps/web/e2e/identityRecord.spec.ts` pins index `7.2` and `computedAtMs > 0` over the live wire — both survive D4a by construction (same fold over the same lines; read-time clock is positive). Rebuild parity survives (rebuild no longer writes INDEX; the wire value is computed on read either way).
- Closing proof-checks (H-T3 runs them):
  - `grep -rn "putIndex\|getIndex" packages/ apps/ --include="*.ts" | grep -v test` → zero.
  - `grep -rn "INDEX" packages/adapters-dynamodb/src/keys.ts` → zero.
  - Live beta: `GET /me/record` for the identityRecord account still serves `index.value` 7.2 (the e2e run IS this check).

---

### Task H-T1: The handicap index is computed on read (D4a)

**Files:**
- Modify: `packages/application/src/golfers/getMyRecord.ts` (the whole read path — full replacement body below)
- Modify: `packages/application/src/projections/projectArchive.ts` (delete the index fold, lines ~87–102; delete the ACCEPTED RACE comment block, lines ~52–61; drop the now-unused `clock` dep and `combineNineHoleDifferentials`/`computeIndexDetail` imports)
- Modify: `packages/application/src/ports/projectionStore.ts` (delete `putIndex` + `getIndex`, lines ~29–30, and any INDEX doc prose)
- Modify: `packages/adapters-dynamodb/src/createDynamoProjectionStore.ts` (delete the putIndex/getIndex implementations), `packages/adapters-dynamodb/src/keys.ts` (delete `projectionIndexSk`, line ~113)
- Modify: `packages/lambda/src/compositionRoot.ts` (delete the `getIndex: unavailable` stub at ~:185 and its `putIndex` sibling if present; drop `clock` from projector/rebuild wiring if it was only for putIndex; ADD `clock` to getMyRecord's wiring)
- Modify (ripple, compiler-driven): `packages/application/src/projections/rebuildProjections.ts` (deps pass-through), every in-memory fake ProjectionStore in tests (`projectionSlice.test.ts`, `rebuildProjections.test.ts`, and the file that tests `getMyRecord` — find it via `grep -rln "getMyRecord" packages/application/src`)
- Test: same test files — pins below.

**Interfaces:**
- Consumes: `sortLines` (already exported from projectArchive.ts and already imported by getMyRecord), `combineNineHoleDifferentials` + `computeIndexDetail` from `@swng/domain`, `Clock` port.
- Produces: `ProjectionStore` port WITHOUT putIndex/getIndex (H-T3's proof-grep relies on total deletion); `getMyRecord` deps gain `clock: Clock`. Wire response unchanged.

- [ ] **Step 1: Write the failing tests.** In the file that tests `getMyRecord` (find the existing tests and their store-seeding idiom; they exist — the current response's `index` field is asserted somewhere):

```ts
it("computes the index at read time from the history lines — no stored snapshot is consulted", async () => {
  // Seed ≥3 complete-differential lines through the REAL store the suite already uses
  // (putLine), with a fake clock frozen at a known ms. Do NOT seed any INDEX item.
  const response = await ctx.getMyRecord(asClaims("ann"));
  // Oracle: the same domain fold the projector used to run.
  const expected = computeIndexDetail(combineNineHoleDifferentials(seededCompleteLines.map((l) => ({ differential: l.differential, holes: l.holes }))));
  expect(response.index).toEqual({ value: expected!.value, computedAtMs: FROZEN_NOW, differentialsUsed: expected!.differentialsUsed });
});

it("below the 3-differential bootstrap the index is ABSENT, not zero", async () => {
  // Seed exactly 2 complete lines.
  const response = await ctx.getMyRecord(asClaims("bo"));
  expect(response.index).toBeUndefined();
  expect(response.history).toHaveLength(2);
});
```

In `projectionSlice.test.ts` and `rebuildProjections.test.ts`: update the write-surface pins (the Set-equality assertions over which store methods a projection pass calls) to EXCLUDE putIndex — the projector's whole write surface is now `putLine` + `deleteLive`. Rewrite (don't delete) any test titled around the stored index to pin the new truth: `projectArchive` never writes an index, and a golfer's wire index after `projectArchive` + `getMyRecord` equals the domain fold oracle.

- [ ] **Step 2: Run to verify failure.** `pnpm -F @swng/application vitest run` on the touched files — the read-time test fails (getMyRecord still reads the stored snapshot; the seeded-lines-only case returns `index: undefined`).

- [ ] **Step 3: Implement.** `getMyRecord.ts` — full new body (keep `toWireLine` exactly as is):

```ts
export const getMyRecord =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore; clock: Clock }) =>
  async (claims: AccountClaims): Promise<GetMyRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) return { history: [] };

    const lines = await deps.projectionStore.listLines(found.golfer.id);
    // listLines is UNORDERED (ports/projectionStore.ts) — sortLines (projections/
    // projectArchive.ts) gives oldest → newest for the fold below AND for the wire history's
    // newest-first reversal, one ordering for both consumers of these lines.
    const sorted = sortLines(lines);

    // The index is computed HERE, at read time, from the lines this response already carries —
    // never stored (pre-prod hardening D4a): the projector's stored INDEX snapshot was the
    // system's last read-modify-write aggregate, and two same-golfer finalizes on different
    // stream shards could race it. Same fold the projector used to run; the math stays in
    // domain (conventions §4). differentialsUsed is Rule 5.2a's `use` count — how many
    // differentials were actually AVERAGED, not the window size.
    const complete = sorted.filter((entry) => entry.differential !== undefined);
    const combined = combineNineHoleDifferentials(complete.map((entry) => ({ differential: entry.differential!, holes: entry.holes })));
    const detail = computeIndexDetail(combined);

    return {
      ...(detail !== undefined ? { index: { value: detail.value, computedAtMs: deps.clock.now(), differentialsUsed: detail.differentialsUsed } } : {}),
      history: sorted.reverse().map(toWireLine),
    };
  };
```

Imports gain `combineNineHoleDifferentials, computeIndexDetail` from `@swng/domain` and `Clock` from `../ports/clock.js`.

`projectArchive.ts` — the participant loop becomes only the line upsert (presence pass unchanged):

```ts
    for (const participant of archive.participants) {
      // Sub-less (a ghost) or no golfer row at all: not an account, so nothing about this round
      // enters their record — no history line. Presence IS still cleared for them (below,
      // unconditionally over the ever-seated roster) — identity housekeeping, not projection
      // policy. The handicap index is NOT computed here at all: it is derived at read time in
      // golfers/getMyRecord.ts (pre-prod hardening D4a), so the projector is a pure per-round
      // idempotent upsert with no read-modify-write left to race.
      if (!accountBound.has(participant.golferId)) continue;

      const line = archiveGolferLine(archive, participant.golferId);
      await deps.projectionStore.putLine(participant.golferId, { ...line, finalizedAtMs, createdAtMs });
    }
```

Delete the ACCEPTED RACE header block and the Rule-5.2a paragraph (the 5.2a note moves into getMyRecord's comment above); drop `clock` from deps if putIndex was its only use (it was — verify by grep within the file), drop the dead imports, and let the compiler drive the wiring ripple (compositionRoot, rebuildProjections, test fakes). Port + adapter deletions per the file list; the DynamoDB contract tests for putIndex/getIndex are deleted with their subject, and ADD one contract pin: a manually-seeded legacy `INDEX` row in the table is invisible to `listLines` (the `ROUND#` begins_with query never returns it).

- [ ] **Step 4: Run** `pnpm -F @swng/application test`, then `pnpm test:contract`, then root `pnpm validate` (run `pnpm build` first if typecheck resolves stale dist/). Expected: green; no remaining reference to putIndex/getIndex anywhere (`grep -rn "putIndex\|getIndex" packages/ apps/ --include="*.ts"` → only this plan's own test-title prose if any — aim for zero).

- [ ] **Step 5: Commit**

```bash
git add packages/
git commit -m "fix(application,adapters): the handicap index is computed on read — the stored INDEX snapshot and its cross-shard race are deleted"
```

---

### Task H-T2: Projector stream-consumer hygiene (D4b)

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts` (the event source at ~:422-427; the alarms section at ~:552+)
- Test: `apps/infra-cdk/test/swngStack.test.ts` (or the stack's existing test file — find the alarm-count and event-source pins and work beside them)

**Interfaces:**
- Consumes: the existing `paged(...)` alarm helper (~:564), `FIVE_MINUTES`, the existing `DynamoEventSource` on `snapshotsTable`.
- Produces: one SQS queue (`ProjectorDlq`), one new paged alarm (count 12 → 13). No route/table changes.

- [ ] **Step 1: Write the failing stack tests** beside the existing pins (match their assertion idiom — CDK assertions `Template`):

```ts
it("the projector event source bisects on error, bounds retries, and dead-letters to SQS", () => {
  template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    BisectBatchOnFunctionError: true,
    MaximumRetryAttempts: 10,
    DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": [Match.stringLikeRegexp("ProjectorDlq"), "Arn"] } } },
  });
});

it("a non-empty projector DLQ pages", () => {
  // alongside bumping the existing total-alarm-count pin 12 -> 13
  template.hasResourceProperties("AWS::CloudWatch::Alarm", Match.objectLike({
    AlarmDescription: Match.stringLikeRegexp("DLQ"),
    Threshold: 0,
  }));
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm -F @swng/infra-cdk test` — both fail (no DLQ, mapping has neither property).

- [ ] **Step 3: Implement** in `swngStack.ts`:

```ts
// D4b (pre-prod hardening spec): a deterministically-throwing stream record must not block
// its shard for 24h and then vanish with its batchmates. Bisect isolates the poison record,
// bounded retries hand it to the DLQ, and the DLQ alarm pages. NOTE the DLQ message is stream
// METADATA (shard + sequence range), not the record payload — recovery is: fix the bug, then
// re-drive the affected range with rebuildProjections (already paged/cursor-resumable). The
// queue is a signal + bookmark, never a replay source.
const projectorDlq = new Queue(this, "ProjectorDlq", {
  queueName: `swng-projector-dlq-${stage}`,
  retentionPeriod: Duration.days(14),
});

projectorFn.addEventSource(
  new DynamoEventSource(snapshotsTable, {
    startingPosition: StartingPosition.TRIM_HORIZON,
    batchSize: 10,
    bisectBatchOnError: true,
    retryAttempts: 10,
    onFailure: new SqsDlq(projectorDlq),
  }),
);
```

(imports: `SqsDlq` from `aws-cdk-lib/aws-lambda-event-sources`, `Queue` from `aws-cdk-lib/aws-sqs`, `Duration` from `aws-cdk-lib` — check what's already imported). In the alarms section, beside the ProjectorIteratorAge alarm:

```ts
paged(
  new Alarm(this, "ProjectorDlqDepthAlarm", {
    alarmDescription:
      "ProjectorFunction: a poisoned snapshots-stream record landed in the DLQ — that record's projections are NOT applied until rebuildProjections re-drives them after the fix",
    metric: projectorDlq.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: "Maximum" }),
    threshold: 0,
    comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: TreatMissingData.NOT_BREACHING,
  }),
);
```

- [ ] **Step 4: Run** `pnpm -F @swng/infra-cdk test`, then root `pnpm validate`. Expected: green, alarm-count pin at 13.

- [ ] **Step 5: Commit**

```bash
git add apps/infra-cdk/
git commit -m "feat(infra): projector stream-consumer hygiene — bisect, bounded retries, DLQ + depth alarm"
```

---

### Task H-T3 (CONTROLLER): deploy #8, gates, INDEX cleanup, docs, close

- [ ] Step 1: `cdk diff` — expected: +1 SQS queue, +1 alarm, the ProjectorFunction event-source mapping updated in place, function bundle updates; ZERO destroys of stateful resources. Then `pnpm deploy:beta`, then `pnpm publish:web:beta` (bundle hash may shift via rebuilt workspace deps even with no web source change).
- [ ] Step 2: gates — `pnpm e2e:beta` ×2 (16/16), full `pnpm e2e:field` ×1 (51 + the documented skip). identityRecord's live 7.2/computedAtMs/rebuild-parity pins ARE the D4a live proof.
- [ ] Step 3: INDEX row cleanup — write `scripts/dropIndexProjectionItems.mjs` modeled directly on the existing `dropOldProjectionItems.mjs` (same paging/dry-run/ndjson-report shape): every projections-table item with `sk = "INDEX"`. Dry-run (count must be plausible: ≈ one per account golfer with ≥3 differentials); real run; rerun → 0 (idempotent). Spot-check one account partition before/after: `ROUND#` lines byte-identical, only INDEX gone.
- [ ] Step 4: docs — `docs/implementation-plan.md` M10 ledger: mark the projector-staleness entry **LANDED (D4a)**, the putHistoryLine-atomicity entry **CORRECTED** (heals via stream retry — at-least-once + idempotent upserts — not via manual rebuild), and add D4b as LANDED; CLAUDE.md's current-state section gains the pre-prod hardening sentence. Commit `docs(hardening): pre-prod D4a/D4b landed — ledger corrected`.
- [ ] Step 5: run the Global Constraints proof-checks; ledger the arc in `.superpowers/sdd/progress.md`.
