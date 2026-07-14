// One-time cleanup (pre-prod hardening, H-T3): delete the retired INDEX snapshot items —
// D4a moved the handicap index to read-time computation in getMyRecord, so nothing writes or
// reads `sk = "INDEX"` anymore (the port methods are deleted); these rows are dead data. A
// migration script is the one honest place for a Scan.
//
//   node scripts/dropIndexProjectionItems.mjs [--stage beta] [--dry-run]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const dryRun = process.argv.includes("--dry-run");
const table = `swng-projections-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

let doomed = 0;
let kept = 0;
let exclusiveStartKey;
do {
  const page = await client.send(
    new ScanCommand({ TableName: table, ProjectionExpression: "pk, sk", ExclusiveStartKey: exclusiveStartKey }),
  );
  for (const item of page.Items ?? []) {
    if (item.sk !== "INDEX") {
      kept += 1;
      continue;
    }
    doomed += 1;
    if (!dryRun) await client.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } }));
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`${dryRun ? "[dry-run] would delete" : "deleted"} ${doomed} INDEX item(s) from ${table} (${kept} non-INDEX items untouched)`);
