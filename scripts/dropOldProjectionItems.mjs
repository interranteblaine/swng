// One-time cleanup (snapshot realignment, Task 7): delete the retired projection keyspaces —
// HISTORY# lines (replaced by stable ROUND# keys, repopulated by the rebuild and verified for
// parity before this runs) and the CREWROUNDS#/RECORDS# crew-ledger keyspaces (sentenced by
// the spec: M8 crew data is beta test data, dropped without migration; crew-seasons arrive as
// entity data in a later task). A migration script is the one honest place for a Scan.
//
//   node scripts/dropOldProjectionItems.mjs [--stage beta]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const table = `swng-projections-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

const retired = (pk, sk) => sk.startsWith("HISTORY#") || pk.startsWith("CREWROUNDS#") || pk.startsWith("RECORDS#");

let deleted = 0;
let exclusiveStartKey;
do {
  const page = await client.send(
    new ScanCommand({ TableName: table, ProjectionExpression: "pk, sk", ExclusiveStartKey: exclusiveStartKey }),
  );
  for (const item of page.Items ?? []) {
    if (!retired(item.pk, item.sk)) continue;
    await client.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } }));
    deleted += 1;
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`deleted ${deleted} retired projection item(s) from ${table}`);
