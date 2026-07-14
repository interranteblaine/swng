// One-time cleanup (accounts-only identity, N-T6/N-T7): delete every projection item belonging
// to a golfer who is NOT account-bound (no golfer row on the core table, or a row with no bound
// `sub`) — the ghost lines/index/presence written before the wall. The projector only writes
// account golfers now (projectArchive's own account-bound filter) and a rebuild reproduces only
// account golfers, so after a rebuild these ghost partitions are dead weight nothing will ever
// touch again. Same discipline as dropOldProjectionItems.mjs: a migration script is the one
// honest place for a Scan, idempotent by construction (a second run finds nothing left to
// delete). `--dry-run` lists what WOULD be deleted without deleting — run it first.
//
//   node scripts/dropGhostProjectionLines.mjs [--stage beta] [--dry-run]
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const stage = process.argv.includes("--stage") ? process.argv[process.argv.indexOf("--stage") + 1] : "beta";
const dryRun = process.argv.includes("--dry-run");
const projectionsTable = `swng-projections-${stage}`;
const coreTable = `swng-core-${stage}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", profile: process.env.AWS_PROFILE ?? "swng" }));

// Account-bound = the core table's golfer row (pk GOLFER#<id> / sk "GOLFER") carries a `sub`
// (createDynamoGolferStore's bindSub writes it). No row at all — possible for an old ghost id
// that never had one — counts as not account-bound, same rule projectArchive applies.
// Memoized per pk: one core-table read per golfer partition, not per projection item.
const accountBoundByPk = new Map();
const isAccountBound = async (pk) => {
  const cached = accountBoundByPk.get(pk);
  if (cached !== undefined) return cached;
  const result = await client.send(new GetCommand({ TableName: coreTable, Key: { pk, sk: "GOLFER" } }));
  const bound = result.Item?.sub !== undefined;
  accountBoundByPk.set(pk, bound);
  return bound;
};

let deleted = 0;
let kept = 0;
let exclusiveStartKey;
do {
  const page = await client.send(
    new ScanCommand({ TableName: projectionsTable, ProjectionExpression: "pk, sk", ExclusiveStartKey: exclusiveStartKey }),
  );
  for (const item of page.Items ?? []) {
    // Every projections-table pk is a golfer partition (GOLFER#<id> — keys.ts); anything else
    // (there is nothing else today) is left alone rather than judged by a rule it isn't under.
    if (!item.pk.startsWith("GOLFER#")) {
      kept += 1;
      continue;
    }
    if (await isAccountBound(item.pk)) {
      kept += 1;
      continue;
    }
    if (dryRun) {
      console.log(`would delete ${item.pk} / ${item.sk}`);
    } else {
      await client.send(new DeleteCommand({ TableName: projectionsTable, Key: { pk: item.pk, sk: item.sk } }));
    }
    deleted += 1;
  }
  exclusiveStartKey = page.LastEvaluatedKey;
} while (exclusiveStartKey);

console.log(`${dryRun ? "[dry-run] would delete" : "deleted"} ${deleted} ghost projection item(s) from ${projectionsTable} (${kept} account item(s) kept)`);
