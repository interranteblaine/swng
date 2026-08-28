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
// Map. `conditionHolds` below evaluates each `AND`-joined clause of a ConditionExpression against
// the three shapes this file's conditions are ever built from — `attribute_exists(attr)`,
// `attribute_not_exists(attr)`, and `attr > :value` — rather than special-casing whole condition
// strings; that generality is load-bearing (review round 1, Task 14): a whole-string special case
// for "attribute_exists(pk) AND expiresAtMs > :now" stayed green when retireHandle grew a THIRD
// clause (`attribute_not_exists(retiredAtMs)`) whose absence was exactly the bug. It is still not
// a full DynamoDB expression parser (no OR, no nested parens, no arbitrary comparators) — just
// enough to evaluate every clause this store actually writes.
// `src/contract/oauthStore.contract.test.ts` (test:contract, not run here) is what proves this
// fake's conditional semantics agree with the real service, including under genuine concurrency
// a synchronous fake can never exercise.
const createFakeDocumentClient = (): DynamoDBDocumentClient => {
  const table = new Map<string, Record<string, unknown>>();

  // One clause of a ConditionExpression, evaluated against the item and the command's
  // ExpressionAttributeValues. `item` may be undefined (no item at that pk).
  const clauseHolds = (item: Record<string, unknown> | undefined, clause: string, values: Record<string, unknown> | undefined): boolean => {
    const existsMatch = /^attribute_exists\(([\w#]+)\)$/.exec(clause);
    if (existsMatch) return item !== undefined && item[existsMatch[1]!] !== undefined;

    const notExistsMatch = /^attribute_not_exists\(([\w#]+)\)$/.exec(clause);
    if (notExistsMatch) return item === undefined || item[notExistsMatch[1]!] === undefined;

    const gtMatch = /^(\w+) > (:\w+)$/.exec(clause);
    if (gtMatch) {
      if (item === undefined) return false;
      const actual = item[gtMatch[1]!];
      const bound = values?.[gtMatch[2]!];
      return typeof actual === "number" && typeof bound === "number" && actual > bound;
    }

    throw new Error(`fake document client: unrecognized condition clause "${clause}" — teach clauseHolds this shape`);
  };

  const conditionHolds = (item: Record<string, unknown> | undefined, conditionExpression: string, values: Record<string, unknown> | undefined): boolean =>
    conditionExpression
      .split(" AND ")
      .map((clause) => clause.trim())
      .every((clause) => clauseHolds(item, clause, values));

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
        const values = command.input.ExpressionAttributeValues;
        if (condition && !conditionHolds(item, condition, values)) fail(`conditional delete failed for ${pk}`);
        table.delete(pk);
        return command.input.ReturnValues === "ALL_OLD" ? { Attributes: item ? { ...item } : undefined } : {};
      }
      if (command instanceof UpdateCommand) {
        const pk = command.input.Key!.pk as string;
        const item = table.get(pk);
        const condition = command.input.ConditionExpression;
        const values = command.input.ExpressionAttributeValues;
        if (condition && !conditionHolds(item, condition, values)) fail(`conditional update failed for ${pk}`);
        // Only the three attributes this store's UpdateExpression ever sets — a general
        // UpdateExpression parser would be scope creep this fake doesn't need. retiredAtMs is
        // undefined for every SET this file issues except retireHandle's, which is exactly the
        // one that needs it read back by clauseHolds's attribute_not_exists check above.
        table.set(pk, {
          ...item,
          expiresAtMs: values?.[":expiresAtMs"],
          ttl: values?.[":ttl"],
          ...(values && ":retiredAtMs" in values ? { retiredAtMs: values[":retiredAtMs"] } : {}),
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

    // Review round 1 finding: the first version of retireHandle re-armed a fresh 30s window on
    // EVERY call, so retiring on each use of an already-retired handle kept it alive forever —
    // exactly the failure mode the grace window exists to bound. The fix is a `retiredAtMs`
    // marker that lets only the FIRST retire succeed; this proves the second one is a true
    // no-op, not merely "didn't error."
    it("a second retire before the grace window elapses does not extend it", async () => {
      await store.putHandle("h1", handle); // expiresAtMs = start + 30d
      await store.retireHandle("h1"); // FIRST retire fixes expiresAtMs = start + 30s
      clock.advance(20_000); // 20s later, still well inside the first retire's window
      await store.retireHandle("h1"); // SECOND retire — must be a no-op, not a fresh +30s

      // Without the fix, the second retire would have pushed expiresAtMs to 20s + 30s = 50s from
      // start; advancing to 30_001ms (past the CORRECT deadline, short of the buggy one) proves
      // which one actually happened.
      clock.advance(10_001); // total 30_001ms since the first retire
      await expect(store.getHandle("h1")).resolves.toBeUndefined();
    });
  });
});
