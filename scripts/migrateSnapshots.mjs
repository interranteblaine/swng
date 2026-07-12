// One-time migration (snapshot realignment, Task 3): copy every ARCHIVE item from the rounds
// table into the snapshots table. This is deliberately a Scan — a migration reads the legacy
// layout once to leave it behind; the running system never scans (that's the whole point of
// the realignment). Idempotent: unconditional puts, so re-running catches any finalize that
// landed old-style during the deploy window and re-copies the rest harmlessly.
//
//   node scripts/migrateSnapshots.mjs [--stage beta]
//
// Uses the SDK out of adapters-dynamodb's own dependency tree so this script needs no
// dependencies of its own.
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const roundsTable = `swng-rounds-${stage}`;
const snapshotsTable = `swng-snapshots-${stage}`;

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }),
  { marshallOptions: { removeUndefinedValues: true } },
);

// Same one-place rule as the adapter's own write path: finalizedAt is the archive's own
// round-finalized event's wall clock. An archive without one is corrupt — fail loudly.
const finalizedAtMsOf = (archive) => {
  const finalized = archive.events.find((event) => event.kind === "round-finalized");
  if (!finalized) throw new Error(`archive for round ${archive.roundId} has no round-finalized event`);
  return finalized.hlc.wallMs;
};

let copied = 0;
let exclusiveStartKey;
do {
  const page = await client.send(
    new ScanCommand({
      TableName: roundsTable,
      FilterExpression: "sk = :a",
      ExpressionAttributeValues: { ":a": "ARCHIVE" },
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );
  for (const item of page.Items ?? []) {
    const archive = item.archive;
    await client.send(
      new PutCommand({
        TableName: snapshotsTable,
        Item: { pk: archive.roundId, finalizedAt: finalizedAtMsOf(archive), archive },
      }),
    );
    copied += 1;
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`migrated ${copied} archive(s) from ${roundsTable} to ${snapshotsTable}`);
