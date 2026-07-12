# Snapshot Realignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the round a sealed leaf: snapshots in their own table (transactional finalize, filter-free projector, backfill-style rebuild), crews fully outside the finalize chain (seasons + counted rounds + standings-on-read), golfer records on stable keys, presence/capability derived from identity, and `round-abandoned` — per `docs/superpowers/specs/2026-07-12-projection-realignment-design.md`.

**Architecture:** Four stores — `rounds` (event logs), `snapshots` (the atom, one immutable item per finished round, streamed to a golfer-only projector), `core` (entities incl. crew seasons + counted roundIds), `projections` (golfer records + presence; disposable). Every derived value is a pure function of truth, stored (if at all) by whole replacement. Reference direction is always outside → round by `roundId`.

**Tech Stack:** existing monorepo — TypeScript ESM, Vitest, Zod contracts, DynamoDB (lib-dynamodb), CDK, React 19.

## Global Constraints

- The spec is the authority: `docs/superpowers/specs/2026-07-12-projection-realignment-design.md`. Its §9 deletion list must be COMPLETE by the end of Phase 3 — grep proves it.
- **No new GSIs, no shards, no pointer items** (spec §9). If a task seems to need one, stop and surface it.
- **Keys are identities; time is an attribute** — no sort key may embed a timestamp.
- Event schema stays append-only: new event kinds and optional fields only; wire schemas TOLERATE-AND-STRIP `crewId` on old stored events (Zod default strip — verify, don't assume).
- Every task: `pnpm validate` green before commit. Tasks touching `adapters-dynamodb`: `pnpm test:contract` too (DynamoDB Local; add snapshots-table setup to `src/testing/local.ts` when Phase 1 lands).
- **Deploys are controller-run only** (`pnpm deploy:beta`, stack `swng-beta`, profile `swng`, us-east-1). Implementers never deploy. NEVER touch `InfraCdkStack-*` names; never `cdk destroy`.
- Layer direction `domain → application → adapters → lambda` is lint-enforced; web imports client/contracts/domain only.
- Comment style per repo: comments state constraints the code can't show; match density of touched files.
- Commit style: `feat|fix|docs|test(scope): message`, imperative, with the repo's flavor.

## Phase map

| Phase | Tasks | Deploy |
| --- | --- | --- |
| 1 — The atom | 1 (CDK), 2 (transactional finalize + snapshot store + projector cutover), 3 (controller: migrate + deploy #1) | #1 |
| 2 — The record | 4 (stable-key projection store + projectArchive), 5 (rebuild-as-backfill), 6 (snapshot view + my rounds + web), 7 (controller: deploy #2 + rebuild + drop old keyspaces) | #2 |
| 3 — The crew correction | 8 (crew store: seasons + counted rounds), 9 (crew use cases + routes + deletions), 10 (drop crewId everywhere), 11 (crew web), 12 (controller: deploy #3 + crewSeason e2e rewrite) | #3 |
| 4 — Presence & capability | 13 (presence + home), 14 (token re-mint), 15 (round-abandoned), 16 (controller: deploy #4 + gates + docs) | #4 |

Phase 1 must land first. Phases 3 and 4 are independent of each other after Phase 2.

---

### Task 1: CDK — the snapshots table, projector cutover, projections TTL

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts`
- Test: `apps/infra-cdk/test/swngStack.test.ts` (existing assertion tests — extend)

**Interfaces:**
- Produces: table `swng-snapshots-${stage}` (pk-only, stream NEW_IMAGE); env `TABLE_SNAPSHOTS` on `httpFn`, `rebuildFn`, and `projectorFn`; projections table TTL on attribute `ttl`.

- [ ] **Step 1: failing stack-assertion tests** — extend the existing template tests:

```ts
test("snapshots table: pk-only, stream, RETAIN, PITR", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "swng-snapshots-beta",
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
    StreamSpecification: { StreamViewType: "NEW_IMAGE" },
  });
});
test("projector's event source is the snapshots table's stream, with NO filter", () => {
  // assert exactly one EventSourceMapping for ProjectorFunction, its EventSourceArn resolving
  // to the snapshots table stream, and NO FilterCriteria property present
});
test("projections table has TTL enabled on 'ttl'", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "swng-projections-beta",
    TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
  });
});
```

- [ ] **Step 2: implement.** Mirror the rounds table's construct props (RETAIN, PITR, PAY_PER_REQUEST):

```ts
const snapshotsTable = new Table(this, "SnapshotsTable", {
  tableName: `swng-snapshots-${stage}`,
  partitionKey: { name: "pk", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.RETAIN,
  pointInTimeRecovery: true,
  stream: StreamViewType.NEW_IMAGE,
});
```

Then: (a) move `projectorFn.addEventSource` from `roundsTable` to `snapshotsTable`, DELETE the `FilterCriteria`/`ARCHIVE_SK` filter (and the `ARCHIVE_SK` constant if now unused); (b) `httpFn`: `TABLE_SNAPSHOTS` env + `snapshotsTable.grantReadWriteData(httpFn)` (the journal's finalize transaction writes here); (c) `rebuildFn`: `TABLE_SNAPSHOTS` env + read grant, REMOVE `TABLE_ROUNDS` env + its grant (the rebuild never touches the rounds table again); (d) `projectionsTable` gains `timeToLiveAttribute: "ttl"`; (e) projectorFn keeps `TABLE_PROJECTIONS`. The IteratorAge alarm follows the function, not the source — leave it.

- [ ] **Step 3:** `pnpm validate` green. Do NOT deploy (controller does, Task 3).
- [ ] **Step 4:** commit `feat(infra): the snapshots table — the atom gets its own table and stream`

---

### Task 2: Transactional finalize + SnapshotStore + projector on the snapshots stream

**Files:**
- Create: `packages/application/src/ports/snapshotStore.ts`
- Create: `packages/adapters-dynamodb/src/createDynamoSnapshotStore.ts` (+ contract test)
- Create: `packages/adapters-dynamodb/src/parseSnapshotStreamImage.ts` (replaces `parseArchiveStreamImage.ts` — delete it)
- Modify: `packages/application/src/ports/eventJournal.ts` (AppendOptions), `packages/application/src/ports/roundStore.ts` (drop putArchive/getArchive), `packages/application/src/rounds/finalizeRound.ts`, `packages/adapters-dynamodb/src/createDynamoEventJournal.ts`, `packages/adapters-dynamodb/src/createDynamoRoundStore.ts`, `packages/adapters-dynamodb/src/keys.ts` (snapshot key helpers; delete `archiveSk` when unused), `packages/lambda/src/compositionRoot.ts`, `packages/adapters-dynamodb/src/testing/local.ts` (create snapshots table)
- Delete: `packages/adapters-dynamodb/src/createDynamoArchiveSource.ts` (+ its test)
- Test: co-located `*.test.ts` throughout; the application-layer memory fakes (find them via `grep -rn "putArchive" packages/application/src`) gain the new shapes.

**Interfaces:**
- Produces (later tasks consume these EXACT shapes):

```ts
// application/src/ports/snapshotStore.ts — reads over the snapshots table. Writes happen
// ONLY through EventJournal.append's atomic finalize commit; no put() here by design.
export interface SnapshotStore {
  get(roundId: RoundId): Promise<RoundArchive | undefined>;
  getMany(roundIds: readonly RoundId[]): Promise<readonly RoundArchive[]>; // order not guaranteed; absent ids omitted
  page(cursor?: string): Promise<{ snapshots: readonly RoundArchive[]; cursor?: string }>;
}

// ports/eventJournal.ts — AppendOptions grows:
export interface AppendOptions {
  readonly expectedHeadSeq?: number;
  // When set, the append and this snapshot's put commit in ONE transaction (cross-table
  // TransactWriteItems). Only finalizeRound sets it. Spec §2.
  readonly snapshot?: RoundArchive;
}
```

- Snapshot item shape (pin for Task 3's migration script and Task 5's rebuild): `{ pk: <roundId as plain string>, finalizedAt: <ms number>, archive: <RoundArchive> }`. `page`'s cursor = base64url of `JSON.stringify(LastEvaluatedKey)`.

- [ ] **Step 1: failing tests first**, the load-bearing ones:

```ts
// finalizeRound.test.ts (rewrite of existing cases + new):
test("finalize commits round-finalized and the snapshot atomically — one append call carries both", ...);
test("idempotent branch: already-final round returns the stored snapshot without appending", ...);
test("a final round with NO stored snapshot throws loudly (corrupt) — the repair branch is gone", ...);
test("headSeqConflict → re-read → snapshot computed from the NEW candidate log", ...);

// createDynamoEventJournal contract test additions:
test("append with { snapshot } writes EVT + OPID + snapshot item in one transaction", ...);
test("append with { snapshot } whose EVT slot loses the seq race writes NO snapshot item", ...);

// createDynamoSnapshotStore contract tests: get/getMany/page round-trip; page cursor walks
// every item exactly once across ≥3 pages (seed >2 items, page size 2 via Limit injection).
```

- [ ] **Step 2: implement.**
  - `createDynamoEventJournal`: config gains `snapshotsTableName?: string`. In `attemptCommit`, when `options.snapshot` is present append one more TransactItem: `{ Put: { TableName: snapshotsTableName, Item: { pk: snapshot.roundId, finalizedAt: finalizedAtMsOf-equivalent, archive: snapshot } } }` (unconditional — re-finalize replaces; the EVT condition is the transaction's guard). Throw at call time if `snapshot` is set but `snapshotsTableName` wasn't configured. CancellationReasons parsing: the snapshot Put is LAST in the array; it has no condition so it can't be the cancellation cause — the existing per-event reason indexing is unchanged.
  - `finalizeRound`: the snapshot is settled from the CANDIDATE log and committed with the append —

```ts
const candidateLog = [...events, candidate];
const archive = settleRound(candidateLog); // validates settle-ability AND is the committed snapshot
const result = await deps.journal.append(claims.roundId, [candidate], { expectedHeadSeq, snapshot: archive });
if (result.headSeqConflict) continue;
await deps.broadcast.publish(claims.roundId, result.appended);
return { results: archive.results, handicapping: archive.handicapping };
```

  The post-append `fullLog` re-read is DELETED (the head-seq condition guarantees the log at commit is exactly the candidate log — the archive is exact, not racy). The idempotent branch becomes: `const archived = await deps.snapshots.get(claims.roundId); if (!archived) throw new Error("finalized round has no snapshot — corrupt");` `finalizeRound` deps swap `store: RoundStore` for `snapshots: SnapshotStore` (it no longer needs RoundStore at all — check and drop).
  - `createDynamoRoundStore`: delete `putArchive`/`getArchive`; port loses them.
  - `parseSnapshotStreamImage(image)`: unmarshall; assert `archive` attribute present, throw otherwise (poison-record discipline carries over); no sk assertion (the table has no sk).
  - `compositionRoot`: `buildHttp` wires `snapshotsTableName` into the journal and builds the SnapshotStore; `buildProjector` uses `parseSnapshotStreamImage`; `buildRebuild` swaps `createDynamoArchiveSource` for the SnapshotStore (rebuild itself is rewritten in Task 5 — for THIS task keep `rebuildProjections` compiling by feeding it an ArchiveSource shim over `page()`; the shim dies in Task 5).
  - `testing/local.ts`: create the snapshots table (pk-only) beside the others.
- [ ] **Step 3:** `pnpm validate` AND `pnpm test:contract` green.
- [ ] **Step 4:** commit `feat(application,adapters-dynamodb,lambda): finalize commits event+snapshot atomically; snapshots table is the atom`

---

### Task 3 (CONTROLLER): migrate beta archives, deploy #1, gate

- [ ] **Step 1:** Write `scripts/migrateSnapshots.mjs`: Scan `swng-rounds-beta` with `FilterExpression: "sk = :a"` (the LAST such scan — it's a migration, not architecture), and for each item `PutItem` into `swng-snapshots-beta` as `{ pk: archive.roundId, finalizedAt, archive }`. Idempotent (unconditional puts) so it can re-run to catch stragglers.
- [ ] **Step 2:** `pnpm deploy:beta` → then run the script (`node scripts/migrateSnapshots.mjs --profile swng`) → re-run it once more (catches any finalize that landed old-style mid-deploy).
- [ ] **Step 3:** Gate: `pnpm e2e:beta` (full output to a log file, echo exit code — never through tail). A finalize in the suite must produce a snapshots-table item and a projector invocation off the NEW stream (check CloudWatch: ProjectorFunction invocations > 0 in the run window; zero errors).
- [ ] **Step 4:** commit the script: `feat(scripts): one-time beta archive → snapshots migration`

---

### Task 4: Golfer record on stable keys

**Files:**
- Modify: `packages/application/src/ports/projectionStore.ts` (REWRITE — golfer-record + presence surface only), `packages/adapters-dynamodb/src/createDynamoProjectionStore.ts` (REWRITE), `packages/adapters-dynamodb/src/keys.ts`, `packages/application/src/projections/projectArchive.ts`, `packages/application/src/golfers/getMyRecord.ts`
- Test: contract tests for the new store; `projectArchive.test.ts` updates.

**Interfaces:**
- Produces:

```ts
// ports/projectionStore.ts — the whole port, replacing today's:
export interface ProjectionStore {
  putLine(golferId: GolferId, line: GolferRoundLine & { readonly finalizedAtMs: number }): Promise<void>;
  listLines(golferId: GolferId): Promise<readonly (GolferRoundLine & { readonly finalizedAtMs: number })[]>; // UNORDERED — callers sort by finalizedAtMs
  putIndex(golferId: GolferId, snapshot: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number }): Promise<void>;
  getIndex(golferId: GolferId): Promise<{ value: number; computedAtMs: number; differentialsUsed: number } | undefined>;
  // Presence (consumed by Tasks 13/15; implemented here so the store rewrites once):
  putLive(golferId: GolferId, entry: { readonly roundId: RoundId; readonly courseName: string; readonly joinedAtMs: number; readonly expiresAtSec: number }): Promise<void>;
  deleteLive(golferId: GolferId, roundId: RoundId): Promise<void>;
  listLive(golferId: GolferId): Promise<readonly { roundId: RoundId; courseName: string; joinedAtMs: number }[]>;
}
```

- Keys (in `keys.ts`; DELETE `historySk`/`historySkPrefix`/`crewRoundsPk`/`crewRoundSk`/`crewRoundSkPrefix`/`recordsPk`/`recordsSk` — Task 9 deletes their last consumers; here mark deprecated if lint blocks): `lineSk(roundId) = "ROUND#" + roundId`, `projectionIndexSk = "INDEX"` (unchanged), `liveSk(roundId) = "LIVE#" + roundId`. The `ttl` attribute on LIVE items is `expiresAtSec` (epoch SECONDS — DynamoDB TTL's unit).

- [ ] **Step 1: failing tests.** Contract: `putLine` twice for the same roundId with DIFFERENT finalizedAtMs leaves exactly ONE item (the stable-key point — this test is the spec's "a correction replaces, never duplicates"); `listLines` returns both lines for two rounds; LIVE put/list/delete round-trip; `putLive` item carries `ttl = expiresAtSec`. Unit: `projectArchive` sorts lines by `(finalizedAtMs, roundId)` before the index fold (feed lines out of order via a fake store, assert `computeIndexDetail` input order).
- [ ] **Step 2: implement.** `putLine` = ONE unconditional `PutCommand` at `{ pk: golferPk(id), sk: lineSk(line.roundId) }` — the query-then-delete idiom is deleted, not ported. `projectArchive` drops the whole crew arm ONLY in Task 9 (keep it compiling against the old store methods until then — to avoid a broken intermediate state, keep the OLD crew methods on the adapter untouched in this task and mark the port's crew section `/** deleted in realignment Task 9 */`). `getMyRecord` sorts `listLines` by finalizedAtMs ascending before reversing (behavior identical to today).
- [ ] **Step 3:** `pnpm validate` + `pnpm test:contract`.
- [ ] **Step 4:** commit `feat(application,adapters-dynamodb): golfer record on stable keys — a key is an identity, time is an attribute`

---

### Task 5: Rebuild as backfill

**Files:**
- Rewrite: `packages/application/src/projections/rebuildProjections.ts`
- Modify: `packages/lambda/src/compositionRoot.ts` (buildRebuild: SnapshotStore in, ArchiveSource shim + interface deleted), `packages/lambda/src/entries/rebuild.ts` (doc comment — the operator note about the wipe race dies with the race)
- Test: `rebuildProjections.test.ts` (rewrite)

**Interfaces:**
- Consumes: `SnapshotStore.page` (Task 2), `projectArchive` (Task 4).
- Produces: `rebuildProjections(deps)(input?: { cursor?: string; maxSnapshots?: number }) => Promise<{ processed: number; cursor?: string }>` — Lambda event/response shape is exactly this.

- [ ] **Step 1: failing tests:** processes every snapshot across ≥3 pages; returns a cursor when `maxSnapshots` (default 500) is hit mid-run and resuming from it processes the remainder exactly once; NO wipe calls exist (the fake store records calls — assert only putLine/putIndex); replaying the same page twice yields identical store state (idempotence).
- [ ] **Step 2: implement** — the whole function is a loop:

```ts
let cursor = input?.cursor; let processed = 0;
do {
  const page = await deps.snapshots.page(cursor);
  for (const archive of page.snapshots) { await project(archive); processed += 1; }
  cursor = page.cursor;
} while (cursor !== undefined && processed < maxSnapshots);
return { processed, ...(cursor !== undefined ? { cursor } : {}) };
```

No buffering, no sort (order-independence is Task 4's tested property), no wipe. Delete `ArchiveSource`.
- [ ] **Step 3:** `pnpm validate`.
- [ ] **Step 4:** commit `feat(application,lambda): rebuild is a paged backfill over the snapshots table — wipe, sort, and buffer deleted`

---

### Task 6: Snapshot view + my rounds (wire + web)

**Files:**
- Modify: `packages/contracts/src/round.ts` + `golfers.ts` (new response types), `packages/lambda/src/http/routes.ts` + `dispatch.ts` wiring, `packages/lambda/src/compositionRoot.ts`
- Create: `packages/application/src/rounds/getRoundArchive.ts`, `packages/application/src/golfers/getMyRounds.ts`, `apps/web/src/round/ArchivedRoundPage.tsx`
- Modify: `apps/web/src/routes/ProfilePage.tsx` (history lines link to the page), `apps/web/src/App.tsx` (route)

**Interfaces:**
- Produces:

```ts
// contracts: GetMyRoundsResponse = { rounds: (GolferRoundLine & { finalizedAt: number })[] }  // newest-first
//            GetRoundArchiveResponse = { events: RoundEvent[] }  // same shape family as EventsResponse — the web folds and reuses ResultsView exactly like WatchPage's archived path
// routes (auth "golfer"): GET /me/rounds → getMyRounds(claims)
//                         GET /rounds/{roundId}/archive → getRoundArchive(claims, roundId)
// application: getRoundArchive deps { snapshots: SnapshotStore; golferStore: GolferStore; crewStore: CrewStore }
//   — snapshot absent → ApplicationError("round-not-found") [404]
//   — caller's golfer ∈ archive.participants → allow
//   — else Task 9's crewStore.countsRound arm; UNTIL Task 9 lands: 403 ApplicationError("not-a-viewer")
```

- [ ] **Step 1: failing tests:** use-case tests (participant sees events; stranger 403s; missing snapshot 404s; my-rounds newest-first); a routes-table test pinning both routes' auth tier; web structural test — ProfilePage history line renders as a link to `/rounds/<id>/archive`, ArchivedRoundPage folds events and renders ResultsView.
- [ ] **Step 2: implement.** ArchivedRoundPage: fetch with the golfer Bearer, fold via the domain `reduceRound` (web already does this in WatchPage — mirror that composition, not a new one).
- [ ] **Step 3:** `pnpm validate`.
- [ ] **Step 4:** commit `feat(contracts,application,lambda,web): the snapshot is first-class — my rounds list + open one finalized round`

---

### Task 7 (CONTROLLER): deploy #2, rebuild through new keys, drop old keyspaces

- [ ] **Step 1:** `pnpm deploy:beta`.
- [ ] **Step 2:** Invoke RebuildFunction (`aws lambda invoke --function-name <RebuildFunction> --payload '{}' --profile swng out.json`; re-invoke with the returned cursor until absent). Verify: `GET /me/record` for the dogfood account matches its pre-migration values (capture BEFORE deploying).
- [ ] **Step 3:** Write + run `scripts/dropOldProjectionItems.mjs`: Scan `swng-projections-beta`, delete items whose sk starts with `HISTORY#` or pk starts with `CREWROUNDS#`/`RECORDS#` (migration script — the one place a scan is honest). Commit it.
- [ ] **Step 4:** `pnpm e2e:beta` green; ProfilePage + archived-round page hand-checked on beta.

---

### Task 8: Crew store — seasons + counted rounds

**Files:**
- Modify: `packages/application/src/ports/crewStore.ts`, `packages/adapters-dynamodb/src/createDynamoCrewStore.ts`, `packages/adapters-dynamodb/src/keys.ts`
- Test: crew store contract tests.

**Interfaces:**
- Produces (Task 9 consumes verbatim):

```ts
export interface CrewSeason { readonly seasonId: string; readonly name: string; readonly status: "open" | "closed"; readonly createdAtMs: number }
export interface CountedRound { readonly roundId: RoundId; readonly finalizedAtMs: number; readonly appendedBy: GolferId; readonly appendedAtMs: number }
// CrewStore gains:
putSeason(crewId: CrewId, season: CrewSeason): Promise<void>;                       // upsert (create + rename + close)
getSeason(crewId: CrewId, seasonId: string): Promise<CrewSeason | undefined>;
listSeasons(crewId: CrewId): Promise<readonly CrewSeason[]>;
addCountedRound(crewId: CrewId, seasonId: string, entry: CountedRound): Promise<void>;  // attribute_not_exists → ApplicationError("round-already-counted") on collision
removeCountedRound(crewId: CrewId, seasonId: string, roundId: RoundId): Promise<void>;
listCountedRounds(crewId: CrewId, seasonId: string): Promise<readonly CountedRound[]>;
countsRound(crewId: CrewId, roundId: RoundId): Promise<boolean>;                    // any season of this crew
```

- Keys (spec §4, verbatim): `seasonSk(seasonId) = "SEASON#" + seasonId`; `countedRoundSk(seasonId, roundId) = "SEASON#" + seasonId + "#ROUND#" + roundId`. Both under `pk = crewPk(crewId)`. `listCountedRounds` = Query `begins_with(sk, "SEASON#" + seasonId + "#ROUND#")`. `listSeasons` = Query `begins_with(sk, "SEASON#")` then FILTER OUT items whose sk contains `"#ROUND#"` client-side. `countsRound` = Query `begins_with(sk, "SEASON#")` + `FilterExpression` on the entry's `roundId` attribute, `Limit`-free (entries are ~100 bytes; a crew's total is hundreds at most).

- [ ] **Step 1: failing contract tests:** season upsert/list round-trip (list excludes counted-round items); duplicate `addCountedRound` throws `round-already-counted`; the SAME round counts in TWO seasons of one crew (spec: each season is its own lens); remove-then-list; `countsRound` true across seasons, false otherwise.
- [ ] **Step 2: implement.** Plain items; no transactions needed (single-item writes).
- [ ] **Step 3:** `pnpm validate` + `pnpm test:contract`.
- [ ] **Step 4:** commit `feat(application,adapters-dynamodb): crew seasons + counted rounds — inbound roundId references as entity data`

---

### Task 9: Crew use cases + routes; the crew projection layer dies

**Files:**
- Create: `packages/application/src/crews/createSeason.ts`, `appendCountedRound.ts`, `removeCountedRound.ts`, `getSeasonStandings.ts`, `leaveCrew.ts`
- Modify: `packages/application/src/crews/addCrewMember.ts` (de-ghost), `getCrewRecords.ts` (DELETE — replaced), `packages/application/src/projections/projectArchive.ts` (crew arm DELETED), `packages/application/src/ports/projectionStore.ts` + `createDynamoProjectionStore.ts` (crew methods DELETED), `packages/contracts/src/crews.ts`, `packages/lambda/src/http/routes.ts` + `dispatch.ts` + `compositionRoot.ts`, `packages/lambda/src/http/errorMapping.ts`, `packages/application/src/rounds/getRoundArchive.ts` (crew-view arm from Task 6's note)
- Test: co-located throughout.

**Interfaces:**
- Consumes: Task 8's CrewStore surface; `SnapshotStore.getMany`; domain `crewContribution`/`aggregateSeason` (unchanged).
- Produces routes (all auth `"golfer"`): `POST /crews/{crewId}/seasons` (body `{name}`), `GET /crews/{crewId}/seasons`, `POST /crews/{crewId}/seasons/{seasonId}/rounds` (body `{roundId}`), `DELETE /crews/{crewId}/seasons/{seasonId}/rounds/{roundId}`, `GET /crews/{crewId}/seasons/{seasonId}/standings`, `POST /crews/{crewId}/leave`. DELETED route: `GET /crews/{crewId}/records`.
- Error taxonomy → HTTP: `round-already-counted` 409, `season-not-found` 404, `season-closed` 409, `did-not-play` 403 (appender's golferId not in the snapshot's participants), `round-not-found` 404 (no snapshot yet — "finish the round first"), `not-the-appender` 403, `ghost-not-addable` 409, `not-a-member` 403 (existing).

- [ ] **Step 1: failing use-case tests, the rules verbatim from spec §4:**
  - append: member ∧ played ∧ snapshot exists ∧ season open → entry written; each guard's failure case.
  - remove: only the appender may remove.
  - standings: entries → `getMany` → `aggregateSeason(map crewContribution)` computed in the call; a golfer in a counted round who is NOT on the roster appears with `member: false` (guest labeling — names resolved from the snapshots' own participants; the most recently finalized counted snapshot wins a name conflict).
  - leaveCrew: member item removed; counted rounds they appended REMAIN; re-listing standings still includes them (`member: false` now).
  - addCrewMember: target golfer without a bound sub → `ghost-not-addable`.
  - projectArchive: NO store call with "crew" in its name, ever (assert on a recording fake).
- [ ] **Step 2: implement.** `getSeasonStandings` response:

```ts
// contracts: SeasonStandingsResponse = { seasonId, name, status,
//   rounds: { roundId, finalizedAt, appendedBy }[],           // newest-first by finalizedAt
//   ledger: (SeasonLedgerLine & { name: string; member: boolean })[],
//   headToHead: HeadToHeadRecord[] }
```

Delete: `getCrewRecords.ts`, the projector's crew arm + `seasonOf` + `finalizedAtMsOf`'s crew consumers, ProjectionStore's `putCrewRound`/`listCrewRounds`/`putSeasonRecords`/`getSeasonRecords`/`wipeCrew` + their adapter code + the `CREWROUNDS#`/`RECORDS#` key helpers (deferred from Task 4). `getRoundArchive` gains the crew arm: caller not a participant → `listByGolfer(caller)` → any crew `countsRound(crewId, roundId)` → allow.
- [ ] **Step 3:** `pnpm validate` + `pnpm test:contract`. Then the proof-grep: `grep -rn "putCrewRound\|getSeasonRecords\|putSeasonRecords\|wipeCrew\|CREWROUNDS\|RECORDS#\|seasonOf" packages/ apps/` → only spec/plan docs may match.
- [ ] **Step 4:** commit `feat(application,contracts,lambda): seasons, counted rounds, standings-on-read — the crew projection layer is deleted`

---

### Task 10: `crewId` leaves the round

**Files:**
- Modify: `packages/domain/src/round/events.ts` (drop `crewId` from `round-created`), `state.ts` (drop `RoundState.crewId` + the conditional spread), `archive.ts` (drop from `RoundArchive` + `settleRound`), `packages/contracts/src/round.ts` + `commands.ts` (drop from event schema + `StartRoundRequest`; ADD a test proving an OLD stored event JSON carrying `crewId` still parses — Zod strips unknown keys by default; if any schema here is `.strict()`, relax that one field's owner), `packages/application/src/rounds/startRound.ts` (crewId arm + `requireCrewMember` call deleted), `joinRound.ts`, `golferIdentity.ts`, `packages/application/src/crews/membership.ts` (if `requireCrewMember` loses its last round-side consumer, it stays — crews still use it), `apps/web/src/routes/CreateRoundPage.tsx` (stops sending crewId; "Play the usual" keeps pre-filling course/tee/roster/games client-side — the tag was never needed for that)
- Sweep: `grep -rn "crewId" packages/domain packages/contracts packages/application/src/rounds packages/client apps/web/src` — every hit either dies or is crew-side (crews/* files keep theirs).

**Interfaces:**
- `resolveSuppliedGolfer` ctx changes: `{ sub?: string; crewId?: CrewId }` → `{ sub?: string }`. The crew-consent arm re-derives consent from CO-MEMBERSHIP instead of the round's tag: a claimed target golfer, caller signed-in, caller ≠ target → allow iff `listByGolfer(callerGolferId)` ∩ `listByGolfer(targetGolferId)` is non-empty; else `golfer-claimed` as today. (Strictly more correct: consent flows from the crew relationship itself, not from which round it happens in.)

- [ ] **Step 1: failing tests:** the golferIdentity matrix rewritten for co-membership (shared crew → allowed; no shared crew → `golfer-claimed`; the existing as-self and unclaimed arms byte-identical); the old-event-JSON-with-crewId parse test; a domain test that `reduceRound` over a log whose genesis carries a stray `crewId` key produces state with NO `crewId` property.
- [ ] **Step 2: implement + sweep.** `pnpm validate`.
- [ ] **Step 3:** proof-grep from the sweep line above: zero non-crew-side hits.
- [ ] **Step 4:** commit `feat(domain,contracts,application,web): the round is a sealed leaf — crewId deleted from events, state, archive, and wire`

---

### Task 11: Crew web — seasons, count-a-round, leave

**Files:**
- Modify: `apps/web/src/crews/CrewPage.tsx` (+ its test), `apps/web/src/api.ts`-equivalent client calls (find via `grep -rn "records" apps/web/src/crews`)
- Create: `apps/web/src/crews/SeasonPanel.tsx` (+ test)

**Behavior to pin (structural tests):**
- CrewPage: season list + "New season" (name field, 1–60 chars); per season: standings table (ledger + head-to-head; non-members labeled "guest"), counted-rounds list where each row links to `/rounds/<id>/archive` (Task 6's page), a "Count a round…" button.
- "Count a round…": picker listing the signed-in golfer's own finalized rounds (`GET /me/rounds`) not yet counted in THIS season; picking one POSTs the append; 409 `round-already-counted` surfaces as "already counted", not raw error text (M9 papercut discipline holds).
- Remove affordance only on rounds the caller appended.
- "Leave crew" with confirm; add-member UI: ghost path REMOVED — join code + claimed-golfer add only.
- [ ] Steps: failing component tests → implement → `pnpm validate` → commit `feat(web): the crew page speaks seasons — count a round, standings on read, leave`

---

### Task 12 (CONTROLLER): deploy #3 + the crewSeason e2e rewrite + gate

- [ ] **Step 1:** `pnpm deploy:beta`.
- [ ] **Step 2:** Rewrite `apps/web/e2e/crewSeason.spec.ts` against the new model, SAME frozen deck and SAME frozen expectations (the deck's math didn't change — only how rounds attach): play the 12 rounds UN-tagged via API → create one season → append all 12 (each by a member who played) → `GET .../standings` must equal the frozen ledger EXACTLY (singles H2H 5W-5L-2H, skins 54 each, stableford 430/430/435/435) → golfer-record rebuild parity (invoke rebuild, records identical) → the mid-season ghost-claim story unchanged → NEW: un-append one round, assert standings shift by exactly that round's contribution, re-append, assert restoration.
- [ ] **Step 3:** Gate: `pnpm validate`, `pnpm e2e:beta`, crewSeason spec green ×2 consecutive (full logs to files).
- [ ] **Step 4:** commit `test(e2e): crew season over counted rounds — same frozen deck, inbound references`

---

### Task 13: Presence — live rounds by identity

**Files:**
- Modify: `packages/application/src/rounds/startRound.ts`, `joinRound.ts`, `addParticipant.ts` (write presence), `packages/application/src/projections/projectArchive.ts` (delete presence for every participant — the snapshot in hand has the list), `packages/application/src/golfers/` → Create: `getMyLiveRounds.ts`, `packages/contracts/src/golfers.ts`, `packages/lambda/src/http/routes.ts` + wiring, `apps/web/src/routes/HomePage.tsx`

**Interfaces:**
- Consumes: `ProjectionStore.putLive/deleteLive/listLive` (Task 4).
- Produces: route `GET /me/rounds/live` (auth `"golfer"`) → `{ rounds: { roundId, courseName, joinedAt }[] }`; presence written for EVERY participant golferId (ghosts included — a mid-round claim inherits presence for free), `expiresAtSec = nowSec + 36*3600`.

- [ ] **Step 1: failing tests:** start/join/addParticipant each write presence for each participant they seat (recording fake); projector deletes presence per participant on a snapshot; presence write failure does NOT fail the join (wrap in try/catch + logger.warn — a discovery nicety must never block play; pin with a test where putLive throws and join still succeeds); HomePage signed-in renders the live list with each row linking into the round, anonymous keeps the device-token list.
- [ ] **Step 2: implement.** HomePage: signed-in → live list is primary; the credentialStore list remains ONLY for anonymous sessions (spec §5).
- [ ] **Step 3:** `pnpm validate`.
- [ ] **Step 4:** commit `feat(application,lambda,web): your rounds follow your identity — presence with TTL, not device tokens`

---

### Task 14: Capability from identity — the token re-mint

**Files:**
- Create: `packages/application/src/rounds/mintParticipantToken.ts` (+ test)
- Modify: `packages/contracts/src/round.ts`, `packages/lambda/src/http/routes.ts` + wiring, `apps/web/src/routes/HomePage.tsx` (tap a live round with no local credential → re-mint → enter)

**Interfaces:**
- Produces: route `POST /rounds/{roundId}/token` (auth `"golfer"`) → `{ roundId, token, golferId }` (same shape as JoinRoundResponse). Use case deps `{ journal, golferStore, tokens }`: `getBySub` → no golfer → 403 `not-a-participant`; `loadRoundState` → caller's golferId ∈ participants → `tokens.issue({ scope: "participant", roundId, golferId })`; else 403 `not-a-participant`. Round already final → 409 `round-final` (nothing to score; the archive view is the read path).

- [ ] Steps: failing tests (participant on a new device gets a working token; non-participant 403; final round 409) → implement → web wiring (store the re-minted credential exactly as a join would) → `pnpm validate` → commit `feat(application,lambda,web): scoring capability derives from participation, not the device that joined`

---

### Task 15: `round-abandoned`

**Files:**
- Modify: `packages/domain/src/round/events.ts` (union member `{ kind: "round-abandoned" }`), `state.ts` (`RoundStatus` gains `"abandoned"`; `LIFECYCLE_STATUS` gains the mapping), `archive.ts` (`settleRound` throws `DomainError("round-abandoned")` on an abandoned log), `packages/contracts/src/round.ts` (event schema member), `packages/application/src/rounds/finalizeRound.ts` (abandoned → `round-not-live` family rejection falls out of status; verify), Create: `packages/application/src/rounds/abandonRound.ts`, Modify: routes + wiring, `apps/web/src/round/` menu (confirm-gated "Scrap this round"), `apps/web/src/routes/RoundPage.tsx` (abandoned terminal state)
- Client: `packages/client` fold ignores unknown kinds already (append-only rule) — add the kind to its known set + a session test that an abandoned round surfaces a terminal, non-scorable state.

**Interfaces:**
- Produces: route `POST /rounds/{roundId}/abandon` (auth `"participant"`) → `{ status: "abandoned" }`. Use case: load state; `requireParticipant`; `final` → 409 `round-final`; already abandoned → idempotent success; else append `round-abandoned` (plain append — terminal regardless of interleaving), `deleteLive` for every participant, broadcast.
- Domain invariants pinned by tests: `settleRound` throws on an abandoned log (NO snapshot can exist for an abandoned round — this is the spec's "counts nowhere" made structural); `finalizeRound` on an abandoned round rejects; score appends after abandon are rejected by the live-status guards; abandon after final rejects.

- [ ] Steps: failing domain tests → domain impl → failing use-case/route tests → impl → web confirm dialog + terminal state → `pnpm validate` → commit `feat(domain,application,web): round-abandoned — a scrapped round produces no snapshot and counts nowhere`

---

### Task 16 (CONTROLLER): deploy #4, full gates, docs correction

- [ ] **Step 1:** `pnpm deploy:beta`; `pnpm e2e:beta` ×2; `pnpm e2e:field` (fieldTest is crew-free — should pass untouched; if it references any deleted surface, that's a finding, not a test fix to force).
- [ ] **Step 2:** Controller flow-walk on beta (hosted URL): create → score → abandon a second round → home shows live rounds by identity on a SECOND browser profile (the drift-2 acceptance) → re-mint scoring there (drift-3 acceptance) → finalize → count it for a crew season → open the snapshot from the crew page.
- [ ] **Step 3:** Docs: `docs/architecture.md` — rewrite §"Crew" (curated inbound roundId lists; seasons as crew-defined groupings; note it now matches Competition's own "reference rounds, never own scoring" principle), update the persistence sketch table (snapshots table row; projections row drops LEDGER/H2H; core row gains seasons/counted rounds), update §3's stream line. `CLAUDE.md` current-state paragraph. `.superpowers/sdd/progress.md` ledger entries.
- [ ] **Step 4:** commit `docs(architecture): the round is a sealed leaf — architecture doc matches the shipped model`

---

## Self-review notes (run before execution)

- Spec §2 transaction → Task 2. §3 stable keys/in-memory sort → Task 4 (+ `getMyRecord` sort). §4 crews → Tasks 8–11. §5 presence → Task 13 (+ TTL in Task 1). §6 re-mint → Task 14. §7 abandon/view/list → Tasks 15/6. §8 rebuild → Task 5 (re-settle layer: documented, no tooling — YAGNI per spec "rare, surgical"). §9 deletions → Tasks 2, 4, 5, 9, 10 with proof-greps in 9 and 10. §11 migration → Tasks 3, 7. §12 ordering → phase map.
- Type-consistency: `SnapshotStore`/`AppendOptions.snapshot` (Task 2) consumed by 5, 6, 9; `ProjectionStore` (Task 4) consumed by 9, 13, 15; `CrewSeason`/`CountedRound` (Task 8) consumed by 9, 11, 12.
- Known intermediate states: Task 4 keeps the old crew store methods alive until Task 9 deletes them (flagged in both); Task 6 ships participant-only archive auth until Task 9 adds the crew arm (flagged in both).
