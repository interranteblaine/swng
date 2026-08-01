// Structural pins on the two instruments' safety properties.
//
// Neither script can be unit-tested by running it — both are top-level-await CLIs that scan live
// tables the moment they are imported. What CAN be pinned, and is worth pinning because a future
// edit will not otherwise be noticed, is the shape of the code: what each file is able to CALL,
// and whether the migration puts back whole items or rebuilt ones.
//
// The strongest form of "this script cannot delete production data" is not a promise in a comment
// — it is that no deleting command is ever imported. `imported()` asserts there is exactly ONE
// `require` per package and pins the names destructured out of it, so what it proves is precisely
// "the destructured set contains nothing that deletes". A namespace binding
// (`const lib = require(…); new lib.DeleteCommand(…)`) would slip past that, which is why the
// banned call-form checks below sit on top of it rather than beside it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const check = source("checkProdParses.mjs");
const migrate = source("migrateProdStrokes.mjs");

// Both files document themselves heavily, so a pin that merely greps for a word can be satisfied by
// the HEADER COMMENT while the behaviour it names is gone. Two of this file's pins were exactly
// that until a re-review mutation-tested them. These two helpers are the fix: `emitted` looks only
// at `console.log(` call sites, and `blockOf` extracts a guard's body so a pin can assert the guard
// actually refuses rather than merely that its `if` line exists.

// Lines that PRINT the given text at runtime. A comment mentioning it does not count.
//
// The `//` exclusion is not decoration, and this file is where it was missing. Without it a
// commented-OUT `// console.log(…)` counts as an emitted line, so the realistic regression —
// someone silencing an output line while leaving it in place — passes clean. Proven on this very
// file: commenting out one of the `rebuildProjections` lines in migrateProdStrokes.mjs left the
// suite 21/21 green. The played-at sibling shipped with the clause; this one inherited the hole.
const emitted = (text, needle) =>
  text.split("\n").filter((line) => !line.trimStart().startsWith("//") && line.includes("console.log(") && line.includes(needle));

// The body of a brace block, from its opening line to the closing brace at the same indentation.
// Used so "this guard refuses" is asserted against the guard's own statements.
const blockOf = (text, header) => {
  const start = text.indexOf(header);
  expect(start, `expected to find \`${header}\` — the pin below is meaningless without it`).toBeGreaterThan(-1);
  const indent = " ".repeat(header.length - header.trimStart().length);
  const end = text.indexOf(`\n${indent}}`, start);
  expect(end, `expected \`${header}\` to be a closed block`).toBeGreaterThan(start);
  return text.slice(start, end);
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

describe("checkProdParses.mjs is read-only by construction", () => {
  it("imports ScanCommand and nothing else from lib-dynamodb", () => {
    expect(imported(check, "@aws-sdk/lib-dynamodb")).toStrictEqual(["DynamoDBDocumentClient", "ScanCommand"]);
  });

  it("imports only the client from client-dynamodb", () => {
    expect(imported(check, "@aws-sdk/client-dynamodb")).toStrictEqual(["DynamoDBClient"]);
  });

  it("tells the operator to build rather than skipping the checks when the dist is missing", () => {
    expect(check).toContain("pnpm build");
  });
});

describe("migrateProdStrokes.mjs cannot delete production data", () => {
  it("imports only Scan and Put from lib-dynamodb — nothing that removes anything", () => {
    expect(imported(migrate, "@aws-sdk/lib-dynamodb")).toStrictEqual(["DynamoDBDocumentClient", "ScanCommand", "PutCommand"]);
  });

  it("imports only the client from client-dynamodb", () => {
    expect(imported(migrate, "@aws-sdk/client-dynamodb")).toStrictEqual(["DynamoDBClient"]);
  });

  // Belt-and-braces over the import pin above: these are the call forms, so a comment mentioning
  // the word "DeleteCommand" (the header does) is not what trips them.
  it.each(["new DeleteCommand(", "new BatchWriteCommand(", "new DeleteItemCommand(", "DeleteRequest", "new UpdateCommand("])(
    "contains no %s",
    (token) => {
      expect(migrate).not.toContain(token);
      expect(check).not.toContain(token);
    },
  );
});

describe("migrateProdStrokes.mjs writes whole items, never rebuilt ones", () => {
  // A snapshot item carries `finalizedAt` and whatever else it carries. Spreading the item that
  // was read and replacing ONE attribute is the only form that cannot silently drop a field
  // nobody remembered; a hand-built `Item: { pk, sk, event }` would look correct and lose the rest.
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

describe("the ordering trap is an exit code, not prose", () => {
  // Spec §5's dangerous order. A migration run before `deploy:prod` lets the old projector stamp
  // the old shape back onto the record lines, and a re-run afterwards CANNOT repair it — the
  // transform is idempotent, so nothing is written and the snapshot stream never re-fires. The
  // refusal is the whole defence, so it is pinned rather than left to a header nobody re-reads.
  // The condition AND the refusal. Asserting the `if` line alone would stay green if the body were
  // softened to a warning that carried on — the same class of hollow pin the two below were caught
  // in. `restoreFile === undefined` is load-bearing in its own right: it keeps the break-glass
  // rollback out of a guard about deploy order.
  it("refuses a migration --write without --after-deploy", () => {
    const guard = blockOf(migrate, "if (write && restoreFile === undefined && !afterDeploy) {");
    expect(guard).toContain("process.exit(1)");
  });

  // "in its own OUTPUT" is the whole point — an operator staring at a terminal does not read the
  // header. So this asserts `console.log(` call sites, not the presence of the word: the header
  // mentions `rebuildProjections` twice, and an earlier version of this pin passed with all three
  // printed lines deleted. Three states can be mistaken for success or for a problem this script
  // can fix — the nothing-to-do path, the post-write path, and the restore — and the restore says
  // it twice, because there it is both the thing you must NOT rely on until the lambdas are rolled
  // back and the thing you use once they are. The counts are exact on purpose: a range would let a
  // deleted line pass, which is precisely how the earlier version of this pin went hollow.
  it("names rebuildProjections as the recovery in its own output, not only in a doc", () => {
    expect(emitted(migrate, "rebuildProjections")).toHaveLength(4);
    expect(emitted(migrate, "RebuildFunction")).toHaveLength(3);
  });

  // Asserts the REFUSAL, not the constant. An earlier version of this pin checked only that
  // `EXPECTED_RECORDS = 15` was declared, so deleting the entire guard left it green — the
  // declaration is the input to the property, never the property.
  it("asserts the write set against the inventory spec §4 enumerated, and refuses on a mismatch", () => {
    expect(migrate).toContain("const EXPECTED_RECORDS = 15;");
    const guard = blockOf(migrate, "if (records.length !== expected) {");
    expect(guard).toContain("if (write)");
    expect(guard).toContain("REFUSING TO WRITE");
    expect(guard).toContain("process.exit(1)");
  });
});

describe("--restore undoes the migration, not the day", () => {
  // Restoring all four tables verbatim would revert the ~335 items this arc never touched — every
  // round, golfer and course created since the export. The export stays complete as the forensic
  // artifact; the restore is scoped to the keys the run recorded.
  // Same treatment: the guard must EXIT, not merely exist. A softened body here would fall through
  // into the restore loop, which is the exact wholesale-revert this finding exists to prevent.
  it("refuses an export that records no key list rather than restoring everything", () => {
    const guard = blockOf(migrate, "  if (!Array.isArray(backup.migrated)) {");
    expect(guard).toContain("process.exit(1)");
  });

  it("records the changed keys in the export", () => {
    expect(migrate).toMatch(/JSON\.stringify\(\{ stage, takenAt: [^,]+, migrated, tables \}/);
  });

  // The mirror of the played-at migration's own provenance guard. That script writes
  // `swng-backup-*.json` over the same four tables in the same shape, with a `stage` and a
  // `migrated` list that both read as valid here — so handing this instrument the other arc's dump
  // would restore records into a shape this migration knows nothing about with every other check
  // green. This script's own exports predate any stamp and carry none, so ABSENT is accepted and
  // only a foreign name is refused; requiring its own name would break the restore path for the
  // export files that already exist, which is the one thing this guard must not do.
  it("refuses an export another script stamped, while accepting its own unstamped ones", () => {
    const guard = blockOf(migrate, '  if (backup.writtenBy !== undefined && backup.writtenBy !== "scripts/migrateProdStrokes.mjs") {');
    expect(guard).toContain("process.exit(1)");
    expect(guard).toContain("JSON.stringify(backup.writtenBy)");
  });

  // The break-glass path must not need a working build of a package it never parses with.
  //
  // Both positions are asserted FOUND before they are compared. `indexOf` answers -1 for a string
  // that is absent, and -1 is less than every real index — so the naive form of this pin passed
  // when the restore branch was deleted outright, which is the opposite of what it claims. Found by
  // mutation-testing this file's own pins after a re-review caught two others in the same class.
  it("sits above the schema load", () => {
    const restore = migrate.indexOf("if (restoreFile !== undefined) {");
    const schemaLoad = migrate.indexOf('await import("../packages/contracts/dist/index.js")');
    expect(restore, "the restore branch is gone").toBeGreaterThan(-1);
    expect(schemaLoad, "the schema load is gone").toBeGreaterThan(-1);
    expect(restore).toBeLessThan(schemaLoad);
  });
});

describe("the rename rules live in exactly one place", () => {
  it("the migration imports its transform from the shared module", () => {
    expect(migrate).toContain('from "./prodStrokesMigration.mjs"');
  });

  // The gate must NOT transform anything — it reports what is actually stored. If it ever imported
  // the transform it could report a shape that only exists in memory, which is the one thing a
  // verification instrument must never do.
  it("the gate imports no transform at all — it reads what is stored", () => {
    expect(check).not.toContain("prodStrokesMigration.mjs");
  });
});
