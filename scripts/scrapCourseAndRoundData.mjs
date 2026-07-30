// The beta scrap (course-cards spec §9, owner amendment 2026-07-15): the course-cards arc
// replaces beta's course model outright, and the owner's ruling extends past courses to ALL
// beta round data — no legacy snapshot tier is ever allowed to exist alongside the new one.
// This is the one-time instrument, run by the controller (never by an agent, never in CI)
// against AWS immediately after the beta deploy:
//
//   - core table:        delete every item whose `pk` begins with `COURSE#` (legacy
//                         single-doc courses AND any new-model items already written — a full
//                         reset so Casa Verde can be re-entered clean); additionally, every
//                         `GOLFER#`/`sk="GOLFER"` item carrying a `homeCourseId` attribute gets
//                         that attribute REMOVEd (a wiped course must not dangle from a
//                         profile). Golfers, SUB# pointers, and crews are otherwise untouched.
//                         SKIPPABLE — pass `--keep-courses` (see FLAGS) when only round data
//                         is being scrapped; the other three passes have no opt-out.
//   - rounds table:       delete every item — the table holds only round event journals,
//                         META pointers, and OPID# tombstones, none of which survive the scrap.
//   - snapshots table:    delete every item — one immutable RoundArchive per finalized round
//                         (pk-only key, no sk), all of them scrapped with their rounds.
//   - projections table:  delete every item — ROUND# history lines, LIVE# presence rows, and
//                         any dead rows, all downstream of the rounds/snapshots just deleted.
//
// Known dangling reference: crews compute season standings by counting a member's own
// finalized rounds by roundId (docs — "the crew correction," 2026-07-13) — after this script
// runs, every counted roundId on a beta crew points at a snapshot that no longer exists.
// Beta crews are e2e leftovers with no real-world stakes, so this is accepted as-is; the
// controller may separately re-run `dropCrewData.mjs` at their discretion if a clean crew
// slate is also wanted.
//
// Operational lesson from the first run (2026-07-15, live incident): deleting snapshots
// emits one REMOVE per item onto the snapshots table's stream — 1,080 of them saturated the
// projector's shard for hours because the handler then treated any record without a
// NEW_IMAGE as a poison record (bisect + 10 retries each), starving new rounds' history
// lines behind the backlog. The projector now skips REMOVEs (compositionRoot.ts's handler,
// fixed same-day), so a future run drains in seconds — but expect a burst of skip logs, and
// know that this script is WHY that skip branch exists.
//
// The ROUNDS table's stream is ALSO still enabled (swngStack.ts's roundsTable — enabled,
// consumed by nothing): this script's ~130k round deletions emitted ~130k REMOVEs into it,
// harmless only because no consumer exists. Before ANY future bulk delete, enumerate every
// stream consumer in the blast radius first — that is the general rule this incident bought.
//
// FLAGS
//
// THE COURSE CHOICE IS MANDATORY. Exactly one of `--keep-courses` / `--wipe-courses` must be
// passed; the script exits non-zero and does nothing otherwise. There is NO default, safe or
// dangerous (owner decision, 2026-07-30). The reasoning is the one this codebase runs on:
// make illegal states unrepresentable rather than documenting the hazard — and it applies with
// MORE force here, because this instrument is irreversible and operates on data no test can
// regenerate. Two hand-entered real course cards (Casa Verde GC, Sandy Hollow Nine) are the
// field-test fixtures, the field e2e specs RE-SEED courses so no gate would catch their loss,
// and "run by the controller, never by an agent" above is prose — prose stops nothing. An exit
// code does.
//
//   --stage <name>    which stage's four tables to operate on (default `beta`).
//   --dry-run         count and report, delete nothing. Composes with every other flag.
//   --keep-courses    make the CORE-TABLE PASS ABOVE A NO-OP: no `COURSE#` item is deleted and
//                     no golfer's `homeCourseId` is stripped. The rounds/snapshots/projections
//                     passes still run in full. Named for the OUTCOME rather than the pass,
//                     because at a terminal under pressure "keep courses" has exactly one
//                     reading.
//
//                     This is the choice whenever an arc replaces the ROUND model and leaves
//                     the course model alone — the relative-to-par strokes arc (spec 2026-07-29
//                     §8) is the first close-out that requires it.
//
//   --wipe-courses    run the core-table pass in full: delete every `COURSE#` item and strip
//                     `homeCourseId` from every golfer profile. The original course-cards-arc
//                     behaviour (spec 2026-07-15 §9), kept available and unchanged — an arc that
//                     legitimately replaces the COURSE model still needs it. Just no longer
//                     what you get by forgetting to say so.
//
// Whichever is chosen is LOGGED, in dry-run and for real: `SKIPPED …` or `RAN …`, naming the
// flag. Silence is how someone later concludes the wrong thing happened.
//
//   node scripts/scrapCourseAndRoundData.mjs --stage beta (--keep-courses|--wipe-courses) [--dry-run]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const dryRun = process.argv.includes("--dry-run");
// The course choice — see the FLAGS block above. Neither is a default; exactly one is required.
const keepCourses = process.argv.includes("--keep-courses");
const wipeCourses = process.argv.includes("--wipe-courses");

// Refuse to run without an explicit choice, BEFORE anything reads or writes a table. This guard
// is the whole safety mechanism: it is not advice, and it cannot be forgotten past. Both flags
// together is equally illegal — it is not a state a human means, so it is not one we resolve.
if (keepCourses === wipeCourses) {
  console.error(
    keepCourses
      ? "error: --keep-courses and --wipe-courses contradict each other — pass exactly one."
      : "error: choose what happens to courses — pass --keep-courses (scrap rounds/snapshots/projections only) or --wipe-courses (also delete every COURSE# item and strip homeCourseId). There is no default.",
  );
  process.exit(1);
}

const coreTable = `swng-core-${stage}`;
const roundsTable = `swng-rounds-${stage}`;
const snapshotsTable = `swng-snapshots-${stage}`;
const projectionsTable = `swng-projections-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

// --- core table: wipe every COURSE# item; strip dangling homeCourseId off golfer profiles ----
// Runs iff --wipe-courses (FLAGS above); --keep-courses makes it a no-op. The guard above has
// already proven exactly one of the two was passed, so the `if` below is a branch, not a default.
// `exclusiveStartKey` is declared out here because the three passes below reuse the same cursor.

let coursesDeleted = 0;
let golfersUpdated = 0;
let coreKept = 0;
let exclusiveStartKey;
if (keepCourses) {
  // Announced, never silent: a skipped destructive pass that logs nothing is indistinguishable
  // from one that ran and found nothing, and someone reading this transcript later has to be
  // able to tell which happened. The --wipe-courses arm announces itself symmetrically below.
  console.log(`${dryRun ? "[dry-run] " : ""}SKIPPED the ${coreTable} course pass (--keep-courses): no COURSE# item deleted, no homeCourseId stripped`);
} else {
  do {
    const page = await client.send(
      new ScanCommand({ TableName: coreTable, ProjectionExpression: "pk, sk, homeCourseId", ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of page.Items ?? []) {
      if (item.pk.startsWith("COURSE#")) {
        coursesDeleted += 1;
        if (!dryRun) await client.send(new DeleteCommand({ TableName: coreTable, Key: { pk: item.pk, sk: item.sk } }));
        continue;
      }
      if (item.pk.startsWith("GOLFER#") && item.sk === "GOLFER" && item.homeCourseId !== undefined) {
        golfersUpdated += 1;
        if (!dryRun) {
          await client.send(
            new UpdateCommand({ TableName: coreTable, Key: { pk: item.pk, sk: item.sk }, UpdateExpression: "REMOVE homeCourseId" }),
          );
        }
        continue;
      }
      coreKept += 1;
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  console.log(
    `${dryRun ? "[dry-run] " : ""}RAN the ${coreTable} course pass (--wipe-courses): ` +
      `${dryRun ? "would delete" : "deleted"} ${coursesDeleted} COURSE# item(s), ` +
      `${dryRun ? "would strip" : "stripped"} homeCourseId from ${golfersUpdated} golfer profile(s) ` +
      `(${coreKept} other core item(s) untouched)`,
  );
}

// --- rounds table: wipe every item — journals, META, OPID#, all of it -------------------------

let roundsDeleted = 0;
exclusiveStartKey = undefined;
do {
  const page = await client.send(
    new ScanCommand({ TableName: roundsTable, ProjectionExpression: "pk, sk", ExclusiveStartKey: exclusiveStartKey }),
  );
  for (const item of page.Items ?? []) {
    roundsDeleted += 1;
    if (!dryRun) await client.send(new DeleteCommand({ TableName: roundsTable, Key: { pk: item.pk, sk: item.sk } }));
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`${dryRun ? "[dry-run] would delete" : "deleted"} ${roundsDeleted} item(s) from ${roundsTable} (everything)`);

// --- snapshots table: wipe every item — pk-only key, no sk ------------------------------------

let snapshotsDeleted = 0;
exclusiveStartKey = undefined;
do {
  const page = await client.send(
    new ScanCommand({ TableName: snapshotsTable, ProjectionExpression: "pk", ExclusiveStartKey: exclusiveStartKey }),
  );
  for (const item of page.Items ?? []) {
    snapshotsDeleted += 1;
    if (!dryRun) await client.send(new DeleteCommand({ TableName: snapshotsTable, Key: { pk: item.pk } }));
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`${dryRun ? "[dry-run] would delete" : "deleted"} ${snapshotsDeleted} item(s) from ${snapshotsTable} (everything)`);

// --- projections table: wipe every item — ROUND# lines, LIVE# presence, dead rows -------------

let projectionsDeleted = 0;
exclusiveStartKey = undefined;
do {
  const page = await client.send(
    new ScanCommand({ TableName: projectionsTable, ProjectionExpression: "pk, sk", ExclusiveStartKey: exclusiveStartKey }),
  );
  for (const item of page.Items ?? []) {
    projectionsDeleted += 1;
    if (!dryRun) await client.send(new DeleteCommand({ TableName: projectionsTable, Key: { pk: item.pk, sk: item.sk } }));
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`${dryRun ? "[dry-run] would delete" : "deleted"} ${projectionsDeleted} item(s) from ${projectionsTable} (everything)`);
