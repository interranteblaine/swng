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
  it("refuses a migration --write without --after-deploy", () => {
    expect(migrate).toContain("if (write && restoreFile === undefined && !afterDeploy) {");
  });

  // A restore is the break-glass rollback and has nothing to do with deploy order, so the guard
  // must stay scoped to a migration write — pinned by the `restoreFile === undefined` clause above.
  it("names rebuildProjections as the recovery in its own output, not only in a doc", () => {
    expect(migrate).toContain("rebuildProjections");
    expect(migrate).toContain("RebuildFunction");
  });

  it("asserts the write set against the inventory spec §4 enumerated", () => {
    expect(migrate).toContain("const EXPECTED_RECORDS = 15;");
  });
});

describe("--restore undoes the migration, not the day", () => {
  // Restoring all four tables verbatim would revert the ~335 items this arc never touched — every
  // round, golfer and course created since the export. The export stays complete as the forensic
  // artifact; the restore is scoped to the keys the run recorded.
  it("refuses an export that records no key list rather than restoring everything", () => {
    expect(migrate).toContain("if (!Array.isArray(backup.migrated)) {");
  });

  it("records the changed keys in the export", () => {
    expect(migrate).toMatch(/JSON\.stringify\(\{ stage, takenAt: [^,]+, migrated, tables \}/);
  });

  // The break-glass path must not need a working build of a package it never parses with.
  it("sits above the schema load", () => {
    expect(migrate.indexOf("if (restoreFile !== undefined) {")).toBeLessThan(migrate.indexOf("await import(\"../packages/contracts/dist/index.js\")"));
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
