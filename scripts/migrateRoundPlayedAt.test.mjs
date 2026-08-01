// Structural pins on the played-at migration instrument's safety properties.
//
// The script cannot be unit-tested by running it — it is a top-level-await CLI that scans live
// tables the moment it is imported. What CAN be pinned, and is worth pinning because a future edit
// will not otherwise be noticed, is the shape of the code: what the file is able to CALL, what it
// refuses, in what order it does things, and whether it puts back whole items or rebuilt ones.
//
// Every guard below was proven RED by deleting the guard it names. That is the bar, because a
// re-review of this file's sibling (migrateProdStrokes.test.mjs) found three pins that passed with
// their subject deleted outright: one satisfied by a header comment, one asserting an `if` line
// whose body could have been softened to a warning, and one comparing `indexOf` results where -1 <
// n passes vacuously. The helpers below exist to make that class hard to write.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const migrate = source("migrateRoundPlayedAt.mjs");
const rules = source("roundPlayedAtMigration.mjs");
const check = source("checkProdParses.mjs");

// Lines that PRINT the given text at runtime. A comment mentioning it does not count — and this
// file documents itself heavily, so that distinction is the difference between a pin and a grep.
//
// The `//` exclusion is not decoration. Without it this helper counts a commented-OUT
// `// console.log(…)` as an emitted line, so the realistic regression — someone silencing an
// output line while leaving it in place — passes clean. Proven: it did, before this clause.
const emitted = (text, needle) =>
  text.split("\n").filter((line) => !line.trimStart().startsWith("//") && line.includes("console.log(") && line.includes(needle));

// The body of a brace block, from its opening line to the closing brace at the same indentation,
// so "this guard refuses" is asserted against the guard's own statements rather than its `if`.
const blockOf = (text, header) => {
  const start = text.indexOf(header);
  expect(start, `expected to find \`${header}\` — the pin below is meaningless without it`).toBeGreaterThan(-1);
  const indent = " ".repeat(header.length - header.trimStart().length);
  const end = text.indexOf(`\n${indent}}`, start);
  expect(end, `expected \`${header}\` to be a closed block`).toBeGreaterThan(start);
  return text.slice(start, end);
};

// Positions of two anchors, each asserted PRESENT before they are compared. `indexOf` answers -1
// for a string that is absent and -1 is less than every real index, so the naive form of an
// ordering pin passes when the thing it orders is deleted outright.
const before = (earlier, later) => {
  const a = migrate.indexOf(earlier);
  const b = migrate.indexOf(later);
  expect(a, `\`${earlier}\` is gone`).toBeGreaterThan(-1);
  expect(b, `\`${later}\` is gone`).toBeGreaterThan(-1);
  expect(a).toBeLessThan(b);
};

// Executable lines only: every line whose first non-space characters are not `//`, with any trailing
// `// …` stripped. Both files this suite reads document themselves at length, so a check run over
// the raw text is answered by the prose rather than by the code — which is the difference between a
// pin and a grep. (`https://` and friends survive: the strip needs whitespace before the slashes.)
const codeLines = (text) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .map((line) => line.replace(/\s\/\/.*$/, ""));

// The names destructured out of a `require("<pkg>")` — the complete set of SDK commands the file
// can call, since a name that was never bound cannot be invoked.
const imported = (text, pkg) => {
  const matches = [...text.matchAll(new RegExp(`const \\{([^}]*)\\} = require\\("${pkg}"\\);`, "g"))];
  expect(matches, `expected exactly one require("${pkg}")`).toHaveLength(1);
  return matches[0][1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
};

describe("migrateRoundPlayedAt.mjs cannot delete production data", () => {
  it("imports only Scan and Put from lib-dynamodb — nothing that removes anything", () => {
    expect(imported(migrate, "@aws-sdk/lib-dynamodb")).toStrictEqual(["DynamoDBDocumentClient", "ScanCommand", "PutCommand"]);
  });

  it("imports only the client from client-dynamodb", () => {
    expect(imported(migrate, "@aws-sdk/client-dynamodb")).toStrictEqual(["DynamoDBClient"]);
  });

  // Belt-and-braces over the import pin above: these are the CALL forms, so a comment mentioning
  // the word "DeleteCommand" (the header does) is not what trips them.
  it.each(["new DeleteCommand(", "new BatchWriteCommand(", "new DeleteItemCommand(", "DeleteRequest", "new UpdateCommand("])(
    "contains no %s",
    (token) => {
      expect(migrate).not.toContain(token);
    },
  );

  // THE BINDING FORM IS THE HOLE, and the two pins above do not close it. A re-review of this file
  // planted, in the shipped script:
  //
  //     const lib = require("@aws-sdk/lib-dynamodb");
  //     const nuke = (t, k) => client.send(new lib.DeleteCommand({ TableName: t, Key: k }));
  //
  // and the suite stayed green at 79. `imported()` matches only the DESTRUCTURED form, so a second
  // namespace-bound require does not change what it reports; and `new lib.DeleteCommand(` does not
  // contain the token `new DeleteCommand(`. A live deletion path in a script that writes production,
  // with every pin passing. (An earlier comment here claimed this case WAS covered — it was not, and
  // a pin that describes protection it does not provide is worse than an absent one.)
  //
  // The two below close it from opposite directions, so neither the SDK's naming nor the binding
  // syntax has to be guessed at. Names first: no line of code may so much as mention a removing or
  // in-place-mutating command, under any binding, spelled any way the SDK spells it.
  it("no line of executable code names a removing or in-place-mutating command, in any binding form", () => {
    const offenders = codeLines(migrate).filter((line) => /Delete|BatchWrite|TransactWrite|UpdateCommand|UpdateItem/.test(line));
    expect(offenders, "these lines can reach a command that removes or mutates stored data").toStrictEqual([]);
  });

  // Then the call sites, which catches the same mutant a second way and does not depend on knowing
  // the name of the command someone reaches for. Exactly two `require("…")` calls exist in this
  // file: the client and the document client. A third is, by construction, an SDK surface these
  // pins were never written against.
  it("makes exactly two require() calls, so there is no third SDK surface to bind", () => {
    expect(codeLines(migrate).join("\n").match(/require\("/g) ?? []).toHaveLength(2);
  });
});

describe("the rule lives in exactly one place, and that place cannot do I/O", () => {
  it("the instrument imports its transform from the shared module", () => {
    expect(migrate).toContain('from "./roundPlayedAtMigration.mjs"');
  });

  // The pure/I-O split is only worth anything if the pure half is actually pure. A module that
  // could reach a table could report a shape that only exists in memory.
  it.each(["require(", "aws-sdk", "node:fs", "process."])("the rules module contains no %s", (token) => {
    expect(rules).not.toContain(token);
  });

  // A verification instrument must never transform anything — it reports what is actually stored.
  // If the gate imported the transform it could pass on a shape that exists only in its own RAM.
  //
  // KEPT, BUT NOT ALONE. On its own that negative had no positive control: nothing in
  // checkProdParses.mjs mentions the transform, nothing ever would by accident, and if `check` were
  // read as the wrong file — or an empty string — the assertion would pass just as happily. The
  // first expectation below is that control, and it is a real property in its own right: the field
  // this arc's §6.1 gap was about. `playedAtMs` is NOT a GolferRoundLine member; it is required by
  // the ProjectionStore port, `listLines` CASTS rather than parses, and only `rebuildProjections`
  // puts it onto lines written before it existed. Nothing else proves that step ran, and the
  // failure is asymmetric — the profile and golfer pages THROW without it (loud, a browser walk
  // finds it) while a crew board silently drops the round from its season window (nothing does).
  it("the total parse gate requires playedAtMs on a stored line, and imports no transform", () => {
    const fields = check.match(/const REQUIRED_LINE_FIELDS = \[([\s\S]*?)\n\];/)?.[1];
    expect(fields, "checkProdParses.mjs no longer declares REQUIRED_LINE_FIELDS the way this pin reads it").toBeTruthy();
    expect(fields).toContain('["playedAtMs"');
    expect(check).not.toContain("roundPlayedAtMigration.mjs");
  });
});

describe("migrateRoundPlayedAt.mjs writes whole items, never rebuilt ones", () => {
  // A snapshot item carries `finalizedAt` and whatever else it carries. Spreading the item that
  // was read and replacing ONE attribute is the only form that cannot silently drop a field nobody
  // remembered; a hand-built `Item: { pk, sk, event }` would look correct and lose the rest.
  it("puts back the read item with only `event` replaced", () => {
    expect(migrate).toContain("{ ...item, event: after }");
  });

  it("puts back the read item with only `archive` replaced", () => {
    expect(migrate).toContain("{ ...item, archive: after }");
  });

  it("never constructs an item out of named key fields", () => {
    expect(migrate).not.toMatch(/Item:\s*\{\s*pk:/);
  });
});

describe("the ordering trap is an exit code, not prose — and it INVERTS", () => {
  // Spec §8's order is migrate -> deploy -> rebuildProjections, the opposite of the strokes
  // migration's. Deploying first is a real outage: the new lambda REQUIRES playedAtMs and every
  // un-migrated round fails to parse. The refusal is the whole defence, so the condition AND the
  // body are asserted — an `if` line alone would stay green if the body were softened to a warning
  // that carried on. `restoreFile === undefined` is load-bearing in its own right: it keeps the
  // break-glass rollback out of a guard about deploy order.
  it("refuses a migration --write that asserts neither side of the deploy", () => {
    const guard = blockOf(migrate, "if (write && restoreFile === undefined && !beforeDeploy && !stragglerAfterDeploy) {");
    expect(guard).toContain("--before-deploy");
    expect(guard).toContain("process.exit(1)");
  });

  // The straggler: a round created between the final dry run and the deploy carries no playedAtMs
  // and is broken the moment the new build lands, so migrating it CANNOT happen before the deploy —
  // and `--before-deploy` is then an assertion the operator cannot honestly make. A guard whose only
  // escape is to lie to it or edit the file is a guard that gets edited, so that run has its own
  // flag and the refusal above names it. This asserts the refusal MESSAGE, not just the flag's
  // existence: an escape hatch nobody is told about is not an escape hatch.
  it("names the post-deploy straggler run and its flag in the refusal itself", () => {
    const guard = blockOf(migrate, "if (write && restoreFile === undefined && !beforeDeploy && !stragglerAfterDeploy) {");
    expect(guard).toContain("--straggler-after-deploy");
    expect(guard).toContain("IF THE DEPLOY HAS ALREADY LANDED");
  });

  // Two flags for two sides of one deploy. Passing both is a statement and its negation, refused
  // rather than ranked — the same ruling as `--dry-run --write` below.
  it("refuses both deploy-side flags together", () => {
    const guard = blockOf(migrate, "if (beforeDeploy && stragglerAfterDeploy) {");
    expect(guard).toContain("process.exit(1)");
  });

  // The inversion has to be REAL, not just documented. This script is a close adaptation of one
  // whose flag is `--after-deploy`, so the realistic regression is a copy-paste that leaves the old
  // flag being read — and an operator who types the flag they remember would then sail through a
  // guard that is no longer there. Prose about the inversion is fine; PARSING the old flag is the
  // bug, so that is what this asserts.
  it("never reads --after-deploy — the sibling's flag is not accepted here", () => {
    expect(migrate).not.toContain('argv.includes("--after-deploy")');
    expect(migrate).not.toContain('flagValue("--after-deploy"');
  });

  // The documented close-out command passes `--dry-run` explicitly. An unknown flag that is
  // silently ignored is the worst outcome: `--dry-run --write` would read as a safe rehearsal and
  // write production. Two mutually exclusive intentions are refused rather than ranked.
  it("refuses --dry-run and --write together rather than picking one", () => {
    const guard = blockOf(migrate, "if (write && dryRun) {");
    expect(guard).toContain("process.exit(1)");
  });

  // No default stage. This script runs against beta AND prod in the same close-out, so a default
  // is a stage you can hit by forgetting to type one — the same ruling scrapCourseAndRoundData's
  // required course choice already made: no default safe or dangerous.
  it("refuses to run without an explicit --stage", () => {
    const guard = blockOf(migrate, "if (stage === undefined) {");
    expect(guard).toContain("process.exit(1)");
  });
});

describe("the write set is asserted when the operator asserts it, and never invented", () => {
  // Asserts the REFUSAL, not the flag. An earlier version of this pin's sibling checked only that
  // a constant was declared, so deleting the entire guard left it green.
  it("refuses on a mismatch when --expect is given", () => {
    const guard = blockOf(migrate, "if (expected !== undefined && records.length !== expected) {");
    expect(guard).toContain("REFUSING TO WRITE");
    expect(guard).toContain("process.exit(1)");
  });

  // A ZERO WRITE SET IS A WRITE SET. The guard used to sit BELOW the "nothing to do" exit, so
  // `--write --expect 9` against an already-migrated stage printed "Nothing to do", exited 0, and
  // never mentioned that 9 is not 0 — the operator asserted a number about the world and the script
  // dropped the assertion. Nothing was written so nothing was harmed, which is exactly why it went
  // unnoticed. Position is the whole fix, so position is what this pins.
  it("checks --expect before the paths that exit early on an empty write set", () => {
    before("if (expected !== undefined && records.length !== expected) {", "if (candidates === 0) {");
    before("if (expected !== undefined && records.length !== expected) {", "if (records.length === 0) {");
  });

  // Deliberately NO default inventory, unlike the strokes migration's `EXPECTED_RECORDS = 15`.
  // That number came from a spec that enumerated 15 records; nothing enumerates this one — every
  // round on every stage is in scope and beta grows between the dry run and the write. A default
  // here would be a guard the operator satisfies reflexively by copying whatever the script just
  // printed, which is a guard that is off.
  it("declares no invented inventory constant", () => {
    expect(migrate).not.toMatch(/const EXPECTED_RECORDS\s*=/);
  });
});

describe("nothing is written before the export and the parse gate", () => {
  // The export is only protection if it is taken in the same invocation as the write, from the
  // same scan the migration is computed from — so the `before` images on disk are exactly the
  // images being transformed.
  it("exports, then parses every transformed record, then writes", () => {
    before("writeFileSync(path,", "record.schema.safeParse(record.after)");
    before("record.schema.safeParse(record.after)", "new PutCommand({ TableName: record.table, Item: record.item })");
  });

  // An export is a verbatim dump of four live tables — every golfer's real name and Cognito sub
  // included. It lands in the working tree, so the ONLY thing keeping it out of a commit is a
  // .gitignore rule matching the name this script actually chooses. Two independent files have to
  // agree for that to hold, which is exactly the kind of link that rots silently: this asserts the
  // prefix the script builds is the prefix the ignore rule covers, so changing either one alone
  // fails here rather than in a repository someone can read.
  it("writes its export to a filename .gitignore already covers", () => {
    const prefix = migrate.match(/const path = `([a-z-]+)-\$\{stage\}-\$\{new Date\(\)/)?.[1];
    expect(prefix, "the export filename is not built the way this pin reads it").toBeTruthy();
    expect(readFileSync(new URL("../.gitignore", import.meta.url), "utf8")).toContain(`\n${prefix}-*.json`);
  });

  // An export protects the records a run is about to change. A `--write` run with nothing pending
  // changes none, so the file it used to write bought nothing and cost another verbatim copy of
  // every golfer's real name and Cognito sub on disk.
  it("does not write an export when there is nothing pending", () => {
    expect(migrate).toContain("if (write && records.length > 0) {");
  });

  // Structurally impossible for this script to write a record the app cannot read.
  it("refuses the whole run if any transformed record would not parse at HEAD", () => {
    const guard = blockOf(migrate, "if (problems.length > 0) {");
    expect(guard).toContain("REFUSING TO WRITE");
    expect(guard).toContain("process.exit(1)");
  });

  // A record this transform does not change AND that HEAD cannot read is outside this migration's
  // reach. Saying "nothing to do" over it would be a lie, so the run stops and asks for a person.
  it("stops on a record it cannot fix rather than reporting nothing to do", () => {
    const guard = blockOf(migrate, "if (unreadable.length > 0) {");
    expect(guard).toContain("process.exit(1)");
  });
});

describe("--restore undoes the migration, not the day", () => {
  // Restoring every item in the export verbatim would revert everything this arc never touched —
  // every round, golfer and course created since the export. The export stays complete as the
  // forensic artifact; the restore is scoped to the keys that run recorded. A softened body here
  // would fall through into the restore loop, which is the exact wholesale revert this refuses.
  it("refuses an export that records no key list rather than restoring everything", () => {
    const guard = blockOf(migrate, "  if (!Array.isArray(backup.migrated)) {");
    expect(guard).toContain("process.exit(1)");
  });

  it("records the changed keys in the export", () => {
    expect(migrate).toMatch(/JSON\.stringify\(\{ writtenBy: WRITTEN_BY, stage, takenAt: [^,]+, migrated, tables \}/);
  });

  // WHOSE DUMP IS THIS? The strokes migration (scripts/migrateProdStrokes.mjs) writes
  // `prod-backup-*.json` holding the same four tables in the same shape, with a `stage` that
  // matches and a `migrated` key list that is present — so every other guard in this restore path
  // passes on it, and restoring one here would put prod's records back into their PRE-STROKES shape
  // and report success. This file's header used to NAME that other prefix as its own (a stale line
  // from the script it was adapted from), which is precisely how an operator ends up globbing for
  // `prod-backup-*` and handing this script the wrong arc's export. Correcting the header is not the
  // fix — a header is not read at the moment of the mistake. The stamp is: the file says what wrote
  // it, and a file that does not say this script is refused.
  it("stamps the writing script into every export", () => {
    expect(migrate).toContain('const WRITTEN_BY = "scripts/migrateRoundPlayedAt.mjs";');
  });

  it("refuses to restore an export another script wrote, and says what it found", () => {
    const guard = blockOf(migrate, "  if (backup.writtenBy !== WRITTEN_BY) {");
    expect(guard).toContain("process.exit(1)");
    // Names what it FOUND, not merely that something was wrong: "wrong file" without saying which
    // file you handed it is a dead end at the moment it fires.
    expect(guard).toContain("JSON.stringify(backup.writtenBy)");
    expect(guard).toContain("prod-backup");
  });

  // The header pointed at the sibling's filename for the export this script writes. Left alone it
  // is the instruction that leads someone to the wrong file in the first place.
  it("names its own export prefix in the header, not the sibling's", () => {
    expect(migrate).toContain("`swng-backup-<stage>-<timestamp>.json`");
    expect(migrate).not.toContain("`prod-backup-<stage>-<timestamp>.json`");
  });

  // The break-glass path must not need a working build of a package it never parses with.
  it("sits above the schema load", () => {
    before("if (restoreFile !== undefined) {", 'await import("../packages/contracts/dist/index.js")');
  });
});

describe("the rebuild is named as a STEP, in the script's own output", () => {
  // `rebuildProjections` after the deploy is what puts playedAtMs onto the existing projection
  // lines: the snapshot writes this script performs re-drive the stream under the OLD projector,
  // which cannot stamp a field it does not know. It is not a repair and it is not optional — and
  // an operator staring at a terminal does not read the header, so this asserts `console.log(`
  // call sites rather than the presence of the word.
  //
  // Four states can be mistaken for "done": the dry run, the nothing-to-do path, the post-write
  // path, and the restore. Each says it once. The counts are EXACT on purpose — a range would let
  // a deleted line pass, which is precisely how the sibling's version of this pin went hollow.
  it("names rebuildProjections on every path that could be mistaken for done", () => {
    expect(emitted(migrate, "rebuildProjections")).toHaveLength(4);
  });

  it("names the lambda that runs it, so nobody has to go looking", () => {
    expect(emitted(migrate, "RebuildFunction")).toHaveLength(3);
  });
});
