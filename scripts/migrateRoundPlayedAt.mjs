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
// ORDERING — WHY `--write` MAKES YOU NAME WHICH SIDE OF THE DEPLOY YOU ARE ON
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
// is refused unless you name a side — `--before-deploy`, or `--straggler-after-deploy` for the one
// legitimate post-deploy run (next section). Same ruling as scrapCourseAndRoundData's required course
// choice and the strokes migration's own flag — make illegal states unrepresentable rather than
// documenting the hazard, because prose stops nothing and an exit code does.
//
// THE STRAGGLER: A LEGITIMATE POST-DEPLOY RUN, AND ITS OWN FLAG
//
// A round created between the final dry run and the deploy carries no `playedAtMs`, and it is
// therefore broken the moment the new build lands. Migrating it is not optional and it cannot
// happen before the deploy, so `--before-deploy` is an assertion the operator cannot honestly make
// — and a guard whose only escape is to lie to it or to edit the script is a guard that gets
// edited. `--straggler-after-deploy` is that run's own assertion. It is not a bypass: migrating is
// never unsafe in either order (the transform is idempotent, and a record it changes is one the
// deployed build cannot currently read, so the write can only improve matters), which is why this
// flag exists at all. What the guard actually protects is that you have THOUGHT about which side of
// the deploy you are on, so each side gets a flag and neither is the default. Passing both is
// refused: they say opposite things about the world.
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
// A ROUND YOU ALREADY MIGRATED CAN COME BACK AS PENDING. That is not a failed write, and it is the
// one observation on this whole path that reads like one, so it is named here rather than left to
// be re-derived at 2am. `createDynamoEventJournal.read` parses stored events with the DEPLOYED
// schema, and the deployed (pre-migration) build does not know `playedAtMs`, so it strips the key
// on read. `settleRound` builds `archive.events` out of those parsed events. So a round whose
// genesis event you migrated, and which is then FINALIZED by the old lambda, writes a brand-new
// snapshot whose genesis event carries no played date — a freshly un-migrated record, created after
// your write, by a build that was never told about the field. The rounds-table event stays
// migrated; the snapshot is new. The remedy is already the rule above and needs no special
// handling: re-run until a dry run reports 0 pending. It is only surprising if you read a
// reappearing key as evidence the earlier write did not land.
//
// Safety, in the order it happens:
//
//   1. In `--write` mode with something to write, every item of all four tables is exported to
//      `swng-backup-<stage>-<timestamp>.json` BEFORE any write, together with the enumerated keys
//      this run intends to change and the NAME OF THE SCRIPT THAT WROTE IT. If the export fails for
//      any reason the run exits before writing. The export is taken from the very same scan the
//      migration is computed from, so the `before` images on disk are exactly the images being
//      transformed. NOTE THE PREFIX: `prod-backup-` is the STROKES migration's export
//      (scripts/migrateProdStrokes.mjs) and `swng-backup-` is this one's, because this arc migrates
//      beta too and a beta export named "prod-backup" is a file someone will misread at exactly the
//      wrong moment. The filename is a convention though, and an operator globbing for "a backup"
//      can walk straight past it — so the stamp inside the file is what `--restore` actually checks.
//      A dry run does NOT write an export — it says so — because the protection that matters is an
//      export taken in the same invocation as the write, not a stale one from an earlier run. A
//      `--write` run with NOTHING PENDING does not write one either, and says so: an export is a
//      verbatim dump of every golfer's real name and Cognito sub, and there is no reason to put
//      another copy of that on disk to protect zero writes.
//   2. Every transformed record is PARSED with HEAD's own schema before a single Put is issued. A
//      record that would not parse is never written and stops the run. That makes it structurally
//      impossible for this script to write a record the app cannot read.
//   3. `--expect <n>` is OPTIONAL and, when given, asserted ON BOTH VERBS: a migration `--write`
//      refuses on a mismatch against its write set, and a `--restore` refuses on a mismatch against
//      the number of changed keys the export records. (It used to be accepted and silently dropped
//      on the restore path — the same class already fixed once here.) The check runs before the
//      "nothing to do" / "nothing to restore" exits. A zero write set is a write set, and an
//      operator who asserts a number about the world has to be told when the world disagrees, even
//      on a run that would have written nothing.
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
// the keys it recorded in the export — and nothing else. It REFUSES a file this script did not
// write: the strokes migration's own `prod-backup-*.json` dumps sit in the same directory, hold the
// same four tables in the same shape, carry a matching `stage` and a matching `migrated` key list,
// and would therefore sail through every other guard here while putting prod's records back into
// their PRE-STROKES shape. A filename cannot stop that; a stamp inside the file can. Two further
// limits, both real, stated because each is a different way a restore can disappoint:
//   * it does not DELETE items created since the export; and
//   * it does not REVERT the items the migration never touched. Restoring all four tables verbatim
//     would do that, and an hour after the migration it would silently roll back every round,
//     golfer and course created since — data loss dressed as safety. The full four-table dump
//     stays in the file as the forensic artifact; the restore is scoped to the changed keys.
// A restore run BEFORE the deploy needs nothing else: pre-migration records are exactly what the
// deployed build already expects. IF THE DEPLOY HAS ALREADY LANDED, ROLL THE LAMBDAS BACK FIRST.
// Putting `playedAtMs`-less archives back while HEAD is deployed writes archives HEAD cannot parse:
// each one poisons the snapshots stream (bisect, retry, DLQ) and — because the rebuild pages by
// parsing eagerly — it also BRICKS `rebuildProjections`, the very instrument this file points at
// for the step that follows. Restoring the data without restoring the code leaves you with neither
// a working read path nor a working re-drive.
//
// SO `--restore --write` REQUIRES `--head-not-deployed`, and this is the one place in this file
// where the flag guards a genuine hazard rather than recording which side of a deploy you are on.
// It reads as an inversion of the header's own opening principle — that migrating "is never unsafe
// in either order" — and it is not: MIGRATING is never unsafe in either order, and RESTORING is.
// The two verbs earn different guards because they carry different risk, and the previous version
// had it backwards: `--write` demanded a flag, `--restore --write` demanded nothing, exited 0,
// performed its Puts, and printed the hazard warning AFTERWARDS. The warning now prints before any
// Put, and the assertion is about the DEPLOYED CODE — "HEAD is not what is live" — which is true
// both before the deploy lands and after the lambdas have been rolled back.
//
// The projections and core tables are READ (for the export) and never written. The projection
// lines are not migrated here at all — they are re-derived by `rebuildProjections` after the
// deploy (spec §8).
//
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> [--dry-run]        # dry run
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> --write --before-deploy [--expect N]
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> --write --straggler-after-deploy   # deploy already landed
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> --restore <file>                    # dry run
//   node scripts/migrateRoundPlayedAt.mjs --stage <beta|prod> --restore <file> --write --head-not-deployed
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
// `classifyItems` decides what this run will write, using the only two transform entry points a
// stored item can need — so every change this script performs, and every decision about which
// records to change, comes out of that module and none of it is restated here.
import { classifyItems, isoOf, playedDateOf } from "./roundPlayedAtMigration.mjs";

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
const stragglerAfterDeploy = argv.includes("--straggler-after-deploy");
const restoreFile = flagValue("--restore", "the path of an export file written by an earlier --write run.");
// `--restore --write` is THE order-sensitive verb here, and it used to be the one with no assertion
// at all (fix wave, Important 6). Migrating is never unsafe in either order — which is why that
// path's flags are about naming which side you are on — but a RESTORE after the deploy puts back
// archives HEAD cannot parse, poisoning the snapshots stream and bricking rebuildProjections. It
// asked for nothing, exited 0, performed its Puts, and printed the warning AFTERWARDS. So the one
// genuinely dangerous combination now carries the one real acknowledgement, and it is an assertion
// about the DEPLOYED CODE rather than about intent: "HEAD is not what is live" — true both before
// the deploy has landed and after the lambdas have been rolled back.
const headNotDeployed = argv.includes("--head-not-deployed");

// Stamped into every export this script writes and ASSERTED by `--restore` (see the header). The
// strokes migration's exports hold the same four tables under the same keys with a matching `stage`
// and `migrated` list, so nothing else in the restore path can tell one arc's dump from the other's.
const WRITTEN_BY = "scripts/migrateRoundPlayedAt.mjs";

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

// Two flags, one for each side of the deploy, and they say opposite things about the world.
if (beforeDeploy && stragglerAfterDeploy) {
  console.error("error: --before-deploy and --straggler-after-deploy say opposite things about whether the new build is live. Pass one.");
  console.error("       Nothing has been read or written.");
  process.exit(1);
}

// THE ORDERING GUARD (see the header) — and note it INVERTS relative to migrateProdStrokes.mjs.
// Scoped to a MIGRATION write: `--restore --write` is the break-glass rollback and must not be
// gated behind an acknowledgement about deploy order, which has nothing to do with putting
// original images back.
if (write && restoreFile === undefined && !beforeDeploy && !stragglerAfterDeploy) {
  console.error(
    "error: pass --before-deploy to confirm the new build is NOT deployed yet (spec §8 — migrate first, then deploy).\n" +
      "       NOTE THIS IS THE OPPOSITE of scripts/migrateProdStrokes.mjs, which requires --after-deploy. Here the new\n" +
      "       lambda REQUIRES playedAtMs with no fallback arm, so deploying before every stored round carries it takes\n" +
      "       every un-migrated round offline. Migrating first breaks nothing: round-created's schema is not .strict(),\n" +
      "       so the deployed build silently strips the key it does not know.\n" +
      "\n" +
      "       IF THE DEPLOY HAS ALREADY LANDED, pass --straggler-after-deploy instead. That is a real case, not a\n" +
      "       loophole: a round created between the final dry run and the deploy carries no playedAtMs and is broken\n" +
      "       right now, and migrating it is the repair. Migrating is never unsafe in either order — the transform is\n" +
      "       idempotent and a record it changes is one the live build cannot read — so the flag you pass is a\n" +
      "       statement about which side of the deploy you are on, not permission to do something dangerous. Do not\n" +
      "       assert --before-deploy when it is false, and do not edit this file: say which side you are on.\n" +
      "       Nothing has been read or written.",
  );
  process.exit(1);
}

// THE RESTORE ACKNOWLEDGEMENT (fix wave, Important 6). Placed with the other argument guards, above
// every read, so the refusal can honestly say nothing has been touched. This is the inverse
// situation to the migration guard above: there, both orders are safe and the flag records which
// one you are in; here, one order is a real outage and the flag is the thing that stops it.
if (write && restoreFile !== undefined && !headNotDeployed) {
  console.error(
    "error: pass --head-not-deployed to confirm the build that REQUIRES playedAtMs is not the one currently live.\n" +
      "       A restore puts back records with NO playedAtMs. That is exactly what the pre-deploy build expects, and it is\n" +
      "       poison to HEAD: every archive you restore fails HEAD's parse, so each one poisons the snapshots stream\n" +
      "       (bisect, retry, DLQ) AND bricks rebuildProjections, which pages by parsing eagerly. You would be left with\n" +
      "       neither a working read path nor a working re-drive — and this warning used to print AFTER the writes.\n" +
      "\n" +
      "       The flag is true in TWO real situations, and you must be in one of them:\n" +
      "         * the deploy has not landed yet — the deployed build is the one that ignores the field; or\n" +
      "         * it landed and you have ALREADY ROLLED THE LAMBDAS BACK. Roll the code back first, then restore.\n" +
      "       Restoring the data without restoring the code is the failure this refusal exists to prevent, so do not\n" +
      "       assert this when it is false. Nothing has been read or written.",
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

// `isoOf` / `playedDateOf` live in the rules module beside `classifyItems`, for the same reason it
// does: both crashed rather than diagnosed (fix wave, Minor 6), and a fix that cannot be executed
// by a test is a fix nobody can check.

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
  // WHICH ARC'S DUMP IS THIS? Every other guard in this branch passes on the strokes migration's
  // own `prod-backup-*.json`: same four tables, same item shape, same `stage`, same `migrated` key
  // list. Restoring one here would put those records back into their PRE-STROKES shape and report
  // success. The header names the prefix difference, but a header is not what an operator globbing
  // for "a backup" reads — so the file has to say what wrote it, and a file that does not say this
  // script is refused. The message names what it FOUND, because "wrong file" without saying which
  // file you handed it is a dead end.
  if (backup.writtenBy !== WRITTEN_BY) {
    console.error(`error: ${restoreFile} was not written by this script.`);
    console.error(`       it says writtenBy: ${JSON.stringify(backup.writtenBy)} — this script restores only exports stamped ${JSON.stringify(WRITTEN_BY)}.`);
    console.error(`       An export with no writtenBy at all was written before this stamp existed, and the likeliest such file is the`);
    console.error(`       STROKES migration's own prod-backup-*.json (scripts/migrateProdStrokes.mjs). Restoring that here would put`);
    console.error(`       records back into their pre-strokes shape while every other check in this path passed. Nothing was written.`);
    process.exit(1);
  }
  console.log(`export taken ${backup.takenAt} from stage ${backup.stage}, written by ${backup.writtenBy}`);
  if (backup.stage !== stage) {
    console.error(`error: the export was taken from stage "${backup.stage}" but --stage says "${stage}". Refusing to write one stage's data into another.`);
    process.exit(1);
  }
  if (!Array.isArray(backup.migrated)) {
    console.error(`error: ${restoreFile} records no \`migrated\` key list, so there is no way to know which records this export's run changed.`);
    console.error(`       Refusing to guess — restoring every item in the file would revert records this arc never touched.`);
    process.exit(1);
  }

  // WHERE THE PUTS ACTUALLY GO (fix wave, Minor 5). The `backup.stage` check above compares a
  // METADATA FIELD; the writes below address `entry.table`, which is a string out of the same file.
  // A stamp and a destination are two different things, and only one of them is what a Put obeys —
  // an export whose `stage` says "beta" while its keys name `swng-rounds-prod` sails through the
  // check above and writes prod. So the destination set is checked directly, and it is exactly the
  // two tables a migration ever writes, on THIS run's stage: projections and core are read for the
  // export and never written, so a key naming either of them is an export this script did not make.
  const restorable = new Set([roundsTable, snapshotsTable]);
  const foreign = [...new Set(backup.migrated.map((entry) => String(entry.table)))].filter((table) => !restorable.has(table));
  if (foreign.length > 0) {
    console.error(`error: the export's changed-key list names table(s) this run must not write: ${foreign.join(", ")}.`);
    console.error(`       --stage ${stage} restores into ${roundsTable} and ${snapshotsTable} and nothing else — a migration writes no other table,`);
    console.error(`       so a key naming one is either another stage's data or an export this script did not produce. Nothing was written.`);
    process.exit(1);
  }

  const held = Object.values(backup.tables).reduce((n, items) => n + items.length, 0);
  console.log(`the export holds ${held} item(s) across ${Object.keys(backup.tables).length} table(s) as the forensic record; ${backup.migrated.length} of them were changed by that run and are what a restore puts back\n`);

  // `--expect` was accepted here and silently dropped (fix wave, Minor 4) — the same class already
  // fixed once on the migration path, where a zero write set turned out to be a write set. An
  // operator who asserts a number about the world has to be told when the world disagrees, and on
  // this path the number is how many original images the file will put back. Checked BEFORE the
  // nothing-to-restore exit for exactly that reason.
  if (expected !== undefined && backup.migrated.length !== expected) {
    const message =
      `this export records ${backup.migrated.length} changed key(s), but --expect said ${expected}.\n` +
      `       This is not the export you think it is, or not the run you think it is.\n` +
      `       Re-read the file — or, if ${backup.migrated.length} is genuinely what that run changed, pass --expect ${backup.migrated.length}.`;
    if (write) {
      console.error(`REFUSING TO WRITE — ${message}\n\nNothing was written.`);
      process.exit(1);
    }
    console.log(`WARNING — ${message}\n`);
  }

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

  // BEFORE THE WRITES, NOT AFTER (fix wave, Important 6). This block used to print below the loop —
  // a warning about a hazard delivered once the hazard had already been created. A `--write` run
  // only reaches here having asserted `--head-not-deployed` (the guard at the top), so this states
  // what that assertion committed to while there is still a Ctrl-C between reading it and the Puts.
  if (write) {
    console.log(`ABOUT TO RESTORE ${originals.length} original image(s), each carrying NO playedAtMs.`);
    console.log(`You asserted --head-not-deployed: the build that REQUIRES that field is not the one live on swng-${stage}.`);
    console.log(`If that is wrong, stop now — every archive below would poison the snapshots stream (bisect, retry, DLQ)`);
    console.log(`and brick rebuildProjections, which pages by parsing eagerly, leaving neither a working read path nor a`);
    console.log(`working re-drive. Roll the lambdas back FIRST, then restore.\n`);
  }

  let restored = 0;
  for (const { table, key, item } of originals) {
    console.log(`  ${write ? "restoring" : "would restore"} ${table}  ${key}`);
    if (!write) continue;
    await client.send(new PutCommand({ TableName: table, Item: item }));
    restored += 1;
  }
  if (!write) {
    console.log("\nDRY RUN — nothing written. Re-run with --write --head-not-deployed to restore.");
    process.exit(0);
  }
  console.log(`\nrestored ${restored} original image(s). The other ${held - originals.length} item(s) in the export were untouched by the migration and are untouched by this restore.`);
  console.log(`These records are exactly what the pre-deploy build expects. The RebuildFunction lambda on swng-${stage} is`);
  console.log(`only needed once the new build is live, so rebuildProjections is not part of undoing this.`);
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
// The bucketing rule lives in `scripts/roundPlayedAtMigration.mjs` alongside the transform it
// applies — see `classifyItems` there for what the three buckets mean and why every non-candidate
// item is still counted. It used to sit inline here, where nothing could execute it and every pin
// on it was a pin on this file's source text; three mutations of it (an empty snapshot list among
// them) made a run print "Nothing to do" while leaving every record un-migrated, with all forty
// pins green. "0 pending" is the precondition for deploying, so it is behaviour that has to be
// tested, not shape.

const { records, problems, currentCount, unreadable, skipped } = classifyItems({
  roundsItems,
  snapshotItems,
  roundsTable,
  snapshotsTable,
  roundEventSchema,
  roundArchiveSchema,
});

const candidates = records.length + currentCount + unreadable.length + problems.length;
records.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));

console.log(`${candidates} candidate record(s) examined — ${records.length} pending · ${currentCount} already current · ${unreadable.length} unreadable by this migration`);
if (skipped.size > 0) {
  console.log(`  not this rule's subject, read and left alone:`);
  for (const [what, n] of [...skipped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(`    ${n.toString().padStart(6)}  ${what}`);
}
console.log("");

// --- export (write mode with something to write, before anything is written) ---------------------
// The full four-table dump is the forensic artifact; `migrated` is the enumerated key list a
// `--restore` puts back; `writtenBy` is what stops the other arc's dump being restored with this
// script. All three land in one file, written before any table is touched.
//
// NOT written when there is nothing pending. An export protects the records a run is about to
// change, and a no-op `--write` changes none — so the file would be, for zero benefit, one more
// verbatim copy of every golfer's real name and Cognito sub sitting in a working tree.

if (write && records.length > 0) {
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
    writeFileSync(path, JSON.stringify({ writtenBy: WRITTEN_BY, stage, takenAt: new Date().toISOString(), migrated, tables }, undefined, 1));
  } catch (error) {
    console.error(`error: the export failed, so nothing will be written: ${String(error)}`);
    process.exit(1);
  }
  console.log(`EXPORT: ${total} item(s) from all 4 tables -> ${path}`);
  for (const [tableName, items] of Object.entries(tables)) console.log(`         ${items.length.toString().padStart(6)}  ${tableName}`);
  console.log(`        recorded ${migrated.length} key(s) as this run's write set — a --restore of this file puts back those and nothing else`);
  console.log(`        stamped writtenBy: ${WRITTEN_BY} — --restore refuses a file another script wrote`);
  console.log("");
} else if (write) {
  // Announced, never silent (see below) — and this one is a different skip from the dry run's.
  console.log(`SKIPPED the export: nothing is pending, so this run will change no record. An export protects the records a run`);
  console.log(`        is about to change; with none, it would only be another verbatim copy of every golfer's name and Cognito sub.\n`);
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

// --- the write set is the size the operator says it is -------------------------------------------
// Optional (header, safety note 3): nothing enumerates this write set, so there is no default to
// assert against. When the operator DOES assert one — read off a dry run moments earlier — a
// mismatch means the stage moved in between, and `--write` stops.
//
// THIS SITS ABOVE THE "nothing to do" EXITS ON PURPOSE. It used to sit below them, so
// `--write --expect 9` against an already-migrated stage printed "Nothing to do" and exited 0
// without ever mentioning that 9 is not 0. Nothing was written, so nothing was harmed — but the
// operator asserted a number about the world and the script quietly dropped the assertion, which is
// the same failure mode as a guard that is off. A zero write set is a write set.

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

// --- the plan ---------------------------------------------------------------------------------

console.log(`${records.length} record(s) to migrate — every one of them parses at HEAD:\n`);
for (const record of records) {
  console.log(`  ${record.table}  ${record.key}   [${record.kind}]`);
  for (const line of describeChange(record.before, record.after)) console.log(`      ${line}`);
  // The played date in words, because a 13-digit epoch is not something anyone can sanity-check by
  // eye — and "is this the date that round was actually played" is the one question a reader of
  // this plan can answer and the script cannot.
  console.log(`      played date becomes ${isoOf(playedDateOf(record, roundsTable))}`);
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
