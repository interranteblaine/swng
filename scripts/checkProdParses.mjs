// The total parse gate for a stage's stored data (spec 2026-07-31 §6.6: "the gate is total, not a
// spot check"). READ-ONLY — the only DynamoDB command it imports is ScanCommand, so there is no
// code path here that can write or delete.
//
// WHAT IT GATES NOW. Written for the 2026-07-31 strokes migration, where it ran before (failing on
// exactly the 15 known records) and after (100% passing). That arc is done; the header used to
// describe only it, and this file has since become load-bearing for a second, ONGOING job — so it
// says both, because a header describing a finished job is how an instrument gets read as
// decorative.
//
//   * ANY stored-shape migration, as its before/after gate. The principle is the same one that
//     made it worth building: a gate that has never been seen to FAIL is not a gate, it is a green
//     light of unknown provenance. Run it before, watch it name the records the migration is for;
//     run it after, and require 100%.
//   * THE PRECONDITION FOR DEPLOYING A BUILD THAT REQUIRES A NEW FIELD (round played-at arc, spec
//     2026-08-01 §8). A migration script reporting "0 pending" is a SELF-REPORT: it says the
//     transform found nothing left to change, which is also what it says if it looked in the wrong
//     place. This script is the independent check — it parses every item of four tables with HEAD's
//     own schemas and knows nothing about any transform. "0 pending" plus a clean run here is the
//     precondition; "0 pending" alone is not.
//
// It is deliberately not stage-specific despite its name: `--stage` selects, and beta is as much in
// scope as prod. The name is kept because it is the name every runbook and sibling script already
// points at, and a rename that leaves stale references behind is worse than a name that undersells.
//
// SCOPE — four of the stage's five tables. `swng-rounds-<stage>`, `swng-snapshots-<stage>`,
// `swng-projections-<stage>` and `swng-core-<stage>` are scanned in full (the table names are
// spelled out rather than abbreviated because a comment naming a resource that does not exist is
// the kind of thing someone trusts at 2am). `swng-connections-<stage>` is DELIBERATELY OUT OF SCOPE: it holds
// ephemeral WebSocket connection registrations that no schema reads, that no round or record is
// derived from, and that spec §6.1 leaves out of the export for the same reason. It is named here
// and in the summary rather than left to be inferred, because an unnamed skipped table would be a
// stronger version of the exact "a gate that quietly skips a category" failure this file exists to
// refuse. Every verdict this script prints says four tables, never "every table".
//
// Within those four, every item lands in exactly one bucket and every bucket is printed, including
// the ones nothing parses (OPID# tombstones, round pointers, presence rows, the whole core table).
//
// What reads what, at HEAD:
//
//   rounds      items carrying an `event`   -> roundEventSchema     (createDynamoEventJournal.read)
//   snapshots   the `archive` attribute     -> roundArchiveSchema   (createDynamoSnapshotStore)
//   projections items carrying a `line`     -> every field a STORED LINE must carry — GolferRoundLine's
//                                              required members PLUS `playedAtMs`, which the
//                                              ProjectionStore PORT requires and that type does not
//                                              declare — checked by hand.
//                                              createDynamoProjectionStore.listLines CASTS
//                                              `item.line` rather than parsing it, so a malformed
//                                              line is silently wrong at HEAD rather than refused —
//                                              this gate is the only thing standing between such a
//                                              line and a wrong stat, so it checks the whole
//                                              required set, not just the field an arc renames.
//   rounds      items with no `event`, and every core-table item: nothing reads them through a
//               schema. Counted and reported as NOT PARSED, never omitted.
//
// For the two shapes the strokes migration touched, the RESOLVED VALUE is printed rather than a
// bare "ok" — a participant-joined reports the strokes it parsed to and a participant-strokes-set
// reports its number, and each snapshot prints its whole roster. A check that only says "parsed"
// cannot tell a faithful translation from a confidently wrong one; these numbers are meant to be
// read against the expected rosters by hand.
//
// `--stage` DEFAULTS TO PROD, unlike the played-at migration's own required flag. That asymmetry is
// deliberate and it is safe in exactly one direction: this script only ever READS, so the worst a
// forgotten `--stage beta` costs is a report about the wrong stage — whereas a defaulted stage on
// something that WRITES is a table you can hit by forgetting to type one. Say `--stage beta` when
// you mean beta; the summary names the stage it read, so a mistake is visible in the output.
//
//   node scripts/checkProdParses.mjs [--stage prod|beta]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
// ScanCommand and nothing else. Read-only is a property of what this file can call, not a promise
// in a comment.
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

// A flag's VALUE is guarded, not just its presence: `--stage` with nothing after it yields
// `undefined` and would build table names like `swng-rounds-undefined`, and `--stage --write`
// would take the next flag as a stage name. Both fail eventually as a nonexistent-table error
// several seconds later, which is a worse way to learn you typed it wrong.
const flagValue = (name) => {
  if (!process.argv.includes(name)) return undefined;
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`error: ${name} needs a value (e.g. \`${name} prod\`).`);
    process.exit(1);
  }
  return value;
};

const stage = flagValue("--stage") ?? "prod";

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
// listLines CASTS `item.line` rather than parsing it, so a malformed line is not refused at HEAD —
// it is read as though it were fine and quietly poisons a golfer's stats. This gate is therefore
// the ONLY thing standing between a bad line and a wrong number on someone's profile, which is why
// it checks every field GolferRoundLine requires rather than only the one this arc renames.

// EVERY FIELD A STORED LINE MUST CARRY — which is not the same set as GolferRoundLine's required
// members, and the difference is where the gap was. Most of these are GolferRoundLine
// (packages/domain/src/golfer/record.ts); `playedAtMs` is not a member of that type at all. It is
// required by the PORT (packages/application/src/ports/projectionStore.ts — `listLines` returns
// `GolferRoundLine & { playedAtMs: number }`), which makes it exactly as required of a stored item
// and exactly as uncheckable at HEAD: `createDynamoProjectionStore.listLines` CASTS. Only
// `rebuildProjections` stamps it onto lines written before it existed, and nothing else proves that
// step ran — which is why it is in this list. The consequence is asymmetric and the silent half is
// the reason to check: `playedAt` is REQUIRED on getMyRecordResponseSchema and
// getGolferResponseSchema, so a line missing it makes the profile and golfer pages THROW (loud, a
// browser walk finds it), while getSeasonStandings reads `line.playedAtMs` to place a round in a
// season window, so a crew board just DROPS the round (silent, nothing finds it).
//
// `courseId`, `score` and `holeResults` are legitimately optional, so their absence must never be a failure —
// but `score`'s absence has TWO live causes and this gate cannot tell them apart from the item
// alone: either the round has a hole with no number (a pickup, so there is no gross to record), or
// the line was written before the field existed. Both are true of this stage right now — prod's 8
// pre-migration lines carry the retired `ags` and no `score` at all — which is why the summary
// below states both rather than asserting one. It is counted and reported because spec §9.5 reads
// history rows, and a line with no `score` renders none.
const REQUIRED_LINE_FIELDS = [
  ["roundId", (v) => typeof v === "string" && v !== ""],
  ["courseName", (v) => typeof v === "string" && v !== ""],
  ["tee", (v) => typeof v === "string" && v !== ""],
  ["holes", (v) => v === 9 || v === 18],
  ["par", (v) => typeof v === "number"],
  ["strokes", (v) => typeof v === "number"],
  ["playedAtMs", (v) => typeof v === "number"],
  ["distribution", (v) => v !== null && typeof v === "object" && ["eagles", "birdies", "pars", "bogeys", "doublePlus"].every((k) => typeof v[k] === "number")],
];

// Retired by the strokes arcs. Spec §9.6 requires them GONE once the projector re-derives each
// line from its migrated snapshot — putLine writes the whole item, so a re-derived line cannot
// keep them. A survivor therefore means the line was NOT re-derived, which is a real failure of
// the migration's central claim, so it is one here rather than a note inside an otherwise-green
// run. Informational output in a PASS is not a check; a run that passes has to have proven this.
const RETIRED_LINE_FIELDS = ["ags", "differential", "courseHandicap"];

const projectionItems = await scanAll(projectionsTable);
let linesOk = 0;
let linesFailed = 0;
let linesWithScore = 0;
let linesWithRetired = 0;
const unparsedProjections = new Map();
const lineNotes = [];

for (const item of projectionItems) {
  if (item.line === undefined) {
    const sk = String(item.sk ?? "");
    tally(unparsedProjections, sk.startsWith("LIVE#") ? "LIVE# presence row (a register, not a projection)" : `other sk "${sk}"`);
    continue;
  }
  const key = `${item.pk} ${item.sk}`;
  const line = item.line;
  const problems = REQUIRED_LINE_FIELDS.filter(([field, ok]) => !ok(line[field])).map(([field]) => `line.${field} is ${JSON.stringify(line[field])}`);
  const retired = RETIRED_LINE_FIELDS.filter((field) => line[field] !== undefined);
  if (retired.length > 0) {
    linesWithRetired += 1;
    problems.push(`line still carries retired key(s) ${retired.join(", ")} — the projector did not re-derive this line`);
  }
  if (problems.length > 0) {
    linesFailed += 1;
    fail(projectionsTable, key, problems.join("; "));
    continue;
  }
  linesOk += 1;
  if (typeof line.score === "number") linesWithScore += 1;
  lineNotes.push(`      ${short(String(item.pk).replace("GOLFER#", ""))}  ${String(item.sk)}  strokes=${line.strokes}  par=${line.par}  ${typeof line.score === "number" ? `score=${line.score}` : "score absent (a hole with no number, or a line older than the field)"}`);
}

const lineCount = linesOk + linesFailed;
console.log(`${projectionsTable} — ${projectionItems.length} item(s)`);
console.log(`  checked every field GolferRoundLine requires: ${lineCount} record line(s) — ${linesOk} ok, ${linesFailed} FAILED`);
console.log(`  retired keys (${RETIRED_LINE_FIELDS.join("/")}) — spec §9.6: ${linesWithRetired === 0 ? "none present on any line" : `${linesWithRetired} line(s) STILL CARRY THEM (counted in the failures above)`}`);
console.log(`  \`score\` present on ${linesWithScore} of ${lineCount} line(s) — optional by design; absent means either the round has a hole with no number, or the line predates the field. Either way that history row renders no gross`);
if (lineNotes.length > 0) console.log(lineNotes.sort().join("\n"));
console.log(`  NOT PARSED — nothing at HEAD reads these through a schema: ${projectionItems.length - lineCount} item(s)`);
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
// The reconciliation below is honest about what it is: every loop above tallies in every branch,
// so this cannot be false without an edit to a loop body. That edit — a `continue` added without
// a matching tally — is exactly the realistic regression, so the check is worth keeping; it just
// guards against that one future mistake rather than standing as a live guard against a summary
// that lies today.

const accountedFor =
  roundsItems.length === eventsOk + eventsFailed + [...unparsedRounds.values()].reduce((a, b) => a + b, 0) &&
  projectionItems.length === linesOk + linesFailed + [...unparsedProjections.values()].reduce((a, b) => a + b, 0) &&
  snapshotItems.length === archivesOk + archivesFailed &&
  coreItems.length === [...coreKinds.values()].reduce((a, b) => a + b, 0);

const totalItems = roundsItems.length + snapshotItems.length + projectionItems.length + coreItems.length;
const totalChecked = eventsOk + eventsFailed + archivesOk + archivesFailed + linesOk + linesFailed;

console.log(`SUMMARY — ${totalItems} item(s) scanned across the 4 in-scope table(s); ${totalChecked} checked against HEAD, ${totalItems - totalChecked} carry no schema at HEAD (named above)`);
console.log(`          OUT OF SCOPE, deliberately: swng-connections-${stage} — ephemeral WebSocket registrations, no schema reads them, no round or record derives from them (spec §6.1 leaves them out of the export for the same reason)`);

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

// The claim is exactly as wide as the scan: four tables, named. This line gets cited as the
// evidence for done-means §9.4, so it must not say "every table" while a fifth sits unscanned.
console.log(`\nPASS — every item in all 4 in-scope ${stage} tables is readable by HEAD, and no record line carries a retired key.`);
