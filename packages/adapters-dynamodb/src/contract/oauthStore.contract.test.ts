import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "@swng/application";
import { createDynamoOAuthStore } from "../createDynamoOAuthStore.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite for createDynamoOAuthStore.ts (swng-speaks-mcp design §4.3, Task 14). The
// module's own hermetic unit test (createDynamoOAuthStore.test.ts, `pnpm validate`) proves the
// time-dependent logic — explicit expiresAtMs comparison, single-use, the retire grace window —
// against a hand-rolled in-memory fake of the DynamoDBDocumentClient's four commands. This suite
// is what that fake's assumptions have to answer to: it proves the SAME store against a real
// DynamoDB Local, specifically the one thing a synchronous in-memory fake structurally cannot —
// that a genuine race between two concurrent conditional deletes lets exactly one through. Not
// part of `pnpm validate`; run via `pnpm test:contract`.
//
// Reuses the snapshots table's schema (pk-only, no sort key, no GSI — testing/local.ts) rather
// than standing up a dedicated table: createDynamoOAuthStore.ts only ever addresses items by
// `Key: { pk }`, so any pk-only table is a faithful stand-in for the eventual dedicated OAuth
// table a later infra task adds.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const systemClock: Clock = { now: () => Date.now() };

interface Grant {
  readonly sub: string;
}
const parseGrant = (raw: unknown): Grant => {
  if (typeof raw !== "object" || raw === null || typeof (raw as { sub: unknown }).sub !== "string") throw new Error("invalid grant");
  return { sub: (raw as { sub: string }).sub };
};

const newStore = () =>
  createDynamoOAuthStore({
    client: local.client,
    tableName: local.snapshotsTable,
    clock: systemClock,
    parseClient: (raw) => raw as { redirectUris: readonly string[] },
    parseRequest: (raw) => raw as { clientId: string },
    parseCodeGrant: parseGrant,
    parseHandle: (raw) => raw as { refreshToken: string },
  });

describe("createDynamoOAuthStore (real DynamoDB)", () => {
  it("putCode + takeCode round-trips the grant", async () => {
    const store = newStore();
    const code = randomUUID();
    const grant: Grant = { sub: `golfer-${randomUUID()}` };

    await store.putCode(code, grant);
    await expect(store.takeCode(code)).resolves.toEqual(grant);
  });

  it("is single-use — a second take against real DynamoDB returns undefined", async () => {
    const store = newStore();
    const code = randomUUID();
    await store.putCode(code, { sub: "golfer-1" });

    await store.takeCode(code);
    await expect(store.takeCode(code)).resolves.toBeUndefined();
  });

  it("a genuine race between two concurrent takes lets exactly one through", async () => {
    const store = newStore();
    const code = randomUUID();
    await store.putCode(code, { sub: "golfer-1" });

    const [a, b] = await Promise.all([store.takeCode(code), store.takeCode(code)]);
    const winners = [a, b].filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);
  });

  it("putRequest + takeRequest round-trips and is single-use", async () => {
    const store = newStore();
    const requestId = randomUUID();
    await store.putRequest(requestId, { clientId: "client-1" });

    await expect(store.takeRequest(requestId)).resolves.toEqual({ clientId: "client-1" });
    await expect(store.takeRequest(requestId)).resolves.toBeUndefined();
  });

  it("putClient + getClient round-trips (non-single-use, plain read)", async () => {
    const store = newStore();
    const clientId = randomUUID();
    await store.putClient(clientId, { redirectUris: ["https://example.com/cb"] });

    await expect(store.getClient(clientId)).resolves.toEqual({ redirectUris: ["https://example.com/cb"] });
    // A plain get is not single-use — reading it again must still succeed.
    await expect(store.getClient(clientId)).resolves.toEqual({ redirectUris: ["https://example.com/cb"] });
  });

  it("putHandle + getHandle round-trips, and retireHandle leaves it readable until the grace window really elapses", async () => {
    const store = newStore();
    const handleId = randomUUID();
    await store.putHandle(handleId, { refreshToken: "cognito-refresh-1" });

    await store.retireHandle(handleId);
    // Immediately after retiring, still inside the 30s grace window against real wall time.
    await expect(store.getHandle(handleId)).resolves.toEqual({ refreshToken: "cognito-refresh-1" });
  }, 15_000);

  // Review round 1 finding: the first version of retireHandle re-armed a fresh 30s window on
  // every call — retiring on each use of an already-retired handle kept it alive forever. Proven
  // here against REAL wall time (the hermetic suite proves the same invariant against a fake
  // clock): the second retire, issued 5s after the first, must NOT push expiry to (5s + 30s) =
  // 35s from the first retire. It waits to 31s — past the correct (30s) deadline, short of the
  // buggy (35s) one — so a flip to defined there would mean the bug is back.
  it("a second retire while still inside the grace window does not extend it (real DynamoDB)", async () => {
    const store = newStore();
    const handleId = randomUUID();
    await store.putHandle(handleId, { refreshToken: "cognito-refresh-1" });

    await store.retireHandle(handleId); // first retire — fixes expiry at (now + 30s)
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await store.retireHandle(handleId); // second retire, still well inside the window — must be a no-op

    await new Promise((resolve) => setTimeout(resolve, 26_000)); // total 31s since the FIRST retire
    await expect(store.getHandle(handleId)).resolves.toBeUndefined();
  }, 45_000);
});
