// One-time cleanup (crew membership — invited in, accountable out; owner amendment
// 2026-07-14): delete EVERY crew item — root, MEMBER#, seasons, counted rounds, all of which
// live under the crew's own `pk = CREW#<id>` partition on the core table. The membership
// model changed (permanent join codes died; the organizer got authority) and the owner's
// ruling was delete-don't-migrate: beta crews are test data, and nothing tolerates a legacy
// joinCode attribute because nothing will ever read one. A migration script is the one honest
// place for a Scan.
//
//   node scripts/dropCrewData.mjs [--stage beta] [--dry-run]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const dryRun = process.argv.includes("--dry-run");
const table = `swng-core-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

let doomed = 0;
let kept = 0;
let exclusiveStartKey;
do {
  const page = await client.send(
    new ScanCommand({ TableName: table, ProjectionExpression: "pk, sk", ExclusiveStartKey: exclusiveStartKey }),
  );
  for (const item of page.Items ?? []) {
    if (!item.pk.startsWith("CREW#")) {
      kept += 1;
      continue;
    }
    doomed += 1;
    if (!dryRun) await client.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } }));
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`${dryRun ? "[dry-run] would delete" : "deleted"} ${doomed} crew item(s) from ${table} (${kept} non-crew items untouched)`);
