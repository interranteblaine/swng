// The total parse gate for a stage's stored data (spec 2026-07-31 §6.6: "the gate is total, not a
// spot check"). READ-ONLY — it scans all four tables and reads nothing else; the only DynamoDB
// command it imports is ScanCommand, so there is no code path here that can write or delete.
//
// It runs BEFORE the migration, where it must FAIL on exactly the 15 known records, and again
// AFTER, where 100% must pass. A gate that has never been seen to fail is not a gate — it is a
// green light of unknown provenance.
//
// Every item lands in exactly one bucket and every bucket is printed, including the ones nothing
// parses (OPID# tombstones, round pointers, presence rows, the whole core table). A gate that
// quietly skips a category is how a green check ends up covering unexamined data, so the counts
// are reconciled against each table's raw item count and a mismatch is itself a failure.
//
// What reads what, at HEAD:
//
//   rounds      items carrying an `event`   -> roundEventSchema     (createDynamoEventJournal.read)
//   snapshots   the `archive` attribute     -> roundArchiveSchema   (createDynamoSnapshotStore)
//   projections items carrying a `line`     -> `typeof line.strokes === "number"`
//                                              (createDynamoProjectionStore.listLines CASTS rather
//                                               than parses, so a bad line is silently wrong at
//                                               HEAD rather than refused — which is exactly why
//                                               this gate checks the field by hand)
//   rounds      items with no `event`, and every core-table item: nothing reads them through a
//               schema. Counted and reported as NOT PARSED, never omitted.
//
// For the two shapes prod's migration touches, the RESOLVED VALUE is printed rather than a bare
// "ok" — a participant-joined reports the strokes it parsed to and a participant-strokes-set
// reports its number, and each snapshot prints its whole roster. A check that only says "parsed"
// cannot tell a faithful translation from a confidently wrong one; these numbers are meant to be
// read against the expected rosters by hand.
//
//   node scripts/checkProdParses.mjs [--stage prod]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
// ScanCommand and nothing else. Read-only is a property of what this file can call, not a promise
// in a comment.
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "prod";

// HEAD's own schemas, from the built dist — the same objects the lambda parses with. Loaded
// dynamically so a missing build produces an instruction instead of a module-resolution stack
// trace, and NEVER so that a missing build silently skips the checks that need them.
let contracts;
try {
  contracts = await import("../packages/contracts/dist/index.js");
} catch (error) {
  console.error("error: could not load HEAD's schemas from packages/contracts/dist — run `pnpm build` first.");
  console.error(String(error));
  process.exit(1);
}
const { roundEventSchema, roundArchiveSchema } = contracts;
if (roundEventSchema === undefined || roundArchiveSchema === undefined) {
  console.error("error: packages/contracts/dist loaded but exports no roundEventSchema/roundArchiveSchema — the build is stale. Run `pnpm build`.");
  process.exit(1);
}

const roundsTable = `swng-rounds-${stage}`;
const snapshotsTable = `swng-snapshots-${stage}`;
const projectionsTable = `swng-projections-${stage}`;
const coreTable = `swng-core-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

const scanAll = async (tableName) => {
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
};

// Same issue-flattening parseStored.ts uses, for the same reason: the PATH is what makes a
// stored-shape failure diagnosable ("participant.strokes: Invalid input"). Capped so one item
// cannot bury the summary.
const issuesOf = (error) => {
  const all = error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  return all.length > 5 ? [...all.slice(0, 5), `(+${all.length - 5} more)`] : all;
};

const failures = [];
const fail = (table, key, detail) => failures.push({ table, key, detail });

const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const tallyLines = (map) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `      ${n.toString().padStart(4)}  ${k}`);

const short = (id) => String(id).slice(0, 8);

console.log(`swng total parse gate — stage ${stage} — READ-ONLY (ScanCommand only)\n`);

// --- rounds table -----------------------------------------------------------------------------
// Items carrying an `event` are parsed with roundEventSchema. Everything else on this table
// (OPID# dedup tombstones, the META round pointer) is read by key alone and never through a
// schema — counted and named below rather than dropped from the accounting.

const roundsItems = await scanAll(roundsTable);
const eventKinds = new Map();
const unparsedRounds = new Map();
const seatLines = [];
const correctionLines = [];
let eventsOk = 0;
let eventsFailed = 0;

for (const item of roundsItems) {
  if (item.event === undefined) {
    const sk = String(item.sk ?? "");
    tally(unparsedRounds, sk.startsWith("OPID#") ? "OPID# dedup tombstone (no schema reads it)" : sk === "META" ? "META round pointer (read by key, not parsed)" : `other sk "${sk}" (no schema reads it)`);
    continue;
  }
  const key = `${item.pk} ${item.sk}`;
  const result = roundEventSchema.safeParse(item.event);
  if (!result.success) {
    eventsFailed += 1;
    fail(roundsTable, key, `kind=${String(item.event?.kind)} — ${issuesOf(result.error).join("; ")}`);
    continue;
  }
  eventsOk += 1;
  const event = result.data;
  tally(eventKinds, event.kind);
  // The two shapes this stage's migration touches: print the number, not "ok".
  if (event.kind === "participant-joined") {
    seatLines.push(`      round ${short(String(item.pk).replace("ROUND#", ""))}  ${String(item.sk)}  ${event.participant.name} strokes=${event.participant.strokes}`);
  }
  if (event.kind === "participant-strokes-set") {
    correctionLines.push(`      round ${short(String(item.pk).replace("ROUND#", ""))}  ${String(item.sk)}  golfer ${short(event.golferId)} strokes=${event.strokes}`);
  }
}

console.log(`${roundsTable} — ${roundsItems.length} item(s)`);
console.log(`  parsed with roundEventSchema: ${eventsOk + eventsFailed} item(s) carrying an \`event\` — ${eventsOk} ok, ${eventsFailed} FAILED`);
if (eventKinds.size > 0) console.log(`    by kind (parsed):\n${tallyLines(eventKinds).join("\n")}`);
if (seatLines.length > 0) console.log(`    participant-joined seats (resolved strokes):\n${seatLines.sort().join("\n")}`);
if (correctionLines.length > 0) console.log(`    participant-strokes-set corrections (resolved strokes):\n${correctionLines.sort().join("\n")}`);
console.log(`  NOT PARSED — nothing at HEAD reads these through a schema: ${roundsItems.length - eventsOk - eventsFailed} item(s)`);
if (unparsedRounds.size > 0) console.log(tallyLines(unparsedRounds).join("\n"));
console.log("");

// --- snapshots table --------------------------------------------------------------------------
// One immutable RoundArchive per finished round. Every parsed archive prints its whole roster,
// because that roster is the hand-checkable statement of what the migration was supposed to do.

const snapshotItems = await scanAll(snapshotsTable);
let archivesOk = 0;
let archivesFailed = 0;
const rosterLines = [];

for (const item of snapshotItems) {
  const key = String(item.pk);
  const result = roundArchiveSchema.safeParse(item.archive);
  if (!result.success) {
    archivesFailed += 1;
    fail(snapshotsTable, key, issuesOf(result.error).join("; "));
    continue;
  }
  archivesOk += 1;
  const archive = result.data;
  const roster = archive.participants.map((p) => `${p.name}=${p.strokes}`).join(", ");
  rosterLines.push(`      ${short(key)}  ${archive.card.courseName}  roster: ${roster}`);
}

console.log(`${snapshotsTable} — ${snapshotItems.length} item(s)`);
console.log(`  parsed with roundArchiveSchema: ${snapshotItems.length} archive(s) — ${archivesOk} ok, ${archivesFailed} FAILED`);
if (rosterLines.length > 0) console.log(`    rosters (resolved strokes):\n${rosterLines.sort().join("\n")}`);
console.log("");

// --- projections table ------------------------------------------------------------------------
// listLines CASTS `item.line` rather than parsing it, so a line whose `strokes` is missing is not
// refused at HEAD — it reads `undefined` and quietly poisons a golfer's stats. That is the whole
// reason this gate checks the field itself instead of trusting a parse that never happens.

const projectionItems = await scanAll(projectionsTable);
let linesOk = 0;
let linesFailed = 0;
const unparsedProjections = new Map();
const lineNotes = [];

for (const item of projectionItems) {
  if (item.line === undefined) {
    const sk = String(item.sk ?? "");
    tally(unparsedProjections, sk.startsWith("LIVE#") ? "LIVE# presence row (a register, not a projection)" : `other sk "${sk}"`);
    continue;
  }
  const key = `${item.pk} ${item.sk}`;
  if (typeof item.line.strokes !== "number") {
    linesFailed += 1;
    fail(projectionsTable, key, `line.strokes is ${typeof item.line.strokes} (${JSON.stringify(item.line.strokes)}), expected number`);
    continue;
  }
  linesOk += 1;
  // Informational, never a failure: spec §9.6 expects these retired keys to be gone once the
  // projector re-derives each line from the migrated snapshot. Reported so that is visible
  // rather than assumed.
  const retired = ["ags", "differential", "courseHandicap"].filter((k) => item.line[k] !== undefined);
  lineNotes.push(`      ${short(String(item.pk).replace("GOLFER#", ""))}  ${String(item.sk)}  strokes=${item.line.strokes}${retired.length > 0 ? `  [retired keys still present: ${retired.join(", ")}]` : ""}`);
}

console.log(`${projectionsTable} — ${projectionItems.length} item(s)`);
console.log(`  checked \`typeof line.strokes === "number"\`: ${linesOk + linesFailed} record line(s) — ${linesOk} ok, ${linesFailed} FAILED`);
if (lineNotes.length > 0) console.log(lineNotes.sort().join("\n"));
console.log(`  NOT PARSED — nothing at HEAD reads these through a schema: ${projectionItems.length - linesOk - linesFailed} item(s)`);
if (unparsedProjections.size > 0) console.log(tallyLines(unparsedProjections).join("\n"));
console.log("");

// --- core table -------------------------------------------------------------------------------
// Golfers, sub pointers, crews, seasons, course cards. Nothing here is read through a round
// schema and this arc does not touch any of it — but it is scanned and reported so "every item in
// every table" is a statement about every item in every table.

const coreItems = await scanAll(coreTable);
const coreKinds = new Map();
for (const item of coreItems) {
  const pk = String(item.pk ?? "");
  const sk = String(item.sk ?? "");
  const prefix = pk.split("#")[0];
  tally(coreKinds, `${prefix}# / sk ${sk.split("#")[0]}${sk.includes("#") ? "#…" : ""}`);
}
console.log(`${coreTable} — ${coreItems.length} item(s)`);
console.log(`  NOT PARSED — this arc reads none of it through a round schema and writes none of it:`);
console.log(tallyLines(coreKinds).join("\n"));
console.log("");

// --- verdict ----------------------------------------------------------------------------------
// The reconciliation is part of the gate: if the buckets above do not add up to what the scans
// actually returned, the summary is lying and that is a failure in its own right.

const accountedFor =
  roundsItems.length === eventsOk + eventsFailed + [...unparsedRounds.values()].reduce((a, b) => a + b, 0) &&
  projectionItems.length === linesOk + linesFailed + [...unparsedProjections.values()].reduce((a, b) => a + b, 0) &&
  snapshotItems.length === archivesOk + archivesFailed &&
  coreItems.length === [...coreKinds.values()].reduce((a, b) => a + b, 0);

const totalItems = roundsItems.length + snapshotItems.length + projectionItems.length + coreItems.length;
const totalChecked = eventsOk + eventsFailed + archivesOk + archivesFailed + linesOk + linesFailed;

console.log(`SUMMARY — ${totalItems} item(s) scanned across 4 table(s); ${totalChecked} checked against HEAD, ${totalItems - totalChecked} carry no schema at HEAD (named above)`);

if (!accountedFor) {
  console.error("\nFAIL: the per-category counts do not reconcile with the raw scan counts — some item was neither checked nor named.");
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} item(s) cannot be read by HEAD:\n`);
  for (const f of failures.sort((a, b) => (`${a.table} ${a.key}` < `${b.table} ${b.key}` ? -1 : 1))) {
    console.error(`  ${f.table}  ${f.key}\n      ${f.detail}`);
  }
  process.exit(1);
}

console.log(`\nPASS — every item in every ${stage} table is readable by HEAD.`);
