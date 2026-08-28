import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Clock } from "@swng/application";
import { oauthClientPk, oauthCodePk, oauthHandlePk, oauthRequestPk } from "./keys.js";

// The OAuth mediation store (swng-speaks-mcp design §4.3, Task 14) — the short-lived state that
// makes "Cognito stays the only token issuer; mcp.swng.golf mediates" work: registered DCR
// clients (90d), recorded /authorize requests (10m, single-use), opaque authorization codes
// (60s, single-use), and opaque refresh handles (30d, 30s rotation grace).
//
// THE BUG THIS FILE EXISTS TO PREVENT: DynamoDB's `ttl` attribute is cleanup, not expiry — AWS
// deletes an expired item "typically within 48 hours," with no guarantee about *when*. A
// 60-second code whose only expiry is `ttl` would stay redeemable for hours. So every read here
// compares an explicit `expiresAtMs` against an INJECTED clock, never trusting the item's mere
// presence — `ttl` is written purely for storage hygiene and nothing in this file reads it back.
//
// SINGLE-USE: `takeRequest`/`takeCode` are a conditional DELETE with `ReturnValues: ALL_OLD`,
// conditioned on `attribute_exists(pk) AND expiresAtMs > :now` — one atomic round-trip that
// covers "missing", "expired", and "two concurrent redemptions" all at once. DynamoDB itself
// arbitrates a race between two concurrent takes: at most one delete's condition can see the
// item still present, so at most one can ever return it. A read-then-delete would not have that
// guarantee, which is why this is not written as one.
//
// THE GRACE WINDOW: `retireHandle` does not delete or mark anything — it SHRINKS the handle's own
// `expiresAtMs` to `now + HANDLE_GRACE_MS`. `getHandle` then needs no special "retired" state at
// all: it is the exact same expiry comparison every other read makes. Retiring an already-expired
// (but still physically present) handle is refused by the same `expiresAtMs > :now` condition, so
// retirement can never resurrect a handle that's actually gone.

const DAY_MS = 24 * 60 * 60 * 1000;
export const CLIENT_TTL_MS = 90 * DAY_MS;
export const REQUEST_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
export const HANDLE_TTL_MS = 30 * DAY_MS;
export const HANDLE_GRACE_MS = 30 * 1000;

export interface OAuthStore<TClient, TRequest, TCodeGrant, THandle> {
  putClient(clientId: string, value: TClient): Promise<void>;
  getClient(clientId: string): Promise<TClient | undefined>;

  putRequest(requestId: string, value: TRequest): Promise<void>;
  takeRequest(requestId: string): Promise<TRequest | undefined>;

  putCode(code: string, value: TCodeGrant): Promise<void>;
  takeCode(code: string): Promise<TCodeGrant | undefined>;

  putHandle(handleId: string, value: THandle): Promise<void>;
  getHandle(handleId: string): Promise<THandle | undefined>;
  retireHandle(handleId: string): Promise<void>;
}

// The envelope every item is wrapped in — `value` is the caller's opaque payload (a client
// record, a recorded request, a code grant, a handle payload), never interpreted here. `parse*`
// below is how each value comes back typed (CLAUDE.md: "a type must not assert what the read
// path cannot guarantee — parse stored data, never cast it") — this file owns parsing the
// envelope itself; the caller owns parsing what's inside `value`.
interface StoredEnvelope {
  readonly pk: string;
  readonly value: unknown;
  readonly expiresAtMs: number;
}

const parseEnvelope = (context: string, input: unknown): StoredEnvelope => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("pk" in input) ||
    typeof (input as { pk: unknown }).pk !== "string" ||
    !("expiresAtMs" in input) ||
    typeof (input as { expiresAtMs: unknown }).expiresAtMs !== "number" ||
    !("value" in input)
  ) {
    throw new Error(`oauth store: stored item at ${context} does not match the envelope shape (pk: string, value, expiresAtMs: number)`);
  }
  const envelope = input as { pk: string; value: unknown; expiresAtMs: number };
  return { pk: envelope.pk, value: envelope.value, expiresAtMs: envelope.expiresAtMs };
};

export const createDynamoOAuthStore = <TClient, TRequest, TCodeGrant, THandle>(config: {
  client: DynamoDBDocumentClient;
  tableName: string;
  clock: Clock;
  parseClient: (raw: unknown) => TClient;
  parseRequest: (raw: unknown) => TRequest;
  parseCodeGrant: (raw: unknown) => TCodeGrant;
  parseHandle: (raw: unknown) => THandle;
}): OAuthStore<TClient, TRequest, TCodeGrant, THandle> => {
  const { client, tableName, clock, parseClient, parseRequest, parseCodeGrant, parseHandle } = config;

  const put = async (pk: string, value: unknown, ttlMs: number): Promise<void> => {
    const expiresAtMs = clock.now() + ttlMs;
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk, value, expiresAtMs, ttl: Math.floor(expiresAtMs / 1000) },
      }),
    );
  };

  // A plain read whose only additional job is the explicit expiry comparison — see the file
  // header. Does NOT delete an expired-but-present item; TTL cleanup is left to do that on its
  // own schedule, exactly as it would with or without this comparison.
  const get = async <T>(pk: string, parse: (raw: unknown) => T): Promise<T | undefined> => {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk } }));
    if (!result.Item) return undefined;
    const envelope = parseEnvelope(pk, result.Item);
    if (envelope.expiresAtMs <= clock.now()) return undefined;
    return parse(envelope.value);
  };

  // The single-use primitive both `takeRequest` and `takeCode` share — see the file header for
  // why this is one conditional delete rather than a read followed by a delete.
  const take = async <T>(pk: string, parse: (raw: unknown) => T): Promise<T | undefined> => {
    try {
      const result = await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { pk },
          ConditionExpression: "attribute_exists(pk) AND expiresAtMs > :now",
          ExpressionAttributeValues: { ":now": clock.now() },
          ReturnValues: "ALL_OLD",
        }),
      );
      if (!result.Attributes) return undefined; // defensive — ALL_OLD always carries Attributes when the condition passes
      const envelope = parseEnvelope(pk, result.Attributes);
      return parse(envelope.value);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return undefined; // missing OR expired — both read as "not redeemable"
      throw error;
    }
  };

  return {
    putClient: (clientId, value) => put(oauthClientPk(clientId), value, CLIENT_TTL_MS),
    getClient: (clientId) => get(oauthClientPk(clientId), parseClient),

    putRequest: (requestId, value) => put(oauthRequestPk(requestId), value, REQUEST_TTL_MS),
    takeRequest: (requestId) => take(oauthRequestPk(requestId), parseRequest),

    putCode: (code, value) => put(oauthCodePk(code), value, CODE_TTL_MS),
    takeCode: (code) => take(oauthCodePk(code), parseCodeGrant),

    putHandle: (handleId, value) => put(oauthHandlePk(handleId), value, HANDLE_TTL_MS),
    getHandle: (handleId) => get(oauthHandlePk(handleId), parseHandle),

    // Shrinks expiresAtMs to a fresh HANDLE_GRACE_MS window rather than writing any "retired"
    // flag — getHandle needs no separate code path, it's the same expiry comparison every read
    // makes. Conditioned on the SAME "attribute_exists(pk) AND expiresAtMs > :now" as `take`
    // (not just attribute_exists) so retiring a handle that has already expired — physically
    // present only because TTL cleanup hasn't run yet — is refused rather than resurrecting it
    // with a brand-new 30-second window.
    retireHandle: async (handleId) => {
      const nowMs = clock.now();
      const expiresAtMs = nowMs + HANDLE_GRACE_MS;
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: oauthHandlePk(handleId) },
            UpdateExpression: "SET expiresAtMs = :expiresAtMs, ttl = :ttl",
            ConditionExpression: "attribute_exists(pk) AND expiresAtMs > :now",
            ExpressionAttributeValues: { ":expiresAtMs": expiresAtMs, ":ttl": Math.floor(expiresAtMs / 1000), ":now": nowMs },
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return; // already gone (or already expired) — nothing to retire
        throw error;
      }
    },
  };
};
