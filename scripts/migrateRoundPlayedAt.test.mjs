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
  // the word "DeleteCommand" (the header does) is not what trips them. A namespace binding
  // (`const lib = require(…); new lib.DeleteCommand(…)`) would slip past the import pin, which is
  // why these sit on top of it rather than beside it.
  it.each(["new DeleteCommand(", "new BatchWriteCommand(", "new DeleteItemCommand(", "DeleteRequest", "new UpdateCommand("])(
    "contains no %s",
    (token) => {
      expect(migrate).not.toContain(token);
    },
  );
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
  it("the total parse gate imports no transform at all", () => {
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
  it("refuses a migration --write without --before-deploy", () => {
    const guard = blockOf(migrate, "if (write && restoreFile === undefined && !beforeDeploy) {");
    expect(guard).toContain("--before-deploy");
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
    expect(migrate).toMatch(/JSON\.stringify\(\{ stage, takenAt: [^,]+, migrated, tables \}/);
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
