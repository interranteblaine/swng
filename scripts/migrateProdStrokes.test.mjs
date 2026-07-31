// Structural pins on the two instruments' safety properties.
//
// Neither script can be unit-tested by running it — both are top-level-await CLIs that scan live
// tables the moment they are imported. What CAN be pinned, and is worth pinning because a future
// edit will not otherwise be noticed, is the shape of the code: what each file is able to CALL,
// and whether the migration puts back whole items or rebuilt ones.
//
// The strongest form of "this script cannot delete production data" is not a promise in a comment
// — it is that no deleting command is ever imported. Both files reach the AWS SDK through exactly
// one `require` per package, so asserting those two destructures asserts the whole capability set.
// The banned-token checks below are belt-and-braces on top of that.
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
