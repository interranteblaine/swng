import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "@swng/application";
import type { OAuthStore } from "@swng/adapters-dynamodb";
import type { AuthorizeCodeGrant, AuthorizeCognitoConfig } from "./authorize.js";
import { isFormUrlEncoded, opaqueIdSchema, storeKeyStringSchema } from "./authorize.js";

// POST /token — where the opaque codes `/authorize` mints get redeemed (design spec §4.3 step 4,
// Task 18). swng MEDIATES: this endpoint issues no JWT of its own, it hands back the access
// token COGNITO issued for the grant, wrapped only in an opaque refresh handle of ours.
//
// WHAT "EVERY FAILURE ANSWERS invalid_grant" DOES AND DOES NOT COVER (review round 2, N-3): it is
// a statement about the REQUEST — every way a caller can present a bad or spent credential is an
// `invalid_grant`. It is not a statement about the STORE. A DynamoDB error, or a stored record
// that fails its parser on the way out, throws through this module to the entry's error boundary
// and answers 5xx, deliberately: those are server-side faults, not the caller's, and answering
// `invalid_grant` to a throttle would make a client discard a perfectly good refresh handle. An
// attacker cannot author those records — the only writers are /authorize and this file.
//
// TWO GRANT TYPES, one rule about failure. `authorization_code` verifies the PKCE verifier,
// `client_id` and `redirect_uri` against the STORED grant, then returns Cognito's access token
// plus a fresh handle. `refresh_token` redeems a handle, calls Cognito's refresh grant with the
// Cognito refresh token that handle wraps, ROTATES the handle, and returns the new access token.
// Every failure — malformed envelope, unknown grant type, PKCE mismatch, replay, wrong client,
// upstream refusal — answers `invalid_grant`, never `invalid_request` and never a custom code:
// spec §4.3 step 4, "Claude keys its recovery on that exact code," and a client that gets an
// unexpected error code sits there re-presenting a credential that will never work again.
//
// WHY THE HANDLE IS OURS AND NOT COGNITO'S (spec §4.3, "Why wrap the refresh token"): Cognito's
// refresh token is bound to our CONFIDENTIAL app client and useless without the secret we hold,
// so passing it through would not be an immediate vulnerability — but it would put a Cognito
// credential outside our control, with no rotation and no revocation, and OAuth 2.1 requires
// rotation for public clients, which every CIMD/DCR client here is.
//
// THE GRACE WINDOW IS THE STORE'S, NOT THIS FILE'S. Rotation here is exactly
// `retireHandle(presented)` + `putHandle(fresh)`. `retireHandle` (createDynamoOAuthStore.ts)
// SHRINKS the retired handle's own `expiresAtMs` to `now + HANDLE_GRACE_MS` and stamps
// `retiredAtMs` so only the first retire ever takes effect; `getHandle` then applies the same
// ordinary expiry comparison every other read makes. Nothing in this file bookkeeps a grace
// window — a second copy of that rule is how the two drift apart.

// ---------------------------------------------------------------------------------------------
// Stored record + the narrow store slice
// ---------------------------------------------------------------------------------------------

// What an opaque refresh handle actually holds. `approvedScopes` is carried for BINDING and
// AUDIT — it is what the golfer approved at consent — and is deliberately never echoed back to
// the client (see `tokenResponse`).
export interface RefreshHandleRecord {
  readonly clientId: string;
  readonly approvedScopes: readonly string[];
  readonly cognitoRefreshToken: string;
}

// Same idiom as `ClientStore` (clients.ts) and `AuthorizeStore` (authorize.ts): the narrow slice
// of Task 14's `OAuthStore` this module needs, typed against the concrete records it stores.
export type TokenStore = Pick<
  OAuthStore<unknown, unknown, AuthorizeCodeGrant, RefreshHandleRecord>,
  "takeCode" | "putHandle" | "getHandle" | "retireHandle"
>;

export interface TokenDeps {
  readonly store: TokenStore;
  readonly cognito: AuthorizeCognitoConfig;
  // Injected, not `Date.now()`: `expires_in` is derived against it (see `expiresInSecondsOf`),
  // which is the one place this endpoint reads a wall clock at all — the store owns every
  // record's own expiry against its own injected clock.
  readonly clock: Clock;
  readonly fetchImpl?: typeof fetch; // injected so `pnpm validate` stays offline
  readonly generateId?: () => string; // the opaque refresh handle — default randomUUID
}

// The `parseHandle` half of `createDynamoOAuthStore`'s four injected parsers — CLAUDE.md: "parse
// stored data, never cast it." Same style as `parseStoredClientRecord` (clients.ts) and the two
// parsers in authorize.ts: plain shape checks, a named error per failed field, and NO bounds
// ("bounds go on request schemas only, never on a stored/read/fold schema").
export const parseStoredRefreshHandle = (raw: unknown): RefreshHandleRecord => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("stored OAuth refresh handle is not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.clientId !== "string") {
    throw new Error("stored OAuth refresh handle: clientId missing or not a string");
  }
  if (!Array.isArray(obj.approvedScopes) || !obj.approvedScopes.every((scope) => typeof scope === "string")) {
    throw new Error("stored OAuth refresh handle: approvedScopes missing or not a string[]");
  }
  if (typeof obj.cognitoRefreshToken !== "string") {
    throw new Error("stored OAuth refresh handle: cognitoRefreshToken missing or not a string");
  }
  return {
    clientId: obj.clientId,
    approvedScopes: obj.approvedScopes as string[],
    cognitoRefreshToken: obj.cognitoRefreshToken,
  };
};

// ---------------------------------------------------------------------------------------------
// Request schemas — the ONE place in this file bounds belong (CLAUDE.md: "bounds go on request
// schemas only, never on a stored/read/fold schema"), because every field here is
// attacker-controlled and two of them are used as DynamoDB partition keys.
//
// `code` and `refresh_token` are values WE minted (`randomUUID`, 36 characters), so they get
// `opaqueIdSchema`'s tight 128 rather than a byte computation — review round 2, N-1: the
// `max(2048)` that stood here counted UTF-16 code units while the key is capped in BYTES, and a
// 2039-character `code` threw an uncaught `ValidationException` out of this endpoint. `client_id`
// is the caller's own and legitimately long (a CIMD client_id is a URL), so it is measured in
// bytes against the store's published budget. Both schemas live in authorize.ts, shared with
// /authorize, which keys on the same class of value. `redirect_uri` is COMPARED, never keyed, so
// a plain character cap is the right bound for it.
//
// `code_verifier`'s 43–128 is RFC 7636 §4.1's own range — review round 1, M-9: a one-character
// verifier was accepted before this. Length only, deliberately, NOT §4.1's `[A-Za-z0-9-._~]`
// charset: refusing a padded or otherwise off-alphabet verifier that still hashes correctly would
// be an interop break with no security gain, since the challenge comparison is what decides.
//
// Parsing happens BEFORE the store is touched, so a malformed request never burns a code, never
// reads a handle, and never reaches Cognito.
// ---------------------------------------------------------------------------------------------

const authorizationCodeRequestSchema = z.object({
  code: opaqueIdSchema,
  client_id: storeKeyStringSchema,
  redirect_uri: z.string().min(1).max(2048),
  code_verifier: z.string().min(43).max(128),
});

const refreshRequestSchema = z.object({
  refresh_token: opaqueIdSchema,
  client_id: storeKeyStringSchema,
});

const AUTHORIZATION_CODE_KEYS = ["code", "client_id", "redirect_uri", "code_verifier"] as const;
const REFRESH_KEYS = ["refresh_token", "client_id"] as const;

// A present-keys-only record, so an ABSENT field fails the schema as "required" rather than
// arriving as an empty string that some later comparison happens to reject.
const presentFields = (form: URLSearchParams, keys: readonly string[]): Record<string, string> => {
  const raw: Record<string, string> = {};
  for (const key of keys) {
    const value = form.get(key);
    if (value !== null) raw[key] = value;
  }
  return raw;
};

// ---------------------------------------------------------------------------------------------
// Responses. RFC 6749 §5.1 requires `Cache-Control: no-store` and `Pragma: no-cache` on any
// response carrying tokens; both are set on the error responses too rather than remembered per
// branch.
// ---------------------------------------------------------------------------------------------

const TOKEN_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

// The ONE error this endpoint speaks. `error_description` is a FIXED string at every call site —
// it names which check failed, for a human reading a log, and never interpolates anything the
// caller sent (which is why no branch below builds one with a template literal).
const invalidGrant = (description: string): Response =>
  new Response(JSON.stringify({ error: "invalid_grant", error_description: description }), {
    status: 400,
    headers: { ...TOKEN_HEADERS },
  });

// NO `scope` IN THIS BODY, DELIBERATELY. The obvious thing to put there is the grant's
// `approvedScopes` — and that is a CLAIM fixed back at consent/step-up time, never reconciled
// against the scope Cognito actually issued the token for (`exchangeCognitoCode` discards the
// Cognito response's own `scope`). Today that mismatch is harmless because the resource server's
// authority is the TOKEN, not our record; it stops being harmless the moment this endpoint
// publishes the record to the client as truth. RFC 6749 §5.1 makes `scope` OPTIONAL when the
// granted scope matches the request, and the client already holds the token that says what it
// really got. `expires_in` IS reported, and is the counter-example that shows where the line is:
// it is not a claim of OURS about the grant, it is read straight off the access token being handed
// over — see `expiresInSecondsOf`, and note that both grant types report it the same way, because
// a body that changes shape between two calls the client treats alike is its own kind of lie.
const tokenResponse = (cognitoAccessToken: string, refreshHandle: string | undefined, expiresInSeconds: number | undefined): Response => {
  const body: Record<string, string | number> = { access_token: cognitoAccessToken, token_type: "Bearer" };
  if (expiresInSeconds !== undefined) body.expires_in = expiresInSeconds;
  if (refreshHandle !== undefined) body.refresh_token = refreshHandle;
  return new Response(JSON.stringify(body), { status: 200, headers: { ...TOKEN_HEADERS } });
};

// `expires_in` (RFC 6749 §5.1) is what lets a client refresh BEFORE it gets a 401 — and spec §4.3
// justifies this endpoint's whole 30-second rotation grace with "Claude refreshes proactively up
// to five minutes before expiry," a schedule no client can compute without this field. Neither
// source of an access token here reports one on both paths (the stored grant records no expiry,
// and only the refresh response carries `expires_in`), so BOTH paths read it from the same place:
// the access token's own `exp`.
//
// THIS IS NOT AUTHORIZATION, and it is not a second verifier. No signature is checked, and no
// access decision is made on the result — the value is advisory, the token reached us from Cognito
// over TLS through our own confidential client, and the resource server still verifies it properly
// (aws-jwt-verify, spec §4.3). Every failure DEGRADES TO SILENCE — a token that is not three
// segments, a payload that is not JSON, a missing/non-numeric/non-finite `exp`, or an expiry
// already past — omitting the field, which is exactly how this endpoint behaved before it existed.
const expiresInSecondsOf = (accessToken: string, nowMs: number): number | undefined => {
  const segments = accessToken.split(".");
  if (segments.length !== 3) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const exp = (payload as Record<string, unknown>).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  const remainingSeconds = Math.floor(exp - nowMs / 1000);
  return remainingSeconds > 0 ? remainingSeconds : undefined;
};

// ---------------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------------

export const handleToken = async (request: Request, deps: TokenDeps): Promise<Response> => {
  // Pin the method and the content-type, exactly as `handleConsentSubmit` does: otherwise a
  // form-shaped body on any verb, under any content-type, redeems a code.
  if (request.method !== "POST") return invalidGrant("the token endpoint accepts POST only");
  // The MEDIA TYPE, not a substring of the header — see `isFormUrlEncoded`. `/register` is the
  // JSON endpoint; this one is form-encoded only (spec §4.3 step 4, "different parsers").
  if (!isFormUrlEncoded(request.headers.get("content-type"))) {
    return invalidGrant("the token endpoint accepts application/x-www-form-urlencoded only");
  }

  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") return redeemAuthorizationCode(form, deps);
  if (grantType === "refresh_token") return redeemRefreshHandle(form, deps);
  return invalidGrant("unsupported grant_type — this authorization server issues authorization_code and refresh_token only");
};

const redeemAuthorizationCode = async (form: URLSearchParams, deps: TokenDeps): Promise<Response> => {
  const parsed = authorizationCodeRequestSchema.safeParse(presentFields(form, AUTHORIZATION_CODE_KEYS));
  if (!parsed.success) {
    return invalidGrant("authorization_code requires code, client_id, redirect_uri and a 43-128 character code_verifier");
  }
  const { code, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier } = parsed.data;

  // `takeCode` is a conditional delete (Task 14) — it is the replay defence, and it runs BEFORE
  // the checks below on purpose. A code presented with the wrong verifier is a code that has
  // been seen by someone who could not prove they minted it; OAuth 2.1 §4.1.3 says the server
  // SHOULD revoke it rather than leave it redeemable for the next attempt.
  const grant = await deps.store.takeCode(code);
  if (grant === undefined) return invalidGrant("authorization code is unknown, expired, or already redeemed");

  if (clientId !== grant.clientId) return invalidGrant("client_id does not match the authorization code");
  // The grant's `redirectUri` is the CANONICAL value `redirectUriAllowed` returned at /authorize,
  // never a raw request string — so this compares against something already validated.
  if (redirectUri !== grant.redirectUri) return invalidGrant("redirect_uri does not match the authorization code");
  if (!pkceVerifies(codeVerifier, grant)) return invalidGrant("code_verifier does not match the recorded code_challenge");

  // Cognito issues no refresh token for some app-client configurations; a grant without one
  // yields a response without one, rather than a handle wrapping nothing.
  let refreshHandle: string | undefined;
  if (grant.cognitoRefreshToken !== undefined) {
    refreshHandle = (deps.generateId ?? randomUUID)();
    await deps.store.putHandle(refreshHandle, {
      clientId: grant.clientId,
      approvedScopes: grant.approvedScopes,
      cognitoRefreshToken: grant.cognitoRefreshToken,
    });
  }

  return tokenResponse(grant.cognitoAccessToken, refreshHandle, expiresInSecondsOf(grant.cognitoAccessToken, deps.clock.now()));
};

// S256 only — the one method /authorize ever records (it refuses anything else outright). A
// stored grant claiming "plain" is not a reason to start accepting a verifier that IS the
// challenge; it is a record that could not have come from this server.
const pkceVerifies = (codeVerifier: string, grant: AuthorizeCodeGrant): boolean => {
  if (grant.codeChallengeMethod !== "S256") return false;
  return createHash("sha256").update(codeVerifier).digest("base64url") === grant.codeChallenge;
};

const redeemRefreshHandle = async (form: URLSearchParams, deps: TokenDeps): Promise<Response> => {
  const parsed = refreshRequestSchema.safeParse(presentFields(form, REFRESH_KEYS));
  if (!parsed.success) return invalidGrant("the refresh_token grant requires refresh_token and client_id");
  const { refresh_token: presentedHandle, client_id: clientId } = parsed.data;

  // `getHandle`, not a take: the handle is retired (with the store's grace window) only once the
  // refresh has actually succeeded, below.
  const record = await deps.store.getHandle(presentedHandle);
  if (record === undefined) return invalidGrant("refresh handle is unknown or expired");
  if (clientId !== record.clientId) return invalidGrant("client_id does not match the refresh handle");

  // Upstream FIRST, rotation second. A transient Cognito failure must leave the handle with its
  // full life — retiring before the call would spend the golfer's session on a network blip,
  // leaving them 30 seconds to notice.
  const tokens = await refreshCognitoTokens(record.cognitoRefreshToken, deps);
  if (tokens === undefined) return invalidGrant("the upstream refresh was refused");

  const freshHandle = (deps.generateId ?? randomUUID)();
  await deps.store.retireHandle(presentedHandle);
  await deps.store.putHandle(freshHandle, {
    clientId: record.clientId,
    approvedScopes: record.approvedScopes,
    // Cognito's refresh grant ordinarily returns NO new refresh token — the original stays
    // valid. Carrying it forward is what keeps the chain alive past the first rotation; taking
    // `tokens.refreshToken` unconditionally would store `undefined` and strand the golfer.
    cognitoRefreshToken: tokens.refreshToken ?? record.cognitoRefreshToken,
  });

  return tokenResponse(tokens.accessToken, freshHandle, expiresInSecondsOf(tokens.accessToken, deps.clock.now()));
};

// ---------------------------------------------------------------------------------------------
// Cognito's refresh grant. Deliberately a SECOND small function rather than a reuse of
// authorize.ts's `exchangeCognitoCode`: that one takes the whole `AuthorizeDeps` (a client
// store, a CIMD fetcher, the request store, the canonical resource) to read two fields off it,
// and calling it from here would mean fabricating four unrelated dependencies. Same wire shape,
// different grant.
// ---------------------------------------------------------------------------------------------

interface CognitoTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
}

const refreshCognitoTokens = async (cognitoRefreshToken: string, deps: TokenDeps): Promise<CognitoTokens | undefined> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cognitoRefreshToken,
    client_id: deps.cognito.clientId,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (deps.cognito.clientSecret !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${deps.cognito.clientId}:${deps.cognito.clientSecret}`).toString("base64")}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(`${deps.cognito.domain}/oauth2/token`, { method: "POST", headers, body: body.toString() });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const obj = json as Record<string, unknown>;
  if (typeof obj.access_token !== "string") return undefined;
  return typeof obj.refresh_token === "string"
    ? { accessToken: obj.access_token, refreshToken: obj.refresh_token }
    : { accessToken: obj.access_token };
};
