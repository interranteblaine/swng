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
//   --stage <name>    which stage's four tables to operate on (default `beta`).
//   --dry-run         count and report, delete nothing. Composes with every other flag.
//   --keep-courses    make the CORE-TABLE PASS ABOVE A NO-OP: no `COURSE#` item is deleted and
//                     no golfer's `homeCourseId` is stripped. The rounds/snapshots/projections
//                     passes still run in full. Named for the OUTCOME rather than the pass,
//                     because at a terminal under pressure "keep courses" has exactly one
//                     reading. The pass logs that it was skipped — silence is how someone later
//                     concludes it ran.
//
//                     Use it whenever an arc replaces the ROUND model and leaves the course
//                     model alone: the hand-seeded real cards (Casa Verde GC, Sandy Hollow
//                     Nine) are the field-test fixtures, and the field e2e specs RE-SEED
//                     courses, so losing them is silent and permanent — no gate catches it.
//                     The relative-to-par strokes arc (spec 2026-07-29 §8) is the first
//                     close-out that requires this flag.
//
//   node scripts/scrapCourseAndRoundData.mjs [--stage beta] [--dry-run] [--keep-courses]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const dryRun = process.argv.includes("--dry-run");
// Opt out of the course pass only — see the FLAGS block above for why this exists.
const keepCourses = process.argv.includes("--keep-courses");

const coreTable = `swng-core-${stage}`;
const roundsTable = `swng-rounds-${stage}`;
const snapshotsTable = `swng-snapshots-${stage}`;
const projectionsTable = `swng-projections-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

// --- core table: wipe every COURSE# item; strip dangling homeCourseId off golfer profiles ----
// Skippable whole via --keep-courses (FLAGS above). `exclusiveStartKey` is declared out here
// because the three passes below reuse the same cursor variable.

let coursesDeleted = 0;
let golfersUpdated = 0;
let coreKept = 0;
let exclusiveStartKey;
if (keepCourses) {
  // Announced, never silent: a skipped destructive pass that logs nothing is indistinguishable
  // from one that ran and found nothing, and someone reading this transcript later has to be
  // able to tell which happened.
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
    `${dryRun ? "[dry-run] would delete" : "deleted"} ${coursesDeleted} COURSE# item(s) and ` +
      `${dryRun ? "would strip" : "stripped"} homeCourseId from ${golfersUpdated} golfer profile(s) on ${coreTable} ` +
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
