import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "@swng/application";
import { CODE_TTL_MS, createDynamoOAuthStore, HANDLE_GRACE_MS, HANDLE_TTL_MS, REQUEST_TTL_MS } from "./createDynamoOAuthStore.js";

// This is the ONE test file in the package that fakes the DynamoDBDocumentClient instead of
// running against DynamoDB Local (testing/local.ts, src/contract/*). Deliberately so (controller
// constraint carried into Task 14's dispatch): the expiry / single-use / grace-window logic is
// the whole point of this store, and `pnpm test:contract` needs Java and is NOT part of
// `pnpm validate` — a store whose only coverage of that logic was a contract test would ship its
// most subtle behavior outside the gate this arc actually runs. So this fake exists to let that
// logic run hermetically, under `pnpm validate`, with an injected clock instead of a sleep.
//
// It implements exactly the four commands createDynamoOAuthStore.ts issues (Put/Get/Delete with
// ConditionExpression + ReturnValues, Update with ConditionExpression) against a plain in-memory
// Map, replicating DynamoDB's OWN conditional-write semantics for the two specific conditions
// this file writes: `attribute_exists(pk)` and `expiresAtMs > :now` — not a general expression
// evaluator. `src/contract/oauthStore.contract.test.ts` (test:contract, not run here) is what
// proves those two conditions behave the same way against the real service.
const createFakeDocumentClient = (): DynamoDBDocumentClient => {
  const table = new Map<string, Record<string, unknown>>();

  const conditionHolds = (item: Record<string, unknown> | undefined, conditionExpression: string, now: unknown): boolean => {
    if (item === undefined) return false;
    if (conditionExpression.includes("expiresAtMs > :now")) {
      return typeof item.expiresAtMs === "number" && typeof now === "number" && item.expiresAtMs > now;
    }
    return true; // attribute_exists(pk) alone — item presence already checked above
  };

  const fail = (message: string): never => {
    throw new ConditionalCheckFailedException({ message, $metadata: {} });
  };

  return {
    send: (async (command: unknown) => {
      if (command instanceof PutCommand) {
        const { Item } = command.input;
        table.set(Item!.pk as string, { ...Item });
        return {};
      }
      if (command instanceof GetCommand) {
        const item = table.get(command.input.Key!.pk as string);
        return { Item: item ? { ...item } : undefined };
      }
      if (command instanceof DeleteCommand) {
        const pk = command.input.Key!.pk as string;
        const item = table.get(pk);
        const condition = command.input.ConditionExpression;
        const now = command.input.ExpressionAttributeValues?.[":now"];
        if (condition && !conditionHolds(item, condition, now)) fail(`conditional delete failed for ${pk}`);
        table.delete(pk);
        return command.input.ReturnValues === "ALL_OLD" ? { Attributes: item ? { ...item } : undefined } : {};
      }
      if (command instanceof UpdateCommand) {
        const pk = command.input.Key!.pk as string;
        const item = table.get(pk);
        const condition = command.input.ConditionExpression;
        const now = command.input.ExpressionAttributeValues?.[":now"];
        if (condition && !conditionHolds(item, condition, now)) fail(`conditional update failed for ${pk}`);
        // Only the two attributes this store's UpdateExpression ever sets — a general
        // UpdateExpression parser would be scope creep this fake doesn't need.
        table.set(pk, {
          ...item,
          expiresAtMs: command.input.ExpressionAttributeValues?.[":expiresAtMs"],
          ttl: command.input.ExpressionAttributeValues?.[":ttl"],
        });
        return {};
      }
      throw new Error(`fake document client: unhandled command ${command?.constructor?.name}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  } as unknown as DynamoDBDocumentClient;
};

const createFakeClock = (startMs: number): Clock & { advance: (ms: number) => void } => {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

interface Grant {
  readonly sub: string;
}
const parseGrant = (raw: unknown): Grant => {
  if (typeof raw !== "object" || raw === null || typeof (raw as { sub: unknown }).sub !== "string") {
    throw new Error("invalid grant");
  }
  return { sub: (raw as { sub: string }).sub };
};

interface RequestRecord {
  readonly clientId: string;
}
const parseRequest = (raw: unknown): RequestRecord => {
  if (typeof raw !== "object" || raw === null || typeof (raw as { clientId: unknown }).clientId !== "string") {
    throw new Error("invalid request");
  }
  return { clientId: (raw as { clientId: string }).clientId };
};

interface ClientRecord {
  readonly redirectUris: readonly string[];
}
const parseClient = (raw: unknown): ClientRecord => raw as ClientRecord;

interface HandleRecord {
  readonly refreshToken: string;
}
const parseHandle = (raw: unknown): HandleRecord => raw as HandleRecord;

describe("createDynamoOAuthStore", () => {
  let clock: ReturnType<typeof createFakeClock>;
  let store: ReturnType<typeof createDynamoOAuthStore<ClientRecord, RequestRecord, Grant, HandleRecord>>;

  beforeEach(() => {
    clock = createFakeClock(1_000_000);
    store = createDynamoOAuthStore({
      client: createFakeDocumentClient(),
      tableName: "oauth-test",
      clock,
      parseClient,
      parseRequest,
      parseCodeGrant: parseGrant,
      parseHandle,
    });
  });

  describe("takeCode", () => {
    const grant: Grant = { sub: "golfer-1" };

    it("returns the grant once", async () => {
      await store.putCode("c1", grant);
      await expect(store.takeCode("c1")).resolves.toEqual(grant);
    });

    it("is single-use — a second take returns undefined", async () => {
      await store.putCode("c1", grant);
      await store.takeCode("c1");
      await expect(store.takeCode("c1")).resolves.toBeUndefined();
    });

    it("refuses an expired code even when the item still exists", async () => {
      await store.putCode("c1", grant); // 60s
      clock.advance(CODE_TTL_MS + 1);
      await expect(store.takeCode("c1")).resolves.toBeUndefined();
    });

    it("returns undefined for a code that was never put", async () => {
      await expect(store.takeCode("missing")).resolves.toBeUndefined();
    });

    it("is still redeemable one millisecond before it expires", async () => {
      await store.putCode("c1", grant);
      clock.advance(CODE_TTL_MS - 1);
      await expect(store.takeCode("c1")).resolves.toEqual(grant);
    });
  });

  describe("takeRequest", () => {
    const request: RequestRecord = { clientId: "client-1" };

    it("returns the request once", async () => {
      await store.putRequest("r1", request);
      await expect(store.takeRequest("r1")).resolves.toEqual(request);
    });

    it("is single-use — a second take returns undefined", async () => {
      await store.putRequest("r1", request);
      await store.takeRequest("r1");
      await expect(store.takeRequest("r1")).resolves.toBeUndefined();
    });

    it("refuses an expired request even when the item still exists", async () => {
      await store.putRequest("r1", request); // 10m
      clock.advance(REQUEST_TTL_MS + 1);
      await expect(store.takeRequest("r1")).resolves.toBeUndefined();
    });
  });

  describe("client", () => {
    const record: ClientRecord = { redirectUris: ["https://example.com/cb"] };

    it("round-trips", async () => {
      await store.putClient("client-1", record);
      await expect(store.getClient("client-1")).resolves.toEqual(record);
    });

    it("returns undefined once past its 90-day expiry, item or no item", async () => {
      await store.putClient("client-1", record);
      clock.advance(90 * 24 * 60 * 60 * 1000 + 1);
      await expect(store.getClient("client-1")).resolves.toBeUndefined();
    });
  });

  describe("handle", () => {
    const handle: HandleRecord = { refreshToken: "cognito-refresh-1" };

    it("round-trips", async () => {
      await store.putHandle("h1", handle);
      await expect(store.getHandle("h1")).resolves.toEqual(handle);
    });

    it("expires after 30 days even though the item still exists", async () => {
      await store.putHandle("h1", handle);
      clock.advance(HANDLE_TTL_MS + 1);
      await expect(store.getHandle("h1")).resolves.toBeUndefined();
    });

    it("a retired handle is readable inside its 30s grace window", async () => {
      await store.putHandle("h1", handle);
      await store.retireHandle("h1");
      clock.advance(HANDLE_GRACE_MS - 1);
      await expect(store.getHandle("h1")).resolves.toEqual(handle);
    });

    it("a retired handle is gone once its grace window passes", async () => {
      await store.putHandle("h1", handle);
      await store.retireHandle("h1");
      clock.advance(HANDLE_GRACE_MS + 1);
      await expect(store.getHandle("h1")).resolves.toBeUndefined();
    });

    it("retiring an already-expired handle does not resurrect it", async () => {
      await store.putHandle("h1", handle);
      clock.advance(HANDLE_TTL_MS + 1); // now actually expired, but the fake never physically deletes it
      await store.retireHandle("h1"); // must be a no-op, not a fresh 30s window
      clock.advance(1);
      await expect(store.getHandle("h1")).resolves.toBeUndefined();
    });

    it("retiring an unknown handle is a no-op, not a throw", async () => {
      await expect(store.retireHandle("never-existed")).resolves.toBeUndefined();
    });
  });
});
