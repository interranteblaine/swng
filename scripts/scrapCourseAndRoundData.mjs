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
//   node scripts/scrapCourseAndRoundData.mjs [--stage beta] [--dry-run]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const dryRun = process.argv.includes("--dry-run");

const coreTable = `swng-core-${stage}`;
const roundsTable = `swng-rounds-${stage}`;
const snapshotsTable = `swng-snapshots-${stage}`;
const projectionsTable = `swng-projections-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

// --- core table: wipe every COURSE# item; strip dangling homeCourseId off golfer profiles ----

let coursesDeleted = 0;
let golfersUpdated = 0;
let coreKept = 0;
let exclusiveStartKey;
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
