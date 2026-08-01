// The round played-at migration (spec 2026-08-01 §8). This script WRITES TO A PRODUCTION TABLE.
//
// It is a DRY RUN unless `--write` is passed. It NEVER DELETES ANYTHING — there is no
// DeleteCommand, no BatchWrite, no removal path anywhere in this file, and there is no flag that
// creates one. PROD IS NEVER WIPED. The only writes it can perform are:
//
//   * the rounds table's `round-created` events and the snapshots table's archives, each put back
//     as the WHOLE item it was read as, with only its `event` / `archive` attribute replaced.
//     Never a reconstructed item: a snapshot carries `finalizedAt` and whatever else it carries,
//     and rebuilding an item from the fields you happened to think of is how an attribute
//     disappears silently.
//   * `--restore <file>` — putting back the original images of exactly those records.
//
// THE RULE IS NOT RESTATED HERE. It lives in `scripts/roundPlayedAtMigration.mjs`, which is where
// to read it; a prose copy in this header would be a second statement that drifts from the module
// that owns it exactly the way a second code copy would. What matters at this level is that the
// rule is guarded on `playedAtMs` being ABSENT — never on it disagreeing with the clock, which is
// what lets a genuinely back-dated round survive a re-run — so the migration is idempotent: a
// re-run is a no-op and an interrupted run is just a shorter next run.
//
// ORDERING — WHY `--write` REQUIRES `--before-deploy`
//
// This is the OPPOSITE of the strokes migration (scripts/migrateProdStrokes.mjs), which requires
// `--after-deploy`. Reading that file first and assuming the same order is the mistake this guard
// exists to catch. Spec §8: migrate -> deploy -> rebuildProjections.
//
//   * Migrating FIRST is safe, and safe in a way the strokes arc's order was not. `round-created`'s
//     wire schema is not `.strict()`, so the currently-deployed lambda silently strips the new key.
//     There is no window in which anything is broken.
//   * Deploying first is a REAL OUTAGE. The new lambda REQUIRES `playedAtMs`, with no fallback arm
//     anywhere by design, so every un-migrated round fails to parse — its live page, its archive,
//     and its projection all stop working until the migration catches up.
//   * `rebuildProjections` AFTER the deploy is what puts `playedAtMs` onto the existing projection
//     lines. The snapshot writes this script performs do re-drive the projector stream, but they
//     do it under the OLD projector, which cannot stamp a field it does not know. That rebuild is
//     not optional and it is not a repair; it is a step. `listLines` CASTS rather than parses, so
//     a line missing `playedAtMs` is not refused — it reads as `undefined` and sorts that golfer's
//     history by NaN.
//
// So the ordering is something you must ASSERT rather than something you must remember: `--write`
// is refused without `--before-deploy`. Same ruling as scrapCourseAndRoundData's required course
// choice and the strokes migration's own flag — make illegal states unrepresentable rather than
// documenting the hazard, because prose stops nothing and an exit code does.
//
// `--stage` is required for the same reason, and unlike the sibling it has no default: this arc
// migrates BOTH beta and prod in one close-out, so a default is a stage you can hit by forgetting
// to type one.
//
// THE TWO PASSES ARE INDEPENDENT, AND AN INTERRUPTION IS SAFE
//
// The rounds-table pass and the snapshots pass share no invariant. An archive is self-contained —
// the projector reads the played date out of `archive.events`, never out of the rounds table — so
// neither pass depends on the other having run, in either direction. They are ordered here (events
// first, snapshots last) only because a snapshot write re-fires the projector stream and there is
// no reason to do that before everything else is settled; nothing breaks if they run apart.
//
// An interruption therefore leaves a mix of migrated and un-migrated records, and every one of
// them is readable by the CURRENTLY DEPLOYED build in either state (the schema is not strict, so
// the extra key is stripped). There is nothing to unwind and nothing to repair. The operator's
// whole job is: re-run until a DRY RUN on every stage reports 0 pending, and only then deploy.
// That dry-run-reports-zero is the precondition for step 2 — not this script having exited 0 once.
//
// Safety, in the order it happens:
//
//   1. In `--write` mode, every item of all four tables is exported to
//      `prod-backup-<stage>-<timestamp>.json` BEFORE any write, together with the enumerated keys
//      this run intends to change. If the export fails for any reason the run exits before
//      writing. The export is taken from the very same scan the migration is computed from, so the
//      `before` images on disk are exactly the images being transformed.
//      A dry run does NOT write an export — it says so — because the protection that matters is an
//      export taken in the same invocation as the write, not a stale one from an earlier run.
//   2. Every transformed record is PARSED with HEAD's own schema before a single Put is issued. A
//      record that would not parse is never written and stops the run. That makes it structurally
//      impossible for this script to write a record the app cannot read.
//   3. `--expect <n>` is OPTIONAL and, when given, asserted: `--write` refuses on a mismatch.
//      There is deliberately no default. The strokes migration could default to 15 because its
//      spec enumerated exactly 15 records; nothing enumerates this one — every round on every
//      stage is in scope, and beta legitimately grows between the dry run and the write (a round
//      created before the deploy also lacks the field and also needs migrating). A default here
//      would be a number the operator satisfies reflexively by copying whatever the script just
//      printed, which is a guard that is off. The dry run prints the exact `--expect` to pass.
//   4. Events are written first and snapshots last (see above — a convenience, not an invariant).
//   5. If the parse gate rejects in `--write` mode, the export has already been taken and nothing
//      else has happened. An export file with no migration is the expected residue of that path,
//      not a sign something half-ran.
//
// `--restore <file>` puts back the ORIGINAL images of exactly the records the migration changed —
// the keys it recorded in the export — and nothing else. Two limits, both real, stated because
// each is a different way a restore can disappoint:
//   * it does not DELETE items created since the export; and
//   * it does not REVERT the items the migration never touched. Restoring all four tables verbatim
//     would do that, and an hour after the migration it would silently roll back every round,
//     golfer and course created since — data loss dressed as safety. The full four-table dump
//     stays in the file as the forensic artifact; the restore is scoped to the changed keys.
// A restore run BEFORE the deploy needs nothing else: pre-migration records are exactly what the
// deployed build already expects. IF THE DEPLOY HAS ALREADY LANDED, ROLL THE LAMBDAS BACK TOO.
// Putting `playedAtMs`-less archives back while HEAD is deployed writes archives HEAD cannot parse:
// each one poisons the snapshots stream (bisect, retry, DLQ) and — because the rebuild pages by
// parsing eagerly — it also BRICKS `rebuildProjections`, the very instrument this file points at
// for the step that follows. Restoring the data without restoring the code leaves you with neither
// a working read path nor a working re-drive.
//
// The projections and core tables are READ (for the export) and never written. The projection
// lines are not migrated here at all — they are re-derived by `rebuildProjections` after the
// deploy (spec §8).
//
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> [--dry-run]        # dry run
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> --write --before-deploy [--expect N]
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> --restore <file> [--write]
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
// `transformEvent` / `transformArchive` are the only two entry points a stored item can need, so
// every change this script performs comes out of that module and none of it is restated here.
import { transformEvent, transformArchive, changed } from "./roundPlayedAtMigration.mjs";

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

const stage = flagValue("--stage", "`--stage beta` or `--stage prod`.");
const write = argv.includes("--write");
const dryRun = argv.includes("--dry-run");
const beforeDeploy = argv.includes("--before-deploy");
const restoreFile = flagValue("--restore", "the path of an export file written by an earlier --write run.");

// NO DEFAULT STAGE (see the header). This close-out migrates beta and then prod, so a default is a
// stage you can hit by forgetting to type one.
if (stage === undefined) {
  console.error("error: --stage is required and has no default — pass `--stage beta` or `--stage prod`.");
  console.error("       This arc migrates BOTH stages, so a defaulted stage is one you can hit by forgetting to name it.");
  console.error("       Nothing has been read or written.");
  process.exit(1);
}

// A dry run is the DEFAULT, so `--dry-run` is redundant — but the close-out runbook types it, and a
// flag that is silently ignored is how `--dry-run --write` comes to read as a safe rehearsal that
// writes production. Two mutually exclusive intentions are refused rather than ranked.
if (write && dryRun) {
  console.error("error: --dry-run and --write say opposite things. Pass one. (A dry run is the default; --dry-run only makes it explicit.)");
  console.error("       Nothing has been read or written.");
  process.exit(1);
}

// `--expect` is optional and has NO default (header, safety note 3). When given it is asserted.
const expectRaw = flagValue("--expect", "the number of records this run should find, e.g. `--expect 7`.");
const expected = expectRaw === undefined ? undefined : Number(expectRaw);
if (expectRaw !== undefined && (!Number.isInteger(expected) || expected < 0)) {
  console.error(`error: --expect needs a non-negative whole number (got ${JSON.stringify(expectRaw)}).`);
  process.exit(1);
}

// THE ORDERING GUARD (see the header) — and note it INVERTS relative to migrateProdStrokes.mjs.
// Scoped to a MIGRATION write: `--restore --write` is the break-glass rollback and must not be
// gated behind an acknowledgement about deploy order, which has nothing to do with putting
// original images back.
if (write && restoreFile === undefined && !beforeDeploy) {
  console.error(
    "error: pass --before-deploy to confirm the new build is NOT deployed yet (spec §8 — migrate first, then deploy).\n" +
      "       NOTE THIS IS THE OPPOSITE of scripts/migrateProdStrokes.mjs, which requires --after-deploy. Here the new\n" +
      "       lambda REQUIRES playedAtMs with no fallback arm, so deploying before every stored round carries it takes\n" +
      "       every un-migrated round offline. Migrating first breaks nothing: round-created's schema is not .strict(),\n" +
      "       so the deployed build silently strips the key it does not know. Nothing has been read or written.",
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
// description of what the transform does. It reports what actually changed between two values, so
// it stays honest if the rule ever changes and it cannot become a second, drifting statement of it.
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

const isoOf = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : "??");

console.log(`swng round played-at migration — stage ${stage} — ${write ? "*** WRITE MODE ***" : "DRY RUN"}${restoreFile !== undefined ? ` — RESTORE from ${restoreFile}` : ""}`);
console.log("this script never deletes anything; prod is never wiped\n");

// --- restore ----------------------------------------------------------------------------------
// SCOPED to the records the migration actually changed — the keys it recorded in the export — each
// put back as the verbatim original image.
//
// It is deliberately NOT a four-table rollback. The export holds every item because that is the
// forensic artifact, but almost all of them were never touched by this arc: golfer profiles, course
// pointers, crew rows, score events. Restoring those verbatim an hour after the migration would
// silently revert every round, golfer and course created in between — data loss dressed as safety.
// Undoing this migration means undoing the things this migration did.
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
    console.error(`       Refusing to guess — restoring every item in the file would revert records this arc never touched.`);
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
  console.log(`\nIF THE NEW BUILD IS ALREADY DEPLOYED, ROLL THE LAMBDAS BACK TOO. These archives carry no playedAtMs and`);
  console.log(`the new build REQUIRES it, so each snapshot you just restored poisons the snapshots stream (bisect, retry,`);
  console.log(`DLQ) and bricks rebuildProjections, which pages by parsing eagerly. Restoring the data without restoring`);
  console.log(`the code leaves neither a working read path nor a working re-drive. If the deploy has NOT happened yet,`);
  console.log(`there is nothing else to do — these are exactly the records the deployed build already expects, and the`);
  console.log(`RebuildFunction lambda on swng-${stage} is only needed once the new build is live.`);
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
// Every candidate lands in one of three buckets, and all three are reported. "Nothing to do" is not
// one state but three, and they mean completely different things:
//
//   pending    the transform changes it — this is the write set
//   current    the transform leaves it alone AND it parses at HEAD — already in the right shape
//   unreadable the transform leaves it alone and it does NOT parse at HEAD — this migration cannot
//              fix it, and saying "nothing to do" over such a record would be a lie
//
// Distinguishing them is what stops "0 records" from reading identically whether the migration is
// complete, the stage is empty, or something is wrong that this instrument cannot repair.
//
// SCOPE, stated rather than inferred: on the rounds table only `round-created` events are
// candidates, because that is the only kind this rule can touch. Every other event item is counted
// and named below, never dropped from the accounting, but it is NOT parsed here — checking that
// every stored item of every kind is readable is a different job with a different instrument
// (scripts/checkProdParses.mjs), and a mutation script that also claimed to be the verification
// gate would be exactly the drift the pure/I-O split exists to prevent. On the snapshots table
// every item is a candidate: the archive is one parse unit and one write unit.

const records = [];
const problems = [];
let currentCount = 0;
const unreadable = [];
const skipped = new Map();
const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const classify = (table, key, before, after, buildItem, schema, order, kind) => {
  if (changed(before, after)) {
    records.push({ table, key, kind, before, after, item: buildItem(), schema, order });
    return;
  }
  const result = schema.safeParse(before);
  if (result.success) {
    currentCount += 1;
    return;
  }
  // The REASON travels with the key. This bucket stops the run, and "record X is unreadable" with
  // no path is a dead end for whoever has to decide what to do about it — especially on a snapshot,
  // where the cause can be any embedded event of any kind, not the genesis this rule looks at.
  const issues = result.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  unreadable.push(`${table}  ${key}\n      ${(issues.length > 5 ? [...issues.slice(0, 5), `(+${issues.length - 5} more)`] : issues).join("; ")}`);
};

for (const item of roundsItems) {
  if (item.event === undefined) {
    const sk = String(item.sk ?? "");
    tally(skipped, sk.startsWith("OPID#") ? "OPID# dedup tombstone (carries no event)" : sk === "META" ? "META round pointer (carries no event)" : `other sk "${sk}" (carries no event)`);
    continue;
  }
  if (item.event.kind !== "round-created") {
    tally(skipped, `${String(item.event.kind)} event (not this rule's subject)`);
    continue;
  }
  let after;
  try {
    after = transformEvent(item.event);
  } catch (error) {
    problems.push({ key: `${roundsTable}  ${item.pk} ${item.sk}`, detail: `the transform threw: ${String(error)}` });
    continue;
  }
  // events first — `order` drives both the write order and the order recorded in the export
  classify(roundsTable, `${item.pk} ${item.sk}`, item.event, after, () => ({ ...item, event: after }), roundEventSchema, 0, "round-created");
}

for (const item of snapshotItems) {
  let after;
  try {
    after = transformArchive(item.archive);
  } catch (error) {
    problems.push({ key: `${snapshotsTable}  ${item.pk}`, detail: `the transform threw: ${String(error)}` });
    continue;
  }
  // snapshots last — the stream fires off these
  classify(snapshotsTable, String(item.pk), item.archive, after, () => ({ ...item, archive: after }), roundArchiveSchema, 1, "archive");
}

const candidates = records.length + currentCount + unreadable.length + problems.length;
records.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));

console.log(`${candidates} candidate record(s) examined — ${records.length} pending · ${currentCount} already current · ${unreadable.length} unreadable by this migration`);
if (skipped.size > 0) {
  console.log(`  not this rule's subject, read and left alone:`);
  for (const [what, n] of [...skipped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(`    ${n.toString().padStart(6)}  ${what}`);
}
console.log("");

// --- export (write mode only, before anything is written) ---------------------------------------
// The full four-table dump is the forensic artifact; `migrated` is the enumerated key list a
// `--restore` puts back. Both land in one file, written before any table is touched.

if (write) {
  const projectionItems = await scanAll(projectionsTable);
  const coreItems = await scanAll(coreTable);
  // `swng-backup-`, not the strokes migration's `prod-backup-`: this arc migrates beta too, and a
  // beta export named "prod-backup" is a file someone will misread at exactly the wrong moment.
  // The prefix is matched by a .gitignore rule and a test pins that link — an export is a verbatim
  // dump of real people's names and Cognito subs, and it must never be committable by accident.
  const path = `swng-backup-${stage}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
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
  for (const [tableName, items] of Object.entries(tables)) console.log(`         ${items.length.toString().padStart(6)}  ${tableName}`);
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
// about: it is outside this migration's reach and needs a person. The likeliest cause here is a
// genesis event with no usable `hlc.wallMs` — the transform deliberately refuses to invent a played
// date for one, because a fabricated date is worse than an unreadable record.
if (unreadable.length > 0) {
  console.error(`STOP — ${unreadable.length} record(s) neither need this transform nor parse at HEAD. This migration cannot fix them:\n`);
  for (const key of unreadable) console.error(`  ${key}`);
  console.error("\nNothing was written.");
  process.exit(1);
}

if (candidates === 0) {
  console.log(`No round-created events or snapshots found at all in ${roundsTable} / ${snapshotsTable}. That is an empty stage, not a completed migration — check --stage and the AWS profile.`);
  process.exit(0);
}

if (records.length === 0) {
  console.log(`Nothing to do — all ${currentCount} record(s) already carry playedAtMs. The transform is idempotent, so this is what a completed migration looks like on a second run.`);
  console.log("Nothing was written.\n");
  console.log(`NEXT (spec §8): this stage's stored rounds are ready. Deploy, and then run rebuildProjections (the RebuildFunction`);
  console.log(`      lambda on swng-${stage}, manual invoke) to stamp playedAtMs onto the existing projection lines — the snapshot`);
  console.log(`      writes a migration performs re-drive the stream under the OLD projector, which cannot stamp a field it does`);
  console.log(`      not know. That is a STEP, not a repair: listLines CASTS, so a line without it sorts a history by NaN.`);
  process.exit(0);
}

// --- the write set is the size the operator says it is -------------------------------------------
// Optional (header, safety note 3): nothing enumerates this write set, so there is no default to
// assert against. When the operator DOES assert one — read off a dry run moments earlier — a
// mismatch means the stage moved in between, and `--write` stops.

if (expected !== undefined && records.length !== expected) {
  const message =
    `the write set is ${records.length} record(s), but --expect said ${expected}.\n` +
    `       The stage moved between the dry run and this one, or this is a resumed run after a partial write.\n` +
    `       Re-read the dry run — or, if ${records.length} is genuinely what is left, pass --expect ${records.length}.`;
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
  // The played date in words, because a 13-digit epoch is not something anyone can sanity-check by
  // eye — and "is this the date that round was actually played" is the one question a reader of
  // this plan can answer and the script cannot.
  const played = record.table === roundsTable ? record.after.playedAtMs : record.after.events.find((e) => e.kind === "round-created")?.playedAtMs;
  console.log(`      played date becomes ${isoOf(played)}`);
}
console.log("");

if (!write) {
  console.log(`DRY RUN — nothing written. ${records.length} record(s) would be put back whole, with only the \`event\`/\`archive\` attribute replaced.`);
  console.log(`Re-run with --write --before-deploy --expect ${records.length} to migrate. The projections and core tables are read for the export and never written.`);
  console.log(`THE FULL SEQUENCE (spec §8) is migrate -> deploy -> rebuildProjections, and this script is only the first of the three.`);
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
console.log(`${projectionsTable} and ${coreTable} were read for the export and NOT written.`);
console.log(`Nothing was deleted.\n`);
console.log(`NEXT (spec §8), and the order is the whole point:`);
console.log(`  1. Re-run this script as a DRY RUN on every stage that will get the new build — each must report 0 pending.`);
console.log(`     A stage exiting 0 once is not the precondition; a dry run finding nothing left is.`);
console.log(`  2. Deploy. Only now can every stored round satisfy the new build, which REQUIRES playedAtMs with no fallback.`);
console.log(`  3. rebuildProjections (the RebuildFunction lambda on swng-${stage}, manual invoke, {cursor?, maxSnapshots?} in) —`);
console.log(`     the snapshot writes above re-drove the stream under the OLD projector, which cannot stamp a field it does not`);
console.log(`     know, so the stored projection lines still carry no playedAtMs. This is a STEP, not a repair: listLines CASTS`);
console.log(`     rather than parses, so a line without it reads as undefined and sorts that golfer's history by NaN.`);
