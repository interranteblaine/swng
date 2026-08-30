import { createHash, randomUUID } from "node:crypto";
import type { OAuthStore } from "@swng/adapters-dynamodb";
import type { AuthorizeCodeGrant, AuthorizeCognitoConfig } from "./authorize.js";

// POST /token — where the opaque codes `/authorize` mints get redeemed (design spec §4.3 step 4,
// Task 18). swng MEDIATES: this endpoint issues no JWT of its own, it hands back the access
// token COGNITO issued for the grant, wrapped only in an opaque refresh handle of ours.
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
// Responses. RFC 6749 §5.1 requires `Cache-Control: no-store` and `Pragma: no-cache` on any
// response carrying tokens; both are set on the error responses too rather than remembered per
// branch.
// ---------------------------------------------------------------------------------------------

const TOKEN_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

// The ONE error this endpoint speaks. `error_description` never echoes the caller's own input
// back — it names which check failed, for a human reading a log, and nothing more.
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
// really got. `expires_in` is absent for the same reason in reverse: the authorization_code path
// has no expiry to report (the stored grant records none), and reporting one on the refresh path
// only would be a contract that changes shape between two calls the client treats alike — the
// access token's own `exp` is authoritative either way.
const tokenResponse = (cognitoAccessToken: string, refreshHandle: string | undefined): Response => {
  const body: Record<string, string> = { access_token: cognitoAccessToken, token_type: "Bearer" };
  if (refreshHandle !== undefined) body.refresh_token = refreshHandle;
  return new Response(JSON.stringify(body), { status: 200, headers: { ...TOKEN_HEADERS } });
};

// ---------------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------------

export const handleToken = async (request: Request, deps: TokenDeps): Promise<Response> => {
  // Pin the method and the content-type, exactly as `handleConsentSubmit` does: a form-shaped
  // body on any verb, under any content-type, used to redeem a code. `/register` is the JSON
  // endpoint; this one is form-encoded only (spec §4.3 step 4, "different parsers").
  if (request.method !== "POST") return invalidGrant("the token endpoint accepts POST only");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return invalidGrant("the token endpoint accepts application/x-www-form-urlencoded only");
  }

  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") return redeemAuthorizationCode(form, deps);
  if (grantType === "refresh_token") return redeemRefreshHandle(form, deps);
  return invalidGrant("unsupported grant_type — this authorization server issues authorization_code and refresh_token only");
};

const redeemAuthorizationCode = async (form: URLSearchParams, deps: TokenDeps): Promise<Response> => {
  const code = form.get("code");
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  const codeVerifier = form.get("code_verifier");
  if (code === null || clientId === null || redirectUri === null || codeVerifier === null) {
    return invalidGrant("authorization_code requires code, client_id, redirect_uri and code_verifier");
  }

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

  return tokenResponse(grant.cognitoAccessToken, refreshHandle);
};

// S256 only — the one method /authorize ever records (it refuses anything else outright). A
// stored grant claiming "plain" is not a reason to start accepting a verifier that IS the
// challenge; it is a record that could not have come from this server.
const pkceVerifies = (codeVerifier: string, grant: AuthorizeCodeGrant): boolean => {
  if (grant.codeChallengeMethod !== "S256") return false;
  return createHash("sha256").update(codeVerifier).digest("base64url") === grant.codeChallenge;
};

const redeemRefreshHandle = async (form: URLSearchParams, deps: TokenDeps): Promise<Response> => {
  const presentedHandle = form.get("refresh_token");
  const clientId = form.get("client_id");
  if (presentedHandle === null || clientId === null) {
    return invalidGrant("refresh_token requires refresh_token and client_id");
  }

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

  return tokenResponse(tokens.accessToken, freshHandle);
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
