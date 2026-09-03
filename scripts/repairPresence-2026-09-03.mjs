// One-time prod repair for the 2026-09-03 ticket (round 4b0b6249, St. Georges).
//
// The presence TTL, anchored to SEAT time, deleted Michael's pointer at 2026-09-03 08:14Z —
// 36h before the round he booked is even played. Dr. Beeper's row still carries a `ttl` of
// 2026-09-04 03:28Z and Blaine's 2026-09-05 10:12Z; the code fix stops NEW rows carrying the
// attribute but does not rewrite rows that already have it, so both would still be swept.
//
// This rewrites all three rows in the exact shape createDynamoProjectionStore.putLive now
// writes — `live` map, no `ttl` — recreating Michael's and stripping the attribute from the
// other two. `joinedAtMs` is each golfer's real seat time, read from the round's own log, so
// the home list orders them exactly as it would have.
//
// Idempotent: a plain Put per row, keyed by (golferId, roundId). Safe to re-run.
//
// Usage: AWS_PROFILE=swng node scripts/repairPresence-2026-09-03.mjs [--apply]
//        (dry-run by default — prints what it would write and touches nothing)

import { createRequire } from "node:module";

// Same SDK resolution every other script here uses (scripts/migrateProdStrokes.mjs): resolve
// from the adapter package that actually depends on it, not from the repo root.
const require = createRequire(new URL("../packages/adapters-dynamodb/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
// GetCommand to read back, PutCommand to write. Nothing that deletes is imported, so nothing
// that deletes can be called.
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE = "swng-projections-prod";
const ROUND_ID = "4b0b6249-f691-48ac-a14c-e587096d9ba1";
const COURSE_NAME = "St. Georges, Setauket, NY";

// golferId -> that golfer's own seat time on this round (the participant-joined hlc wallMs).
const SEATS = [
  { golferId: "e19113e0-db76-4b51-90f2-2945d7788f6d", name: "Michael", joinedAtMs: 1788293680749 },
  { golferId: "767b104e-087d-4fa2-9947-718171904d32", name: "Dr. Beeper", joinedAtMs: 1788362916549 },
  { golferId: "facc2215-df17-4e01-9cdd-e9333389c49e", name: "Blaine", joinedAtMs: 1788473521259 },
];

const apply = process.argv.includes("--apply");
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const key = (golferId) => ({ pk: `GOLFER#${golferId}`, sk: `LIVE#${ROUND_ID}` });

for (const seat of SEATS) {
  const before = await client.send(new GetCommand({ TableName: TABLE, Key: key(seat.golferId) }));
  const had = before.Item ? (before.Item.ttl ? `present, ttl=${new Date(before.Item.ttl * 1000).toISOString()}` : "present, no ttl") : "MISSING";
  console.log(`${seat.name.padEnd(10)} before: ${had}`);

  if (!apply) continue;

  await client.send(
    new PutCommand({
      TableName: TABLE,
      // Exactly putLive's shape — no `ttl`, so DynamoDB's sweep never touches it again.
      Item: { ...key(seat.golferId), live: { roundId: ROUND_ID, courseName: COURSE_NAME, joinedAtMs: seat.joinedAtMs } },
    }),
  );

  const after = await client.send(new GetCommand({ TableName: TABLE, Key: key(seat.golferId) }));
  const ok = after.Item && after.Item.ttl === undefined;
  console.log(`${seat.name.padEnd(10)} after:  ${ok ? "present, no ttl ✓" : "UNEXPECTED — inspect manually"}`);
}

console.log(apply ? "\nDone." : "\nDry run — nothing written. Re-run with --apply.");
