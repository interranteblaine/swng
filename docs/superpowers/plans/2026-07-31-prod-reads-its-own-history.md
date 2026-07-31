# Prod Reads Its Own History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move prod's 15 pre-rename records onto the current shape and deploy HEAD to prod, without deleting or rewriting anything else and without shipping a line of compatibility code.

**Architecture:** Two rename rules applied to 12 round events and 3 snapshots. The 8 record lines are not migrated — overwriting a snapshot fires the snapshots-table stream, and the projector re-derives them through the same `projectArchive` a real finalize uses.

**Tech Stack:** Node ESM operational scripts (`scripts/*.mjs`, the `createRequire` idiom the existing scripts use), AWS SDK v3 DynamoDB DocumentClient, `@swng/contracts` + `@swng/domain` built dists, AWS CDK.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-31-prod-reads-its-own-history-design.md`. Read it before Task 1 — §4 has the exact transform and §2 the exact inventory.
- **PROD DATA IS NEVER WIPED.** No `scrapCourseAndRoundData.mjs` against prod. A step that deletes a prod record is a defect, not an option. The only writes this arc makes are the 15 in spec §4, plus whatever the projector derives on its own.
- **NO COMPATIBILITY CODE.** No tolerate arm, no legacy union member, no `?? courseHandicap` in `packages/`. If a task finds itself editing a schema, it has gone wrong. `pnpm validate` and `pnpm test:contract` must be untouched-and-green, not made green.
- **Every prod-touching script is dry-run by default.** Writing requires an explicit `--write`.
- Prod facts, verified read-only 2026-07-31 (spec §2, §8): 6 golfers, 4 rounds, 3 snapshots, 8 record lines, 11 course cards, 1 crew, 2 seasons. 15 records need migrating: 9 `participant-joined`, 3 `participant-handicap-set`, 3 snapshots.
- Expected post-migration values, hand-checkable: rosters `Blaine=21, Pita=36` / `Blaine=13, Pita=18, Michael=10` / `Blaine=20, Ryan=0, Pita=36` / abandoned `Blaine=31`; scores Blaine 98/114/53, Pita 119/124/60, Ryan 85, Michael 42.
- Table names are `swng-{rounds,snapshots,projections,core}-${stage}`. AWS profile `swng`, region `us-east-1`.

## File Structure

| file | responsibility |
|---|---|
| `scripts/prodStrokesMigration.mjs` | The two transform rules and nothing else. Pure functions, no AWS, no I/O — so both scripts below share one definition and the test can import it. |
| `scripts/migrateProdStrokes.mjs` | Reads prod, applies the transform, exports a backup, writes the 15 records. Dry-run unless `--write`. Also `--restore <file>`. |
| `scripts/checkProdParses.mjs` | Reads every item in every prod table and parses it with HEAD's schemas. Exit non-zero on any failure. The total gate, run before and after. |
| `scripts/prodStrokesMigration.test.mjs` | Vitest over the transform's edge cases — idempotency, already-migrated, neither-field-present. |

Splitting the transform out is the one structural decision worth making: it is the only part of this arc that must be *identical* between the thing that changes prod and the thing that checks prod. Two copies could drift and the drift would be invisible.

---

## Task 1: The transform, and its test

**Files:**
- Create: `scripts/prodStrokesMigration.mjs`, `scripts/prodStrokesMigration.test.mjs`

**Interfaces:**
- Produces: `seat(participant)`, `migrateEvent(event)`, `migrateArchive(archive)` — all pure, all idempotent, all guarded on the old shape being present. Tasks 2 and 3 import these and define no rename logic of their own.

- [ ] **Step 1: Write the failing test**

Create `scripts/prodStrokesMigration.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { seat, migrateEvent, migrateArchive } from "./prodStrokesMigration.mjs";

const oldSeat = { name: "Blaine", courseHandicap: 21, tee: "White", golferId: "g1" };
const newSeat = { name: "Blaine", tee: "White", golferId: "g1", strokes: 21 };
const envelope = { opId: "o1", authorId: "g1", hlc: { deviceId: "server", wallMs: 1, counter: 0 }, seq: 2 };

describe("seat", () => {
  it("renames courseHandicap to strokes", () => {
    expect(seat(oldSeat)).toEqual(newSeat);
  });

  it("leaves an already-migrated seat alone", () => {
    expect(seat(newSeat)).toEqual(newSeat);
  });

  it("leaves a seat carrying BOTH alone — strokes already wins, and guessing would be worse", () => {
    const both = { ...newSeat, courseHandicap: 99 };
    expect(seat(both)).toEqual(both);
  });

  it("leaves a seat carrying NEITHER alone rather than inventing a 0", () => {
    const neither = { name: "Blaine", tee: "White", golferId: "g1" };
    expect(seat(neither)).toEqual(neither);
  });
});

describe("migrateEvent", () => {
  it("renames the kind AND the field on a correction", () => {
    expect(migrateEvent({ ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 })).toEqual({
      ...envelope,
      kind: "participant-strokes-set",
      golferId: "g1",
      strokes: 20,
    });
  });

  it("migrates the seat inside a join", () => {
    expect(migrateEvent({ ...envelope, kind: "participant-joined", participant: oldSeat }).participant).toEqual(newSeat);
  });

  it("passes every other kind through byte-identically", () => {
    const score = { ...envelope, kind: "score-recorded", golferId: "g1", hole: 3, result: { kind: "strokes", strokes: 5 } };
    expect(migrateEvent(score)).toEqual(score);
  });

  it("is idempotent on every kind", () => {
    for (const e of [
      { ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 },
      { ...envelope, kind: "participant-joined", participant: oldSeat },
    ]) {
      const once = migrateEvent(e);
      expect(migrateEvent(once)).toEqual(once);
    }
  });
});

describe("migrateArchive", () => {
  it("migrates the roster AND the events embedded inside it", () => {
    const archive = {
      roundId: "r1",
      participants: [oldSeat],
      events: [{ ...envelope, kind: "participant-handicap-set", golferId: "g1", courseHandicap: 20 }],
    };
    const out = migrateArchive(archive);
    expect(out.participants).toEqual([newSeat]);
    expect(out.events[0]).toMatchObject({ kind: "participant-strokes-set", strokes: 20 });
    expect(migrateArchive(out)).toEqual(out);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run scripts/prodStrokesMigration.test.mjs`
Expected: FAIL — cannot resolve `./prodStrokesMigration.mjs`.

**`scripts/` is in no workspace project**, so nothing runs these tests by default: `pnpm validate` ends in `pnpm test` → `pnpm -r test`, which runs each project's own `test` script, and `pnpm-workspace.yaml` lists only `apps/*`, `packages/*`, `e2e`. (`apps/web/scripts/webEnv.test.mjs` runs solely because it sits inside `apps/web`.) There is no root vitest invocation to configure, so an `include` does not help.

Wire the run into the gate instead. `vitest` is already a root devDependency, and the repo has the exact precedent: `"lint": "eslint . --max-warnings 0 && node scripts/checkGolfArithmeticFence.mjs"` chains a root-level check into a gate script. Follow that shape, confirm root `test` calling `pnpm -r test` does not recurse into the root package, and **prove the wiring bites** by breaking a test on purpose, watching `pnpm validate` go red, and restoring it. A test that guards a live production mutation and never runs is worse than no test, because it reads as coverage.

- [ ] **Step 3: Write the transform**

Create `scripts/prodStrokesMigration.mjs` with exactly the spec §4 implementation:

```js
// The two rename rules that move a prod record written by the 2026-07-24 launch build onto the
// shape HEAD reads. Pure and I/O-free on purpose: the script that WRITES prod and the script that
// CHECKS prod must apply an identical transform, and two copies could drift invisibly.
//
// Every rule is guarded on the old shape actually being present, which is what makes the whole
// migration idempotent — an already-migrated record passes through untouched, so a re-run is a
// no-op and an interrupted run is just a shorter next run.
//
// A record carrying NEITHER field is left alone rather than defaulted to 0. Zero is a legal,
// meaningful strokes value, so inventing one would turn an unreadable record into a confidently
// wrong one — and the schema refusing it is the outcome we want.

export const seat = (p) =>
  p && p.courseHandicap !== undefined && p.strokes === undefined
    ? (({ courseHandicap, ...rest }) => ({ ...rest, strokes: courseHandicap }))(p)
    : p;

export const migrateEvent = (e) => {
  if (e.kind === "participant-joined") return { ...e, participant: seat(e.participant) };
  if (e.kind === "participant-handicap-set") {
    const { courseHandicap, kind, ...rest } = e;
    return { ...rest, kind: "participant-strokes-set", strokes: courseHandicap };
  }
  return e;
};

export const migrateArchive = (a) => ({
  ...a,
  participants: a.participants.map(seat),
  events: a.events.map(migrateEvent),
});

// True iff the transform would actually change this value — the script uses it to decide what to
// write, so an unchanged record is never put back over itself.
export const changed = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
```

- [ ] **Step 4: Run it and watch it pass, then the whole gate**

Run: `pnpm exec vitest run scripts/prodStrokesMigration.test.mjs` → all pass.
Then `pnpm validate` → exit 0. Nothing under `packages/` changed, so this must be green without any adjustment; if it is not, something outside this task's scope was touched.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scripts): the prod strokes-rename transform, tested

Two rules, both guarded on the old shape being present so the whole migration
is idempotent. Pure and I/O-free so the script that writes prod and the script
that checks prod share one definition rather than two that can drift.

A record carrying neither field is left alone rather than defaulted to 0 — zero
is a legal strokes value, so inventing one would turn an unreadable record into
a confidently wrong one."
```

---

## Task 2: The two instruments

**Files:**
- Create: `scripts/migrateProdStrokes.mjs`, `scripts/checkProdParses.mjs`

**Interfaces:**
- Consumes: `seat`/`migrateEvent`/`migrateArchive`/`changed` from Task 1.
- Produces: two CLIs Task 3 runs. Neither defines a rename rule of its own.

Both use the `createRequire` idiom the existing scripts use (see the top of `scripts/scrapCourseAndRoundData.mjs`) — a bare `import "@aws-sdk/..."` does not resolve from `scripts/`:

```js
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
```

HEAD's schemas come from the built dist: `import { roundEventSchema, roundArchiveSchema } from "../packages/contracts/dist/index.js"`. Both scripts must fail with a clear message if that dist is missing — tell the operator to run `pnpm build`, do not silently skip checks.

- [ ] **Step 1: Write `scripts/checkProdParses.mjs`**

The total gate. Scans all four tables and parses every item with the schema or type that actually reads it at HEAD:

- rounds-table items with an `event` → `roundEventSchema`
- snapshots → `roundArchiveSchema`
- projections items with a `line` → assert `typeof line.strokes === "number"`
- rounds-table items without an `event` (`OPID#` tombstones, round pointers) and core-table items → counted and reported as **not parsed**, never silently omitted. A gate that quietly skips a category is how you get a green check over unexamined data.

Prints a per-category summary with counts and, for failures, the zod issue path. **Exits non-zero if any item fails.** Takes `--stage` (default `prod`). Read-only: import `ScanCommand` and nothing else.

For the two shapes prod carries, print the resolved value rather than just `ok` — a `participant-joined` reports the strokes it parsed to, and a `participant-strokes-set` reports its number. A check that only says "parsed" cannot tell a faithful translation from a confidently wrong one, and these numbers are hand-checkable against the Global Constraints.

- [ ] **Step 2: Run it against prod BEFORE anything changes, and confirm it fails correctly**

Run: `AWS_PROFILE=swng node scripts/checkProdParses.mjs --stage prod`
Expected: **exit non-zero**, reporting exactly 15 failures — 9 `participant-joined`, 3 `participant-handicap-set`, 3 archives — plus 8 projection lines flagged for a non-number `strokes`.

This is the instrument proving it can actually detect the problem. A gate that has never been seen to fail is not a gate. Save the output to the arc's workspace.

- [ ] **Step 3: Write `scripts/migrateProdStrokes.mjs`**

Header comment states plainly: this writes to a production table; it is dry-run unless `--write`; it never deletes anything; prod is never wiped.

Behaviour:

1. `--stage` (default `prod`), `--write` (absent ⇒ dry run), `--restore <file>`.
2. **Before any write**, scan all four tables and dump every item to `prod-backup-<stage>-<timestamp>.json`. Print the path and the item count. If the export fails for any reason, exit before writing.
3. Scan rounds + snapshots, apply the transform, keep only records where `changed(before, after)` is true.
4. **Parse each transformed record with HEAD's schema before writing it.** A record that would not parse is never written — report and exit non-zero. This makes it structurally impossible to write a record the app cannot read.
5. Dry run: print each record's key, `kind`, and the before→after of the changed field, then the total. Write nothing.
6. `--write`: `PutCommand` each record. Rounds-table items keep their `pk`/`sk`; snapshot items keep their `pk` and every other attribute (`finalizedAt` and anything else) — put the whole item back with only `event`/`archive` replaced, never a reconstructed item.
7. Write events first, snapshots last, so the stream fires only once everything else is consistent.
8. `--restore <file>`: read the backup and `PutCommand` the original items back verbatim. Same `--write` requirement.
9. Print a final count. Exit non-zero on any failure.

- [ ] **Step 4: Dry-run it against prod**

Run: `AWS_PROFILE=swng node scripts/migrateProdStrokes.mjs --stage prod`
Expected: **15 records** listed with their exact keys, matching spec §4's write set item for item; every one parses; "DRY RUN — nothing written". Save the output.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(scripts): prod strokes migration + a total parse gate

checkProdParses reads every item in every prod table and parses it with HEAD's
own schemas, exiting non-zero on any failure — and it was run BEFORE the
migration and seen to fail on exactly the 15 known records, because a gate that
has never failed is not a gate.

migrateProdStrokes is dry-run unless --write, exports every item of all four
tables before touching anything, parses each transformed record before writing
it so an unreadable record cannot be written, and has --restore built in rather
than improvised."
```

---

## Task 3: The prod run (CONTROLLER-RUN)

This is the same controller-run deploy cycle as every other stage, including prod's own launch
(Arc C, 2026-07-24). It is execution behind gates, not an owner decision.

**Two live-environment facts, stated rather than asked about.** Prod serves 6 real accounts.
Between Step 4 and the end of Step 5 its rounds and record pages return errors; between Step 5 and
Step 6 the served web bundle is the launch one, whose request shapes the new lambda rejects. Both
windows are the time between two commands. Run Steps 4–6 back to back, and do not begin if a round
is known to be in progress.

- [ ] **Step 1:** `pnpm validate` exit 0 and `pnpm test:contract` ≥ 96 at HEAD. Neither should have needed changing — confirm that, do not fix it.
- [ ] **Step 2:** `AWS_PROFILE=swng node scripts/checkProdParses.mjs --stage prod` — expect the 15 known failures, unchanged from Task 2 Step 2. A different count means prod moved since the inventory; stop and re-inventory.
- [ ] **Step 3:** `cd apps/infra-cdk && STAGE=prod pnpm -s exec cdk diff swng-prod --profile swng`. The delta must be **only**: 5 lambda code updates, `/rounds/{roundId}/handicap` destroyed, `/rounds/{roundId}/strokes` created, and the stage `DependsOn` swapping one entry. **Any table, user pool, Cognito, WAF, secret or CloudFront line stops the deploy.**
- [ ] **Step 4:** `pnpm deploy:prod` → `UPDATE_COMPLETE`. Confirm on the deployed API that `POST /rounds/{roundId}/strokes` exists and `/handicap` does not.
- [ ] **Step 5:** `AWS_PROFILE=swng node scripts/migrateProdStrokes.mjs --stage prod --write`. Confirm the backup path is printed and the file exists before proceeding. Expect 15 records written.
- [ ] **Step 6:** `pnpm publish:web:prod`, then `curl -s https://swng.golf/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'` to confirm the built bundle is the one being served.
- [ ] **Step 7:** `AWS_PROFILE=swng node scripts/checkProdParses.mjs --stage prod` → **exit 0, zero failures**, and the printed strokes reading 21/36, 13/18/10, 20/0/36, 31.
- [ ] **Step 8: The projector did its own work.** Re-read the 8 projection lines and confirm each now carries a numeric `strokes` and no longer carries `ags`, `differential` or `courseHandicap` — proving the stream re-derived them with no rebuild invoked. If any line still has the old shape, the stream did not fire; investigate before touching anything, and do NOT hand-write a line.
- [ ] **Step 9: Nothing was lost.** Re-count every table and confirm against the Global Constraints: 6 golfers, 4 rounds, 3 snapshots, 8 record lines, 11 course cards, 1 crew, 2 seasons, 150 tombstones. That the migration deleted nothing is this arc's central claim and it gets verified, not assumed.
- [ ] **Step 10: Eyes on pixels.** In a browser on `swng.golf`, open each of the 3 finished rounds and confirm the scorecard renders with the corrected strokes (36 / 20 / 13), then open a golfer's record and confirm the history rows show 98/114/53 and friends. Screenshot each, read the screenshots, and check the console for errors.

---

## Task 4: Retire the precondition

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Delete the whole "#### Standing precondition — prod needs a LEGACY READ ARM before it first receives the typed-strokes arc" section. It is discharged, and its own closing paragraph says whoever discharges it deletes it in the same commit.
- [ ] **Step 2:** Add this arc's record to the narrative section: what prod held, the 15 records, the two rules, that the record lines were re-derived by the stream rather than migrated, the infrastructure delta, and the verification numbers. Note plainly that the first design proposed permanent compatibility code for 15 records and was rejected on proportion — spec §7 holds the reasoning.
- [ ] **Step 3:** Commit.

---

## Self-Review

**Spec coverage.** §1 → context. §2's inventory → Global Constraints + T2's gate. §3's non-goals → Global Constraints. §4's transform → T1; its write set → T2 Step 4. §4's "regenerated, not migrated" → T3 Step 8. §5's ordering → T3 Steps 4–6. §6's six safety properties → T2 Step 3 (export, parse-before-write, restore, dry-run default) and T1 (idempotency) and T2 Step 1 (total gate). §7 → T4 Step 2. §8 → already performed, and re-run as T3 Steps 2/3. §9's seven "done means" → T3 Steps 3,4,5,7,8,10 and T4.

**The thing a reviewer must not "simplify".** The transform's guards look redundant — a `?? 0` or an unguarded rename would pass every test that only checks the happy path. They are the idempotency mechanism and the refusal-over-guessing mechanism at once. Removing them makes a re-run destructive and turns an unreadable record into a silently wrong one.

**Placeholder scan.** No TBDs. Every code step carries its real code; the two scripts in Task 2 are specified by behaviour rather than transcribed because they are I/O shells over Task 1's tested logic, and their exact output format is not load-bearing — what is load-bearing (dry-run default, export before write, parse before write, exit codes, read-only imports) is stated explicitly.

**Type consistency.** `seat`/`migrateEvent`/`migrateArchive`/`changed` are named identically in T1's definition, T1's test, and both T2 scripts.

**Ordering.** T1 before T2 (the scripts import the transform). T2 before T3, and T2 Step 2 — watching the gate fail — is what makes T3 trustworthy. T4 last, because the precondition is not discharged until the deploy has actually happened.
