// The prod strokes migration (spec 2026-07-31 §4). This script WRITES TO A PRODUCTION TABLE.
//
// It is a DRY RUN unless `--write` is passed. It NEVER DELETES ANYTHING — there is no
// DeleteCommand, no BatchWrite, no removal path anywhere in this file, and there is no flag that
// creates one. PROD IS NEVER WIPED. The only writes it can perform are:
//
//   * the records of spec §4's write set — rounds-table events and snapshot archives whose stored
//     shape predates the strokes rename — each put back as the WHOLE item it was read as, with
//     only its `event` / `archive` attribute replaced. Never a reconstructed item: a snapshot
//     carries `finalizedAt` and whatever else it carries, and rebuilding an item from the fields
//     you happened to think of is how an attribute disappears silently.
//   * `--restore <file>` — putting back the original images of exactly those records.
//
// THE RENAME RULES ARE NOT RESTATED HERE. They live in `scripts/prodStrokesMigration.mjs`, which
// is where to read them; a prose copy in this header would be a second statement that drifts from
// the module that owns it exactly the way a second code copy would. What matters at this level is
// that every rule is guarded on the old shape being present, so the migration is idempotent — a
// re-run is a no-op and an interrupted run is just a shorter next run — and that the instrument
// which WRITES prod and the instrument which CHECKS it (checkProdParses.mjs) share that one module
// precisely so they cannot drift.
//
// ORDERING — WHY `--write` REQUIRES `--after-deploy`
//
// Spec §5: deploy the lambda FIRST, then migrate, then publish the web. Running this migration
// before `deploy:prod` is the dangerous order, and it is dangerous in a way that hides:
//
//   1. The launch-build projector consumes the snapshot writes and stamps the OLD shape back onto
//      the 8 record lines. It casts rather than parses at that build, so it does not refuse them.
//   2. After the deploy, re-running this script CANNOT REPAIR THAT. The transform is idempotent,
//      so `changed()` is false for every record, nothing is written, no snapshot write occurs, and
//      the stream never fires again. The script prints "already carries the current shape" — which
//      is indistinguishable from "migrated fine, the projector is catching up", the exact state a
//      runbook tells an operator to wait through.
//
// A wrong order that reports as success is the worst shape this instrument could have, so the
// ordering is something you must ASSERT rather than something you must remember: `--write` is
// refused without `--after-deploy`. This is the same ruling the repo already made for
// scrapCourseAndRoundData's course choice — make illegal states unrepresentable rather than
// documenting the hazard, because prose stops nothing and an exit code does.
//
// IF IT WAS RUN IN THE WRONG ORDER ANYWAY: do not build a second instrument and do not expect a
// re-run to help. `rebuildProjections` — the RebuildFunction lambda on the `swng-<stage>` stack,
// manual invoke, `{cursor?, maxSnapshots?}` in — re-projects every snapshot through the same
// `projectArchive` a finalize uses. That IS the re-drive, it already exists, and this script says
// so on every run that could be mistaken for the bad state.
//
// Safety, in the order it happens:
//
//   1. In `--write` mode, every item of all four tables is exported to
//      `prod-backup-<stage>-<timestamp>.json` BEFORE any write, together with the enumerated keys
//      this run intends to change. If the export fails for any reason the run exits before
//      writing. The export is taken from the very same scan the migration is computed from, so the
//      `before` images on disk are exactly the images being transformed.
//      A dry run does NOT write an export — it says so — because the protection that matters is
//      an export taken in the same invocation as the write, not a stale one from an earlier run.
//   2. Every transformed record is PARSED with HEAD's own schema before a single Put is issued.
//      A record that would not parse is never written and stops the run. That makes it
//      structurally impossible for this script to write a record the app cannot read.
//   3. The number of records to write is ASSERTED against `--expect` (default 15, spec §4's
//      enumerated write set). A different number means production moved since that inventory, so
//      `--write` refuses and the operator re-inventories rather than writing a set nobody counted.
//   4. Events are written first and snapshots last. The snapshots table has a stream and the
//      projector is its consumer, so a snapshot write re-derives that round's record lines; it
//      goes last, once everything it folds is already consistent.
//   5. If the parse gate or the count guard rejects in `--write` mode, the export has already been
//      taken and nothing else has happened. An export file with no migration is the expected
//      residue of that path, not a sign something half-ran.
//
// `--restore <file>` puts back the ORIGINAL images of exactly the records the migration changed —
// the keys it recorded in the export — and nothing else. Two limits, both real, stated because
// each is a different way a restore can disappoint:
//   * it does not DELETE items created since the export; and
//   * it does not REVERT the ~335 items the migration never touched. Restoring all four tables
//     verbatim would do that, and an hour after the migration it would silently roll back every
//     round, golfer and course created since — data loss dressed as safety. The full four-table
//     dump stays in the file as the forensic artifact; the restore is scoped to the 15.
// A RESTORE ONLY MAKES SENSE PAIRED WITH ROLLING THE LAMBDAS BACK to the pre-arc build. Putting
// the 3 old-shape snapshots back while HEAD is deployed writes archives HEAD cannot parse: each
// one poisons the snapshots stream (bisect, retry, DLQ) and — because the rebuild pages by
// parsing eagerly — it also BRICKS `rebuildProjections`, which is the very instrument the rest of
// this file points at for repair. Restoring the data without restoring the code leaves you with
// neither a working read path nor a working re-drive.
//
// The projections and core tables are READ (for the export) and never written. The 8 record lines
// are not migrated — they are regenerated by the projector off the snapshot writes (spec §4).
//
//   node scripts/migrateProdStrokes.mjs [--stage prod]                       # dry run
//   node scripts/migrateProdStrokes.mjs [--stage prod] --write --after-deploy [--expect 15]
//   node scripts/migrateProdStrokes.mjs [--stage prod] --restore <file> [--write]
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
// `migrateEvent` / `migrateArchive` are the only two entry points a stored item can need — the
// seat rule is applied INSIDE them — so `seat` itself is deliberately not imported here. Every
// rename this script performs comes out of that module and none of it is restated in this file.
import { migrateEvent, migrateArchive, changed } from "./prodStrokesMigration.mjs";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
// ScanCommand to read, PutCommand to write. Nothing that deletes is imported, so nothing that
// deletes can be called.
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const argv = process.argv;

// A flag's VALUE is guarded, not just its presence: `--stage` with nothing after it yields
// `undefined` and would build table names like `swng-rounds-undefined`, and `--stage --write` would
// silently take the next flag as a stage name. Both would fail as a nonexistent-table error several
// seconds later, which is a worse way to learn you typed it wrong.
const flagValue = (name, hint) => {
  if (!argv.includes(name)) return undefined;
  const value = argv[argv.indexOf(name) + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`error: ${name} needs a value — ${hint}`);
    process.exit(1);
  }
  return value;
};

const stage = flagValue("--stage", "e.g. `--stage prod`.") ?? "prod";
const write = argv.includes("--write");
const afterDeploy = argv.includes("--after-deploy");
const restoreFile = flagValue("--restore", "the path of an export file written by an earlier --write run.");

// Spec §4 enumerates the write set: 15 records. Overridable because a RESUMED run after a partial
// failure legitimately has fewer left, and the failure message below names the number to pass.
const EXPECTED_RECORDS = 15;
const expectRaw = flagValue("--expect", "the number of records this run should find, e.g. `--expect 15`.");
const expected = expectRaw === undefined ? EXPECTED_RECORDS : Number(expectRaw);
if (!Number.isInteger(expected) || expected < 0) {
  console.error(`error: --expect needs a non-negative whole number (got ${JSON.stringify(expectRaw)}).`);
  process.exit(1);
}

// THE ORDERING GUARD (see the header). Scoped to a MIGRATION write: `--restore --write` is the
// break-glass rollback and must not be gated behind an acknowledgement about deploy order, which
// has nothing to do with putting original images back.
if (write && restoreFile === undefined && !afterDeploy) {
  console.error(
    "error: pass --after-deploy to confirm `deploy:prod` has already landed (spec §5 — lambda first, then migrate).\n" +
      "       Migrating BEFORE the deploy lets the old projector stamp the old shape back onto the record lines, and a\n" +
      "       re-run afterwards CANNOT repair it — the transform is idempotent, so nothing is written, the snapshot\n" +
      "       stream never re-fires, and this script reports success. Nothing has been read or written.",
  );
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

// A generic leaf-path diff of the before and after images — deliberately NOT a hand-written
// description of what the rename does. It reports what actually changed between two values, so it
// stays honest if the transform ever changes and it cannot become a second, drifting statement of
// the rules.
const leaves = (value, prefix, out) => {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) leaves(v, prefix === "" ? k : `${prefix}.${k}`, out);
    return out;
  }
  out.set(prefix, value);
  return out;
};

const describeChange = (before, after) => {
  const a = leaves(before, "", new Map());
  const b = leaves(after, "", new Map());
  const lines = [];
  for (const [path, value] of a) {
    if (!b.has(path)) lines.push(`- ${path} = ${JSON.stringify(value)}`);
    else if (JSON.stringify(b.get(path)) !== JSON.stringify(value)) lines.push(`~ ${path}: ${JSON.stringify(value)} -> ${JSON.stringify(b.get(path))}`);
  }
  for (const [path, value] of b) if (!a.has(path)) lines.push(`+ ${path} = ${JSON.stringify(value)}`);
  return lines;
};

console.log(`swng prod strokes migration — stage ${stage} — ${write ? "*** WRITE MODE ***" : "DRY RUN"}${restoreFile !== undefined ? ` — RESTORE from ${restoreFile}` : ""}`);
console.log("this script never deletes anything; prod is never wiped\n");

// --- restore ----------------------------------------------------------------------------------
// SCOPED to the records the migration actually changed — the keys it recorded in the export —
// each put back as the verbatim original image.
//
// It is deliberately NOT a four-table rollback. The export holds all ~350 items because that is
// the forensic artifact, but ~335 of them were never touched by this arc: golfer profiles, course
// pointers, crew rows. Restoring those verbatim an hour after the migration would silently revert
// every round, golfer and course created in between — data loss dressed as safety. Undoing this
// migration means undoing the things this migration did.
//
// It does not DELETE items created since the export either; a restore puts back what it holds, it
// does not reset a table to a moment in time.
//
// This branch sits ABOVE the schema load on purpose: a restore parses nothing, and the break-glass
// path must not be gated behind a working `pnpm build` of a package it never touches.

if (restoreFile !== undefined) {
  let backup;
  try {
    backup = JSON.parse(readFileSync(restoreFile, "utf8"));
  } catch (error) {
    console.error(`error: could not read the export file ${restoreFile}: ${String(error)}`);
    process.exit(1);
  }
  if (backup?.tables === undefined) {
    console.error(`error: ${restoreFile} is not an export written by this script (no \`tables\` key).`);
    process.exit(1);
  }
  console.log(`export taken ${backup.takenAt} from stage ${backup.stage}`);
  if (backup.stage !== stage) {
    console.error(`error: the export was taken from stage "${backup.stage}" but --stage says "${stage}". Refusing to write one stage's data into another.`);
    process.exit(1);
  }
  if (!Array.isArray(backup.migrated)) {
    console.error(`error: ${restoreFile} records no \`migrated\` key list, so there is no way to know which records this export's run changed.`);
    console.error(`       Refusing to guess — restoring every item in the file would revert 300+ records this arc never touched.`);
    process.exit(1);
  }

  const held = Object.values(backup.tables).reduce((n, items) => n + items.length, 0);
  console.log(`the export holds ${held} item(s) across ${Object.keys(backup.tables).length} table(s) as the forensic record; ${backup.migrated.length} of them were changed by that run and are what a restore puts back\n`);

  if (backup.migrated.length === 0) {
    console.log("That run changed nothing, so there is nothing to restore.");
    process.exit(0);
  }

  // Resolve every key to its original image BEFORE writing anything: a key with no matching item
  // means the export is internally inconsistent, and a half-completed restore is a worse place to
  // discover that.
  const originals = [];
  for (const entry of backup.migrated) {
    const items = backup.tables[entry.table] ?? [];
    const original = items.find((item) => String(item.pk) === entry.pk && (item.sk ?? null) === (entry.sk ?? null));
    if (original === undefined) {
      console.error(`error: the export records a changed key that is not in its own dump — ${entry.table} ${entry.pk} ${entry.sk ?? ""}. Nothing was written.`);
      process.exit(1);
    }
    originals.push({ table: entry.table, key: `${entry.pk}${entry.sk === undefined ? "" : ` ${entry.sk}`}`, item: original });
  }

  let restored = 0;
  for (const { table, key, item } of originals) {
    console.log(`  ${write ? "restoring" : "would restore"} ${table}  ${key}`);
    if (!write) continue;
    await client.send(new PutCommand({ TableName: table, Item: item }));
    restored += 1;
  }
  if (!write) {
    console.log("\nDRY RUN — nothing written. Re-run with --write to restore.");
    process.exit(0);
  }
  console.log(`\nrestored ${restored} original image(s). The other ${held - originals.length} item(s) in the export were untouched by the migration and are untouched by this restore.`);
  console.log(`\nROLL THE LAMBDAS BACK TOO, if you have not already. These are pre-arc archives: the deployed`);
  console.log(`HEAD build cannot parse them, so each snapshot you just restored poisons the snapshots stream`);
  console.log(`(bisect, retry, DLQ) and bricks rebuildProjections, which pages by parsing eagerly. Restoring the`);
  console.log(`data without restoring the code leaves neither a working read path nor a working re-drive.`);
  console.log(`Once the pre-arc lambdas are back, the record lines are whatever the projector last derived, and`);
  console.log(`rebuildProjections (the RebuildFunction lambda on swng-${stage}) re-projects every snapshot if they need repair.`);
  process.exit(0);
}

// --- HEAD's schemas ---------------------------------------------------------------------------
// Below the restore branch (which needs none of this) and above every scan, so a `--write` run
// with a missing build exits before reading or exporting anything.

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

// --- read -------------------------------------------------------------------------------------

const roundsItems = await scanAll(roundsTable);
const snapshotItems = await scanAll(snapshotsTable);
console.log(`read ${roundsItems.length} item(s) from ${roundsTable} and ${snapshotItems.length} item(s) from ${snapshotsTable}\n`);

// --- transform and classify ---------------------------------------------------------------------
// Every candidate lands in one of three buckets, and all three are reported. "Nothing to do" is
// not one state but three, and they mean completely different things:
//
//   pending    the transform changes it — this is the write set
//   current    the transform leaves it alone AND it parses at HEAD — already in the right shape
//   unreadable the transform leaves it alone and it does NOT parse at HEAD — this migration
//              cannot fix it, and saying "nothing to do" over such a record would be a lie
//
// Distinguishing them is what stops "0 records" from reading identically whether the migration is
// complete, the stage is empty, or something is wrong that this instrument cannot repair.

const records = [];
const problems = [];
let currentCount = 0;
const unreadable = [];

const classify = (table, key, before, after, buildItem, schema, order, kind) => {
  if (changed(before, after)) {
    records.push({ table, key, kind, before, after, item: buildItem(), schema, order });
    return;
  }
  if (schema.safeParse(before).success) currentCount += 1;
  else unreadable.push(`${table}  ${key}`);
};

for (const item of roundsItems) {
  if (item.event === undefined) continue;
  let after;
  try {
    after = migrateEvent(item.event);
  } catch (error) {
    problems.push({ key: `${roundsTable}  ${item.pk} ${item.sk}`, detail: `the transform threw: ${String(error)}` });
    continue;
  }
  // events first — `order` drives both the write order and the order recorded in the export
  classify(roundsTable, `${item.pk} ${item.sk}`, item.event, after, () => ({ ...item, event: after }), roundEventSchema, 0, `${item.event.kind} -> ${after.kind}`);
}

for (const item of snapshotItems) {
  let after;
  try {
    after = migrateArchive(item.archive);
  } catch (error) {
    problems.push({ key: `${snapshotsTable}  ${item.pk}`, detail: `the transform threw: ${String(error)}` });
    continue;
  }
  // snapshots last — the stream fires off these
  classify(snapshotsTable, String(item.pk), item.archive, after, () => ({ ...item, archive: after }), roundArchiveSchema, 1, "archive");
}

const candidates = records.length + currentCount + unreadable.length + problems.length;
records.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));

console.log(`${candidates} candidate record(s) examined — ${records.length} pending · ${currentCount} already current · ${unreadable.length} unreadable by this migration\n`);

// --- export (write mode only, before anything is written) ---------------------------------------
// The full four-table dump is the forensic artifact; `migrated` is the enumerated key list a
// `--restore` puts back. Both land in one file, written before any table is touched.

if (write) {
  const projectionItems = await scanAll(projectionsTable);
  const coreItems = await scanAll(coreTable);
  const path = `prod-backup-${stage}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const tables = {
    [roundsTable]: roundsItems,
    [snapshotsTable]: snapshotItems,
    [projectionsTable]: projectionItems,
    [coreTable]: coreItems,
  };
  const total = Object.values(tables).reduce((n, items) => n + items.length, 0);
  // Key attributes only: the rounds table is pk+sk, the snapshots table is pk-only. Restore
  // resolves each of these back to its original image inside `tables`.
  const migrated = records.map((record) => {
    const [pk, sk] = record.key.split(" ");
    return sk === undefined ? { table: record.table, pk } : { table: record.table, pk, sk };
  });
  try {
    writeFileSync(path, JSON.stringify({ stage, takenAt: new Date().toISOString(), migrated, tables }, undefined, 1));
  } catch (error) {
    console.error(`error: the export failed, so nothing will be written: ${String(error)}`);
    process.exit(1);
  }
  console.log(`EXPORT: ${total} item(s) from all 4 tables -> ${path}`);
  for (const [tableName, items] of Object.entries(tables)) console.log(`         ${items.length.toString().padStart(4)}  ${tableName}`);
  console.log(`        recorded ${migrated.length} key(s) as this run's write set — a --restore of this file puts back those and nothing else`);
  console.log("");
} else {
  // Announced, never silent. A skipped step that logs nothing is indistinguishable from one that
  // ran, and the person reading this transcript later has to be able to tell which happened.
  console.log(`SKIPPED the export (dry run): nothing is being written, and an export is only protection if it is taken in the same run as the write.\n`);
}

// --- the parse gate, before any write -----------------------------------------------------------

for (const record of records) {
  const result = record.schema.safeParse(record.after);
  if (result.success) continue;
  const issues = result.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  problems.push({ key: `${record.table}  ${record.key}`, detail: `the transformed record does not parse at HEAD — ${issues.join("; ")}` });
}

if (problems.length > 0) {
  console.error(`REFUSING TO WRITE — ${problems.length} record(s) could not be transformed into something HEAD can read:\n`);
  for (const problem of problems) console.error(`  ${problem.key}\n      ${problem.detail}`);
  console.error("\nNothing was written.");
  process.exit(1);
}

// --- what "nothing to do" actually means --------------------------------------------------------

// A record this transform does not change AND that HEAD cannot read is not something to be quiet
// about: it is outside this migration's reach and needs a person.
if (unreadable.length > 0) {
  console.error(`STOP — ${unreadable.length} record(s) neither need this transform nor parse at HEAD. This migration cannot fix them:\n`);
  for (const key of unreadable) console.error(`  ${key}`);
  console.error("\nNothing was written.");
  process.exit(1);
}

if (candidates === 0) {
  console.log(`No records found at all in ${roundsTable} / ${snapshotsTable}. That is an empty stage, not a completed migration — check --stage and the AWS profile.`);
  process.exit(0);
}

if (records.length === 0) {
  console.log(`Nothing to do — all ${currentCount} record(s) already carry the current shape. The transform is idempotent, so this is what a completed migration looks like on a second run.`);
  console.log("Nothing was written.\n");
  // The one state this message cannot distinguish itself from — and the reason it says so out loud.
  console.log("NOTE: this is ALSO what a migration run BEFORE `deploy:prod` looks like afterwards. If the record lines are");
  console.log("      still wrong, a re-run cannot fix them — no snapshot is written here, so the stream never re-fires.");
  console.log(`      The re-drive is rebuildProjections (the RebuildFunction lambda on swng-${stage}, manual invoke), which`);
  console.log("      re-projects every snapshot through the same projectArchive a finalize uses. Do not build a second one.");
  process.exit(0);
}

// --- the write set is the size the inventory says it is ------------------------------------------
// spec §4 enumerates 15 records. A different number means production moved since that inventory —
// new rounds in the old shape, or someone else's write — and the operator needs to stop and
// re-inventory rather than write a set nobody counted. Dry run reports and continues, because
// reporting is the whole job there.

if (records.length !== expected) {
  const message =
    `the write set is ${records.length} record(s), but ${expected} was expected (spec §4's enumerated inventory).\n` +
    `       Production has moved since that inventory, or this is a resumed run after a partial write.\n` +
    `       Re-inventory before writing — or, if ${records.length} is genuinely what is left, pass --expect ${records.length}.`;
  if (write) {
    console.error(`REFUSING TO WRITE — ${message}\n\nNothing was written.`);
    process.exit(1);
  }
  console.log(`WARNING — ${message}\n`);
}

// --- the plan ---------------------------------------------------------------------------------

console.log(`${records.length} record(s) to migrate — every one of them parses at HEAD:\n`);
for (const record of records) {
  console.log(`  ${record.table}  ${record.key}   [${record.kind}]`);
  for (const line of describeChange(record.before, record.after)) console.log(`      ${line}`);
}
console.log("");

if (!write) {
  console.log(`DRY RUN — nothing written. ${records.length} record(s) would be put back whole, with only the \`event\`/\`archive\` attribute replaced.`);
  console.log(`Re-run with --write to migrate. The projections and core tables are read for the export and never written.`);
  process.exit(0);
}

// --- write ------------------------------------------------------------------------------------
// Whole items, events before snapshots. `records` is already sorted into that order.

let written = 0;
let writtenEvents = 0;
let writtenSnapshots = 0;
for (const record of records) {
  try {
    await client.send(new PutCommand({ TableName: record.table, Item: record.item }));
  } catch (error) {
    console.error(`\nFAILED writing ${record.table} ${record.key}: ${String(error)}`);
    console.error(`${written} record(s) were written before this failure. The transform is idempotent — fix the cause and re-run; it will pick up exactly`);
    console.error(`what is left (${records.length - written} record(s), so the re-run needs --expect ${records.length - written}).`);
    process.exit(1);
  }
  written += 1;
  if (record.table === roundsTable) writtenEvents += 1;
  else writtenSnapshots += 1;
  console.log(`  wrote ${record.table}  ${record.key}`);
}

console.log(`\nWROTE ${written} record(s): ${writtenEvents} event item(s), then ${writtenSnapshots} snapshot item(s).`);
console.log(`${projectionsTable} and ${coreTable} were read for the export and NOT written — the record lines re-derive from the snapshot stream.`);
console.log(`Nothing was deleted.\n`);
console.log(`NEXT: run \`node scripts/checkProdParses.mjs --stage ${stage}\`. It must exit 0. The record lines only pass once the`);
console.log(`      projector has consumed these snapshot writes, so allow a moment and re-run rather than reading the first`);
console.log(`      result as a failure. If they stay stale, rebuildProjections (the RebuildFunction lambda on swng-${stage},`);
console.log(`      manual invoke) re-projects every snapshot — a re-run of THIS script cannot fix them, because it would find`);
console.log(`      nothing to write and never touch the snapshot stream again.`);
