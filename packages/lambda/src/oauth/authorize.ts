import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { OAuthStore } from "@swng/adapters-dynamodb";
import type { ClientStore, FetchCimdDeps } from "./clients.js";
import { redirectUriAllowed, resolveClient } from "./clients.js";

// /authorize, the Cognito callback, and consent (design spec §4.2/§4.3, Task 17). swng
// MEDIATES; Cognito remains the only token issuer.
//
// TWO COGNITO LEGS, not one — fix round 1's Critical 1/2. Leg 1 (handleAuthorize ->
// handleCallback/finishLeg1) NEVER requests more than read from Cognito, no matter what the
// client asked for — so the tokens held while consent renders can never carry write. The
// consent page (renderConsentPage) UNCONDITIONALLY offers "read-only" or "read and write" —
// never gated on what the client requested, which was Critical 2's defect (spec §4.4 exists
// precisely so the GOLFER'S choice decides, not the client's ask). Only when the golfer picks
// "read and write" does a SECOND, silent leg run (beginWriteStepUp -> handleCallback/
// finishLeg2): a fresh Cognito authorize round trip requesting read+write, silent because the
// golfer already has an active Cognito session from leg 1. The client's own opaque code is
// minted exactly once — in finishLeg2's write-approved branch, or directly in
// handleConsentSubmit's read-only branch — and in both cases it's bound to a Cognito token that
// was ACTUALLY ISSUED for the scopes being approved, never a token issued for more.
//
// ORDER IS STILL LOAD-BEARING: nothing constructs a `putCode` call anywhere except inside
// handleConsentSubmit's read-only branch and finishLeg2's write branch — both of which run only
// after the golfer approved. Minting before consent would mean a code exists for a grant nobody
// approved.

// ---------------------------------------------------------------------------------------------
// Scopes — one constant, three roles (design spec §4.3): `resource` IS the MCP endpoint URL,
// the Cognito resource server identifier, and the PRM `resource`. Scopes are therefore
// `${resource}/read` and `${resource}/write` — the only two scopes this AS ever grants.
// ---------------------------------------------------------------------------------------------

const readScopeOf = (resource: string): string => `${resource}/read`;
const writeScopeOf = (resource: string): string => `${resource}/write`;

// ---------------------------------------------------------------------------------------------
// Stored record shapes — three phases, all in Task 14's `request` slot (10 min, single-use).
// "pending" (leg 1 sent, awaiting Cognito) -> "consent" (leg 1 tokens held, awaiting the
// golfer) -> EITHER a code is minted directly (read-only) OR "leg2-pending" (write step-up sent,
// awaiting Cognito again) -> a code is minted from leg 2's tokens. Every phase is consumed by
// exactly one `takeRequest`, so a replay at any step redeems nothing.
// ---------------------------------------------------------------------------------------------

interface PendingAuthorizeRequest {
  readonly phase: "pending";
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUri: string; // canonical — the value redirectUriAllowed RETURNED, never the raw input
  readonly clientState?: string;
  // The CLIENT's ask, F5-validated and kept for record/audit. Does NOT bound what the golfer can
  // approve at consent (fix round 1, Critical 2) — the consent page offers both scopes
  // unconditionally, regardless of what's requested here.
  readonly requestedScopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly registeredRedirectUris: readonly string[]; // for the consent page's loopback-only warning
  readonly cognitoCodeVerifier: string; // OUR PKCE verifier for the Cognito leg-1 hop
}

interface ConsentAuthorizeRequest {
  readonly phase: "consent";
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUri: string;
  readonly clientState?: string;
  readonly requestedScopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly registeredRedirectUris: readonly string[];
  // Leg-1 tokens — READ-ONLY, always (fix round 1, Critical 1): handleAuthorize caps the
  // leg-1 Cognito request at readScopeOf(resource) unconditionally, so these can never carry
  // write no matter what requestedScopes says.
  readonly cognitoAccessToken: string;
  readonly cognitoRefreshToken?: string;
}

interface Leg2PendingAuthorizeRequest {
  readonly phase: "leg2-pending";
  readonly clientId: string;
  readonly redirectUri: string;
  readonly clientState?: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly approvedScopes: readonly string[]; // fixed to [read, write] by the only path that reaches this phase
  readonly cognitoCodeVerifier: string; // fresh PKCE for the silent leg-2 hop
}

export type AuthorizeRequestRecord = PendingAuthorizeRequest | ConsentAuthorizeRequest | Leg2PendingAuthorizeRequest;

export interface AuthorizeCodeGrant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly approvedScopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly cognitoAccessToken: string;
  readonly cognitoRefreshToken?: string;
}

// The narrow slice of Task 14's `OAuthStore` this module needs, typed against the concrete
// records above — same idiom as `ClientStore` in clients.ts.
export type AuthorizeStore = Pick<
  OAuthStore<unknown, AuthorizeRequestRecord, AuthorizeCodeGrant, unknown>,
  "putRequest" | "takeRequest" | "putCode"
>;

// Drops any key whose value is `undefined` before a record is handed to `putRequest`/`putCode` —
// clients.ts's own hard-won lesson (review round 1, Task 16, fix 2): `createDocumentClient.ts`
// builds its DynamoDB client with no `marshallOptions`, so `removeUndefinedValues` is `false`,
// and `marshall({ key: undefined })` throws. `clientName`/`clientState`/`cognitoRefreshToken`
// are all ordinarily-absent optional fields, not edge cases.
const omitUndefined = <T extends object>(obj: T): T => {
  const out = {} as T;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// Stored-record parsing — CLAUDE.md: "a type must not assert what the read path cannot guarantee
// — parse stored data, never cast it." These are the `parseRequest` / `parseCodeGrant` that
// `createDynamoOAuthStore` (Task 14) takes as injected parameters; without them the store cannot
// be wired at all. Same idiom as `parseStoredClientRecord` in clients.ts: plain shape checks, a
// named error per failed field, and deliberately NO bounds — CLAUDE.md again: "bounds go on
// request schemas only, never on a stored/read/fold schema." `authorizeQuerySchema` already
// bounded every one of these fields on the way IN.
//
// `parseStoredAuthorizeRequest` discriminates on `phase` and must cover ALL THREE variants:
// dropping "leg2-pending" would leave every WRITE-approving consent dead at the leg-2 callback
// (handleCallback's `record.phase === "leg2-pending"` branch would never be reached, because the
// store would throw while parsing the record it was handed) — i.e. the entire write path.
// ---------------------------------------------------------------------------------------------

const storedObject = (context: string, raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw new Error(`${context} is not an object`);
  return raw as Record<string, unknown>;
};

const storedString = (context: string, obj: Record<string, unknown>, field: string): string => {
  const value = obj[field];
  if (typeof value !== "string") throw new Error(`${context}: ${field} missing or not a string`);
  return value;
};

const storedOptionalString = (context: string, obj: Record<string, unknown>, field: string): string | undefined => {
  const value = obj[field];
  if (value !== undefined && typeof value !== "string") throw new Error(`${context}: ${field} present but not a string`);
  return value;
};

const storedStringArray = (context: string, obj: Record<string, unknown>, field: string): string[] => {
  const value = obj[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${context}: ${field} missing or not a string[]`);
  }
  return value as string[];
};

export const parseStoredAuthorizeRequest = (raw: unknown): AuthorizeRequestRecord => {
  const context = "stored OAuth authorize request";
  const obj = storedObject(context, raw);

  if (obj.phase === "pending") {
    return omitUndefined<PendingAuthorizeRequest>({
      phase: "pending",
      clientId: storedString(context, obj, "clientId"),
      clientName: storedOptionalString(context, obj, "clientName"),
      redirectUri: storedString(context, obj, "redirectUri"),
      clientState: storedOptionalString(context, obj, "clientState"),
      requestedScopes: storedStringArray(context, obj, "requestedScopes"),
      codeChallenge: storedString(context, obj, "codeChallenge"),
      codeChallengeMethod: storedString(context, obj, "codeChallengeMethod"),
      registeredRedirectUris: storedStringArray(context, obj, "registeredRedirectUris"),
      cognitoCodeVerifier: storedString(context, obj, "cognitoCodeVerifier"),
    });
  }

  if (obj.phase === "consent") {
    return omitUndefined<ConsentAuthorizeRequest>({
      phase: "consent",
      clientId: storedString(context, obj, "clientId"),
      clientName: storedOptionalString(context, obj, "clientName"),
      redirectUri: storedString(context, obj, "redirectUri"),
      clientState: storedOptionalString(context, obj, "clientState"),
      requestedScopes: storedStringArray(context, obj, "requestedScopes"),
      codeChallenge: storedString(context, obj, "codeChallenge"),
      codeChallengeMethod: storedString(context, obj, "codeChallengeMethod"),
      registeredRedirectUris: storedStringArray(context, obj, "registeredRedirectUris"),
      cognitoAccessToken: storedString(context, obj, "cognitoAccessToken"),
      cognitoRefreshToken: storedOptionalString(context, obj, "cognitoRefreshToken"),
    });
  }

  if (obj.phase === "leg2-pending") {
    return omitUndefined<Leg2PendingAuthorizeRequest>({
      phase: "leg2-pending",
      clientId: storedString(context, obj, "clientId"),
      redirectUri: storedString(context, obj, "redirectUri"),
      clientState: storedOptionalString(context, obj, "clientState"),
      codeChallenge: storedString(context, obj, "codeChallenge"),
      codeChallengeMethod: storedString(context, obj, "codeChallengeMethod"),
      approvedScopes: storedStringArray(context, obj, "approvedScopes"),
      cognitoCodeVerifier: storedString(context, obj, "cognitoCodeVerifier"),
    });
  }

  throw new Error(`${context}: unknown phase ${JSON.stringify(obj.phase)} — expected "pending", "consent" or "leg2-pending"`);
};

export const parseStoredCodeGrant = (raw: unknown): AuthorizeCodeGrant => {
  const context = "stored OAuth code grant";
  const obj = storedObject(context, raw);
  return omitUndefined<AuthorizeCodeGrant>({
    clientId: storedString(context, obj, "clientId"),
    redirectUri: storedString(context, obj, "redirectUri"),
    approvedScopes: storedStringArray(context, obj, "approvedScopes"),
    codeChallenge: storedString(context, obj, "codeChallenge"),
    codeChallengeMethod: storedString(context, obj, "codeChallengeMethod"),
    cognitoAccessToken: storedString(context, obj, "cognitoAccessToken"),
    cognitoRefreshToken: storedOptionalString(context, obj, "cognitoRefreshToken"),
  });
};

export interface AuthorizeCognitoConfig {
  readonly domain: string; // e.g. "https://swng-beta.auth.us-east-1.amazoncognito.com"
  readonly clientId: string; // OUR confidential Cognito app client, held server-side
  readonly clientSecret?: string;
  readonly callbackUrl: string; // absolute URL this module's handleCallback is reachable at
}

export interface AuthorizeDeps {
  readonly resource: string; // CANONICAL (design spec §4.3) — never re-derived, always passed in
  readonly clientStore: ClientStore;
  readonly cimd: FetchCimdDeps;
  readonly store: AuthorizeStore;
  readonly cognito: AuthorizeCognitoConfig;
  readonly fetchImpl?: typeof fetch; // injected so pnpm validate stays offline
  readonly generateId?: () => string; // requestId / consentId / leg2Id / code — default randomUUID
  readonly generatePkce?: () => { verifier: string; challenge: string };
}

// The path this module's consent form posts to, and the path Cognito's app client is configured
// to redirect back to (both legs share the SAME callback URL) — named here as the one place both
// halves of the wiring (this file, and whichever future task adds the HTTP routes) read the same
// strings from.
export const CALLBACK_PATH = "/oauth/callback";
export const CONSENT_SUBMIT_PATH = "/oauth/consent";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

// SECURITY: a 400 with NO Location header, ever — the caller of this function decides "we do
// not yet trust where to send an error," and this is the only response shape that can express
// that. Redirecting an error to an unvalidated redirect_uri is how an open redirect becomes an
// exfiltration channel (brief).
const badRequest = (description: string): Response =>
  new Response(JSON.stringify({ error: "invalid_request", error_description: description }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

// fix round 1, Important 2: `Response.redirect(...)` returns a Response with IMMUTABLE headers
// (`headers.set` throws `TypeError: immutable`), so nothing downstream can attach
// `Cache-Control: no-store` to it — and every redirect this file issues either carries a live
// single-use code/state or points at Cognito with a single-use PKCE challenge, so none of them
// should ever be cached. Built as a plain `Response` instead, everywhere, so `cache-control` is
// always present and always settable.
const redirectResponse = (location: string): Response =>
  new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });

const originOf = (resource: string): string => new URL(resource).origin;

// The media type ONLY: everything from the first ";" is parameters (charset, and anything else a
// caller cares to append), not identity. Review round 1, Task 18, M-1: the `.includes(...)` test
// that stood here admitted `application/json; note="application/x-www-form-urlencoded"`, which
// redeemed a real authorization code at /token. Both form-encoded endpoints in this surface —
// the consent POST below and token.ts's /token — ask this one function, so neither can drift.
export const isFormUrlEncoded = (contentTypeHeader: string | null): boolean =>
  ((contentTypeHeader ?? "").split(";")[0] ?? "").trim().toLowerCase() === "application/x-www-form-urlencoded";

// Once redirect_uri is trusted (it came back from redirectUriAllowed, or from our OWN stored
// record — never the raw request again), further errors answer via a standard OAuth error
// redirect: legible to the client, and carrying `iss` per RFC 9207 on every authorization
// response, success or failure.
const buildErrorRedirect = (redirectUri: string, resource: string, opts: { error: string; description: string; state?: string }): Response => {
  const url = new URL(redirectUri);
  url.searchParams.set("error", opts.error);
  url.searchParams.set("error_description", opts.description);
  if (opts.state !== undefined) url.searchParams.set("state", opts.state);
  url.searchParams.set("iss", originOf(resource));
  return redirectResponse(url.toString());
};

const finalClientRedirect = (redirectUri: string, code: string, clientState: string | undefined, resource: string): Response => {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (clientState !== undefined) url.searchParams.set("state", clientState);
  url.searchParams.set("iss", originOf(resource)); // RFC 9207, success path too
  return redirectResponse(url.toString());
};

type ScopeParseResult = { readonly ok: true; readonly scopes: string[] } | { readonly ok: false; readonly message: string };

// F5 (spec §4.2, measured against the beta pool): Cognito fails the WHOLE authorization with
// invalid_request when a custom scope belongs to a different resource, opaquely. Caught HERE
// instead, before we ever redirect to Cognito, and said legibly. Kept even though leg 1 now
// always caps its OWN Cognito request at read (below) — a client naming a foreign resource's
// scope is still a malformed request worth refusing loudly, and requestedScopes is recorded for
// audit regardless of what gets granted.
const parseRequestedScopes = (scopeParam: string | undefined, resource: string): ScopeParseResult => {
  const read = readScopeOf(resource);
  const write = writeScopeOf(resource);
  const allowed = new Set([read, write]);
  if (scopeParam === undefined || scopeParam.trim() === "") return { ok: true, scopes: [read] };
  const tokens = scopeParam.split(/\s+/).filter((t) => t.length > 0);
  const owned = tokens.filter((t) => allowed.has(t));
  const unowned = tokens.find((t) => !allowed.has(t));
  if (unowned !== undefined) {
    return {
      ok: false,
      message: `scope "${unowned}" does not belong to the resource ${resource} — custom scopes requested for resource-binding must be assigned to the resource being requested (Cognito, measured: design spec §4.2 F5)`,
    };
  }
  return { ok: true, scopes: owned.length > 0 ? owned : [read] };
};

const base64url = (buf: Buffer): string => buf.toString("base64url");

const defaultGeneratePkce = (): { verifier: string; challenge: string } => {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

// ---------------------------------------------------------------------------------------------
// Step 1 — GET /authorize
// ---------------------------------------------------------------------------------------------

// fix round 1, Important 3: every field bounded. Probed: an unbounded `state`/`code_challenge`
// let a 600 KB stored record past DynamoDB's 400 KB item limit, so `putRequest` would throw
// AFTER the golfer had already authenticated — a 500 with no recovery. Caps mirror clients.ts's
// own request-schema bounds (`client_id` <= 2048 matches its CIMD cap); `code_challenge`'s 128 is
// RFC 7636's own maximum length for the parameter.
const authorizeQuerySchema = z.object({
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1).max(2048),
  response_type: z.string().min(1).max(64),
  code_challenge: z.string().min(1).max(128),
  code_challenge_method: z.string().min(1).max(16),
  state: z.string().max(512).optional(),
  scope: z.string().max(512).optional(),
});

const QUERY_KEYS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope"] as const;

export const handleAuthorize = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  const url = new URL(request.url);

  // Every query parameter here is attacker-controlled — parse, never cast (CLAUDE.md).
  const raw: Record<string, string> = {};
  for (const key of QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value !== null) raw[key] = value;
  }
  const parsed = authorizeQuerySchema.safeParse(raw);
  if (!parsed.success) return badRequest(`malformed /authorize request: ${parsed.error.message}`);
  const q = parsed.data;

  const client = await resolveClient(q.client_id, { store: deps.clientStore, cimd: deps.cimd });
  if (!client) return badRequest(`unknown client_id: ${q.client_id}`);

  // SECURITY: reject an unregistered redirect_uri WITHOUT redirecting to it — see badRequest's
  // doc comment. Use what redirectUriAllowed RETURNS (the canonical matched URI), never the raw
  // `q.redirect_uri` again, per Task 16's own fix 4 rationale.
  const canonicalRedirectUri = redirectUriAllowed(client.redirectUris, q.redirect_uri);
  if (canonicalRedirectUri === undefined) {
    return badRequest("redirect_uri is not registered for this client");
  }

  // From here on redirect_uri is trusted; further errors answer via an OAuth error redirect.
  if (q.response_type !== "code") {
    return buildErrorRedirect(canonicalRedirectUri, deps.resource, {
      error: "unsupported_response_type",
      description: "only response_type=code is supported",
      state: q.state,
    });
  }
  if (q.code_challenge_method !== "S256") {
    return buildErrorRedirect(canonicalRedirectUri, deps.resource, {
      error: "invalid_request",
      description: "only code_challenge_method=S256 is supported",
      state: q.state,
    });
  }

  const scopesResult = parseRequestedScopes(q.scope, deps.resource);
  if (!scopesResult.ok) {
    return buildErrorRedirect(canonicalRedirectUri, deps.resource, {
      error: "invalid_request",
      description: scopesResult.message,
      state: q.state,
    });
  }

  const generateId = deps.generateId ?? randomUUID;
  const generatePkce = deps.generatePkce ?? defaultGeneratePkce;
  const requestId = generateId();
  const pkce = generatePkce();

  const record: PendingAuthorizeRequest = omitUndefined({
    phase: "pending",
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri: canonicalRedirectUri,
    clientState: q.state,
    requestedScopes: scopesResult.scopes,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
    registeredRedirectUris: client.redirectUris,
    cognitoCodeVerifier: pkce.verifier,
  });
  await deps.store.putRequest(requestId, record);

  // fix round 1, Critical 1: leg 1 NEVER requests more than read from Cognito, no matter what
  // the client asked for (`scopesResult.scopes` is stored above for audit/F5, not sent here).
  // A golfer who never reaches — or never approves past — consent therefore has NO path to a
  // write-scoped Cognito token; only beginWriteStepUp's silent leg 2 ever requests write, and
  // only after an explicit "read_write" approval.
  //
  // Binds the CANONICAL resource, with S256 PKCE (brief; spec F2/F3): a `resource` that doesn't
  // name a registered resource server yields a code that cannot be redeemed, reported as an
  // ordinary invalid_grant pointing nowhere near the real cause — so this is never optional and
  // never a second, re-derived string.
  const cognitoUrl = new URL(`${deps.cognito.domain}/oauth2/authorize`);
  cognitoUrl.searchParams.set("response_type", "code");
  cognitoUrl.searchParams.set("client_id", deps.cognito.clientId);
  cognitoUrl.searchParams.set("redirect_uri", deps.cognito.callbackUrl);
  cognitoUrl.searchParams.set("state", requestId);
  cognitoUrl.searchParams.set("code_challenge", pkce.challenge);
  cognitoUrl.searchParams.set("code_challenge_method", "S256");
  cognitoUrl.searchParams.set("resource", deps.resource);
  cognitoUrl.searchParams.set("scope", readScopeOf(deps.resource));

  return redirectResponse(cognitoUrl.toString());
};

// ---------------------------------------------------------------------------------------------
// The Cognito token exchange — shared by leg 1 and leg 2. Exchanges immediately; Cognito's code
// expires in five minutes (design spec §4.3).
// ---------------------------------------------------------------------------------------------

interface CognitoTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
}

const exchangeCognitoCode = async (cognitoCode: string, codeVerifier: string, deps: AuthorizeDeps): Promise<CognitoTokens | undefined> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: cognitoCode,
    redirect_uri: deps.cognito.callbackUrl,
    client_id: deps.cognito.clientId,
    code_verifier: codeVerifier,
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
  return omitUndefined({
    accessToken: obj.access_token,
    refreshToken: typeof obj.refresh_token === "string" ? obj.refresh_token : undefined,
  });
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

// Deliberately duplicated from clients.ts's private LOOPBACK_HOSTS/stripIPv6Brackets rather than
// exported from that already-twice-reviewed security file for an unrelated (display-only)
// purpose — this check gates a WARNING, not a security decision, so it's fine to be a plain
// three-host membership test here.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const stripIPv6Brackets = (hostname: string): string => (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname);
const isLoopbackUri = (uri: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(stripIPv6Brackets(new URL(uri).hostname));
  } catch {
    return false;
  }
};
const allRegisteredLoopback = (uris: readonly string[]): boolean => uris.length > 0 && uris.every(isLoopbackUri);

// Task 16's discovery (carried into this task by the brief): an ACCEPTED private-use redirect
// URI — e.g. `com.example.app:/callback` — parses with `hostname === ""`. Spec §4.3 requires the
// consent page to display the redirect URI's hostname as the golfer's one safety signal, and
// rendering nothing there would silently drop it. DECISION: fall back to the full URI (not just
// the bare scheme) — it's the most honest, legible thing available for a scheme that has no
// traditional host, and it's still short enough to read at a glance for the private-use URIs
// this scheme allowlist actually accepts.
const hostnameOrFallback = (uri: string): string => {
  const hostname = new URL(uri).hostname;
  return hostname !== "" ? hostname : uri;
};

// ---------------------------------------------------------------------------------------------
// Step 2 — GET /oauth/callback (Cognito's redirect back to us). Dispatches on the STORED
// record's phase — "pending" (leg 1, first-ever hop) or "leg2-pending" (the silent write
// step-up) — never on anything in the request itself, since the requestId IS the correlation
// key and the record it was stored under says which leg this is.
// ---------------------------------------------------------------------------------------------

export const handleCallback = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  const url = new URL(request.url);
  const requestId = url.searchParams.get("state");
  const cognitoCode = url.searchParams.get("code");
  const cognitoError = url.searchParams.get("error");

  if (requestId === null) return badRequest("callback is missing state");

  const record = await deps.store.takeRequest(requestId);
  if (record === undefined) return badRequest("authorization request not found or expired");

  if (record.phase === "pending") return finishLeg1(record, cognitoCode, cognitoError, deps);
  if (record.phase === "leg2-pending") return finishLeg2(record, cognitoCode, cognitoError, deps);
  // A "consent" record replayed at the callback URL — not a valid hop, and the record is
  // already consumed by the takeRequest above regardless, so there's nothing left to redeem.
  return badRequest("authorization request not found or expired");
};

const finishLeg1 = async (
  pending: PendingAuthorizeRequest,
  cognitoCode: string | null,
  cognitoError: string | null,
  deps: AuthorizeDeps,
): Promise<Response> => {
  if (cognitoError !== null || cognitoCode === null) {
    return buildErrorRedirect(pending.redirectUri, deps.resource, {
      error: cognitoError ?? "server_error",
      description: "authorization failed upstream at Cognito",
      state: pending.clientState,
    });
  }

  // Exchange Cognito's code IMMEDIATELY — it expires in five minutes, and consent has not
  // rendered yet, so nothing else has had a chance to spend that window.
  const tokens = await exchangeCognitoCode(cognitoCode, pending.cognitoCodeVerifier, deps);
  if (tokens === undefined) {
    return buildErrorRedirect(pending.redirectUri, deps.resource, {
      error: "server_error",
      description: "token exchange with Cognito failed",
      state: pending.clientState,
    });
  }

  // Hold the tokens under a short TTL (Task 14's request slot, 10 minutes) and render consent.
  // NO code exists yet — that's the whole point of this ordering.
  const generateId = deps.generateId ?? randomUUID;
  const consentId = generateId();
  const consentRecord: ConsentAuthorizeRequest = omitUndefined({
    phase: "consent",
    clientId: pending.clientId,
    clientName: pending.clientName,
    redirectUri: pending.redirectUri,
    clientState: pending.clientState,
    requestedScopes: pending.requestedScopes,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    registeredRedirectUris: pending.registeredRedirectUris,
    cognitoAccessToken: tokens.accessToken,
    cognitoRefreshToken: tokens.refreshToken,
  });
  await deps.store.putRequest(consentId, consentRecord);

  return renderConsentPage(consentId, consentRecord);
};

const finishLeg2 = async (
  record: Leg2PendingAuthorizeRequest,
  cognitoCode: string | null,
  cognitoError: string | null,
  deps: AuthorizeDeps,
): Promise<Response> => {
  if (cognitoError !== null || cognitoCode === null) {
    return buildErrorRedirect(record.redirectUri, deps.resource, {
      error: cognitoError ?? "server_error",
      description: "authorization failed upstream at Cognito (write step-up)",
      state: record.clientState,
    });
  }

  const tokens = await exchangeCognitoCode(cognitoCode, record.cognitoCodeVerifier, deps);
  if (tokens === undefined) {
    return buildErrorRedirect(record.redirectUri, deps.resource, {
      error: "server_error",
      description: "token exchange with Cognito failed (write step-up)",
      state: record.clientState,
    });
  }

  // Consent was already granted in step 3 (handleConsentSubmit's "read_write" branch) — this leg
  // exists ONLY to fetch a token that genuinely carries write, so the client's code is minted
  // here, directly, bound to THESE tokens.
  const generateId = deps.generateId ?? randomUUID;
  const code = generateId();
  const grant: AuthorizeCodeGrant = omitUndefined({
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    approvedScopes: record.approvedScopes,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    cognitoAccessToken: tokens.accessToken,
    cognitoRefreshToken: tokens.refreshToken,
  });
  await deps.store.putCode(code, grant);

  return finalClientRedirect(record.redirectUri, code, record.clientState, deps.resource);
};

// ---------------------------------------------------------------------------------------------
// The consent page — server-rendered HTML, no client-side JS (brief; spec §4.3's "a proxy
// holding a static upstream client id MUST obtain consent per registered client before
// forwarding"). fix round 1, Critical 2: the read/write choice is offered UNCONDITIONALLY —
// never gated on what the client requested. Spec §4.4 names the client's own scope request as
// precisely the thing that must NOT decide this; gating the choice on it reintroduces that
// defect.
// ---------------------------------------------------------------------------------------------

const renderConsentPage = (consentId: string, record: ConsentAuthorizeRequest): Response => {
  // The client name is ATTACKER-SUPPLIED (DCR body or a fetched CIMD document) and is about to
  // be written into HTML — escaped, not trusted. A consent page that can be made to lie about
  // who is asking defeats the page's entire purpose.
  const clientLabel = escapeHtml(record.clientName ?? record.clientId);
  const hostnameLabel = escapeHtml(hostnameOrFallback(record.redirectUri));

  const loopbackWarning = allRegisteredLoopback(record.registeredRedirectUris)
    ? `<p class="warning">Every redirect address registered for this app is a loopback address (your own device). If you did not just start this from a local tool, do not approve.</p>`
    : "";

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authorize ${clientLabel}</title></head>
<body>
<h1>${clientLabel} wants to access your swng account</h1>
<p>It will return to: <strong>${hostnameLabel}</strong></p>
${loopbackWarning}
<form method="POST" action="${CONSENT_SUBMIT_PATH}">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<p>
<label><input type="radio" name="scope_choice" value="read" checked> Read-only — view your rounds and courses</label><br>
<label><input type="radio" name="scope_choice" value="read_write"> Read and write — also record scores and manage rounds</label>
</p>
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny">Deny</button>
</form>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // fix round 1, Important 2: clickjacking an invisible Approve button is the canonical
      // attack on this exact page (OAuth 2.0 Security BCP §4.9). This page also carries a
      // live, single-use approve nonce (consent_id) for up to ten minutes — never cached.
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    },
  });
};

// ---------------------------------------------------------------------------------------------
// Step 3 — POST /oauth/consent. Read-only mints the code directly, from the leg-1 (necessarily
// read-only) tokens already held. "read_write" mints NOTHING here — it starts the silent leg-2
// step-up (beginWriteStepUp); the code is minted afterward, in finishLeg2, from tokens Cognito
// actually issued for read+write.
// ---------------------------------------------------------------------------------------------

const MAX_FORM_FIELD_LENGTH = 512;

export const handleConsentSubmit = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  // fix round 1, Minor: pin the method and content-type — a bare form-shaped body on any verb
  // used to mint a code.
  if (request.method !== "POST") return badRequest("consent must be submitted via POST");
  if (!isFormUrlEncoded(request.headers.get("content-type"))) {
    return badRequest("consent submission must be application/x-www-form-urlencoded");
  }

  const bodyText = await request.text();
  const body = new URLSearchParams(bodyText);
  const consentId = body.get("consent_id");
  const action = body.get("action");
  const scopeChoice = body.get("scope_choice");

  if (consentId === null || consentId.length > MAX_FORM_FIELD_LENGTH) return badRequest("missing or invalid consent_id");

  const record = await deps.store.takeRequest(consentId);
  if (record === undefined || record.phase !== "consent") {
    return badRequest("consent session not found or expired");
  }

  if (action !== "approve") {
    return buildErrorRedirect(record.redirectUri, deps.resource, {
      error: "access_denied",
      description: "the golfer declined the request",
      state: record.clientState,
    });
  }

  // fix round 1, Important 1: FAIL CLOSED. Only the exact string "read_write" grants write —
  // probed forms (omitted, "", "READ", "read " with a trailing space, "anything") must all fall
  // through to read-only, the least-privilege default for the one function whose entire job is
  // least privilege.
  if (scopeChoice === "read_write") {
    return beginWriteStepUp(record, deps);
  }

  const generateId = deps.generateId ?? randomUUID;
  const code = generateId();
  const grant: AuthorizeCodeGrant = omitUndefined({
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    approvedScopes: [readScopeOf(deps.resource)],
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    // These are leg-1 tokens — READ-ONLY, always, per handleAuthorize's scope cap. Nothing
    // write-capable was ever issued for a golfer who picks this branch.
    cognitoAccessToken: record.cognitoAccessToken,
    cognitoRefreshToken: record.cognitoRefreshToken,
  });
  await deps.store.putCode(code, grant);

  return finalClientRedirect(record.redirectUri, code, record.clientState, deps.resource);
};

// The silent write step-up: a SECOND Cognito authorize hop, requesting read+write, using a
// fresh PKCE pair and a fresh stored record. "Silent" because the golfer already holds an active
// Cognito hosted-UI session from leg 1 (same browser, same domain) — Cognito itself decides not
// to re-prompt for credentials; nothing in this file simulates that, it simply relies on it.
const beginWriteStepUp = async (record: ConsentAuthorizeRequest, deps: AuthorizeDeps): Promise<Response> => {
  const generateId = deps.generateId ?? randomUUID;
  const generatePkce = deps.generatePkce ?? defaultGeneratePkce;
  const leg2Id = generateId();
  const pkce = generatePkce();

  const leg2Record: Leg2PendingAuthorizeRequest = omitUndefined({
    phase: "leg2-pending",
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    clientState: record.clientState,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    approvedScopes: [readScopeOf(deps.resource), writeScopeOf(deps.resource)],
    cognitoCodeVerifier: pkce.verifier,
  });
  await deps.store.putRequest(leg2Id, leg2Record);

  const cognitoUrl = new URL(`${deps.cognito.domain}/oauth2/authorize`);
  cognitoUrl.searchParams.set("response_type", "code");
  cognitoUrl.searchParams.set("client_id", deps.cognito.clientId);
  cognitoUrl.searchParams.set("redirect_uri", deps.cognito.callbackUrl);
  cognitoUrl.searchParams.set("state", leg2Id);
  cognitoUrl.searchParams.set("code_challenge", pkce.challenge);
  cognitoUrl.searchParams.set("code_challenge_method", "S256");
  cognitoUrl.searchParams.set("resource", deps.resource);
  cognitoUrl.searchParams.set("scope", `${readScopeOf(deps.resource)} ${writeScopeOf(deps.resource)}`);

  return redirectResponse(cognitoUrl.toString());
};
