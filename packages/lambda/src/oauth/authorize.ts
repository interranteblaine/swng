import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { OAuthStore } from "@swng/adapters-dynamodb";
import type { ClientStore, FetchCimdDeps } from "./clients.js";
import { redirectUriAllowed, resolveClient } from "./clients.js";

// /authorize, the Cognito callback, and consent (design spec §4.2/§4.3, Task 17). swng
// MEDIATES; Cognito remains the only token issuer. ORDER IS LOAD-BEARING:
//
//   1. handleAuthorize   — validate the client's request, store it, 302 to Cognito.
//   2. handleCallback    — exchange Cognito's code IMMEDIATELY (5-minute expiry), hold the
//                           tokens under a short TTL, render consent. No code exists yet.
//   3. handleConsentSubmit — on approve, mint an opaque code bound to the held tokens and ONLY
//                           the scopes the golfer actually approved. On deny, no code, ever.
//
// Minting the client's code before consent would mean a code exists for a grant nobody
// approved — so nothing in this file constructs a `putCode` call anywhere except inside
// handleConsentSubmit's approve branch.

// ---------------------------------------------------------------------------------------------
// Scopes — one constant, three roles (design spec §4.3): `resource` IS the MCP endpoint URL,
// the Cognito resource server identifier, and the PRM `resource`. Scopes are therefore
// `${resource}/read` and `${resource}/write` — the only two scopes this AS ever grants.
// ---------------------------------------------------------------------------------------------

const readScopeOf = (resource: string): string => `${resource}/read`;
const writeScopeOf = (resource: string): string => `${resource}/write`;

// ---------------------------------------------------------------------------------------------
// Stored record shapes. Both live in Task 14's `request` slot (10 min, single-use) — this file
// never gets a dedicated "held tokens" slot, and doesn't need one: `handleCallback` calls
// `takeRequest` on the "pending" record `handleAuthorize` wrote, then `putRequest` again under a
// FRESH id with `phase: "consent"` added and the Cognito tokens attached. `handleConsentSubmit`
// then `takeRequest`s THAT. Two phases, one slot, single-use both times — a replayed callback or
// a replayed consent submission each redeem nothing the second time.
// ---------------------------------------------------------------------------------------------

interface PendingAuthorizeRequest {
  readonly phase: "pending";
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUri: string; // canonical — the value redirectUriAllowed RETURNED, never the raw input
  readonly clientState?: string;
  readonly requestedScopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly registeredRedirectUris: readonly string[]; // for the consent page's loopback-only warning
  readonly cognitoCodeVerifier: string; // OUR PKCE verifier for the Cognito leg, generated in step 1
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
  readonly cognitoAccessToken: string;
  readonly cognitoRefreshToken?: string;
}

export type AuthorizeRequestRecord = PendingAuthorizeRequest | ConsentAuthorizeRequest;

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
  readonly generateId?: () => string; // requestId / consentId / code — default randomUUID
  readonly generatePkce?: () => { verifier: string; challenge: string };
}

// The path this module's consent form posts to, and the path Cognito's app client is configured
// to redirect back to — named here as the one place both halves of the wiring (this file, and
// whichever future task adds the HTTP routes) read the same strings from.
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

// Once redirect_uri is trusted (it came back from redirectUriAllowed, or from our OWN stored
// record — never the raw request again), further errors answer via a standard OAuth error
// redirect: legible to the client, and carrying `iss` per RFC 9207 on every authorization
// response, success or failure.
const buildErrorRedirect = (redirectUri: string, resource: string, opts: { error: string; description: string; state?: string }): Response => {
  const url = new URL(redirectUri);
  url.searchParams.set("error", opts.error);
  url.searchParams.set("error_description", opts.description);
  if (opts.state !== undefined) url.searchParams.set("state", opts.state);
  url.searchParams.set("iss", new URL(resource).origin);
  return Response.redirect(url.toString(), 302);
};

type ScopeParseResult = { readonly ok: true; readonly scopes: string[] } | { readonly ok: false; readonly message: string };

// F5 (spec §4.2, measured against the beta pool): Cognito fails the WHOLE authorization with
// invalid_request when a custom scope belongs to a different resource, opaquely. Caught HERE
// instead, before we ever redirect to Cognito, and said legibly.
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

const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().min(1),
  state: z.string().optional(),
  scope: z.string().optional(),
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

  // Bind the CANONICAL resource on the Cognito redirect, with S256 PKCE (brief; spec F2/F3): a
  // `resource` that doesn't name a registered resource server yields a code that cannot be
  // redeemed, reported as an ordinary invalid_grant pointing nowhere near the real cause — so
  // this is never optional and never a second, re-derived string.
  const cognitoUrl = new URL(`${deps.cognito.domain}/oauth2/authorize`);
  cognitoUrl.searchParams.set("response_type", "code");
  cognitoUrl.searchParams.set("client_id", deps.cognito.clientId);
  cognitoUrl.searchParams.set("redirect_uri", deps.cognito.callbackUrl);
  cognitoUrl.searchParams.set("state", requestId);
  cognitoUrl.searchParams.set("code_challenge", pkce.challenge);
  cognitoUrl.searchParams.set("code_challenge_method", "S256");
  cognitoUrl.searchParams.set("resource", deps.resource);
  cognitoUrl.searchParams.set("scope", scopesResult.scopes.join(" "));

  return Response.redirect(cognitoUrl.toString(), 302);
};

// ---------------------------------------------------------------------------------------------
// Step 2 — GET /oauth/callback (Cognito's redirect back to us)
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

export const handleCallback = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  const url = new URL(request.url);
  const requestId = url.searchParams.get("state");
  const cognitoCode = url.searchParams.get("code");
  const cognitoError = url.searchParams.get("error");

  if (requestId === null) return badRequest("callback is missing state");

  const pending = await deps.store.takeRequest(requestId);
  if (pending === undefined || pending.phase !== "pending") {
    return badRequest("authorization request not found or expired");
  }

  if (cognitoError !== null || cognitoCode === null) {
    return buildErrorRedirect(pending.redirectUri, deps.resource, {
      error: cognitoError ?? "server_error",
      description: "authorization failed upstream at Cognito",
      state: pending.clientState,
    });
  }

  // Exchange Cognito's code IMMEDIATELY — it expires in five minutes (design spec §4.3), and
  // consent has not rendered yet, so nothing else has had a chance to spend that window.
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

  return renderConsentPage(consentId, consentRecord, deps.resource);
};

// ---------------------------------------------------------------------------------------------
// The consent page — server-rendered HTML, no client-side JS (brief; spec §4.3's "a proxy
// holding a static upstream client id MUST obtain consent per registered client before
// forwarding").
// ---------------------------------------------------------------------------------------------

const renderConsentPage = (consentId: string, record: ConsentAuthorizeRequest, resource: string): Response => {
  // The client name is ATTACKER-SUPPLIED (DCR body or a fetched CIMD document) and is about to
  // be written into HTML — escaped, not trusted. A consent page that can be made to lie about
  // who is asking defeats the page's entire purpose.
  const clientLabel = escapeHtml(record.clientName ?? record.clientId);
  const hostnameLabel = escapeHtml(hostnameOrFallback(record.redirectUri));

  const loopbackWarning = allRegisteredLoopback(record.registeredRedirectUris)
    ? `<p class="warning">Every redirect address registered for this app is a loopback address (your own device). If you did not just start this from a local tool, do not approve.</p>`
    : "";

  const write = writeScopeOf(resource);
  const offersWrite = record.requestedScopes.includes(write);

  // Spec §4.4: the client chooses the scope SET (what's offered here), the golfer chooses how
  // much of it to grant. A golfer can never end up with more than was requested.
  const scopeChoiceHtml = offersWrite
    ? `<p>
         <label><input type="radio" name="scope_choice" value="read" checked> Read-only — view your rounds and courses</label><br>
         <label><input type="radio" name="scope_choice" value="read_write"> Read and write — also record scores and manage rounds</label>
       </p>`
    : `<input type="hidden" name="scope_choice" value="read">
       <p>This app is asking for read-only access — view your rounds and courses.</p>`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authorize ${clientLabel}</title></head>
<body>
<h1>${clientLabel} wants to access your swng account</h1>
<p>It will return to: <strong>${hostnameLabel}</strong></p>
${loopbackWarning}
<form method="POST" action="${CONSENT_SUBMIT_PATH}">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
${scopeChoiceHtml}
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny">Deny</button>
</form>
</body>
</html>`;

  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};

// ---------------------------------------------------------------------------------------------
// Step 3 — POST /oauth/consent (on approve, mint the client's code; on deny, mint nothing)
// ---------------------------------------------------------------------------------------------

const approvedScopesFrom = (requestedScopes: readonly string[], scopeChoice: string | null, resource: string): string[] => {
  const read = readScopeOf(resource);
  if (scopeChoice === "read") return requestedScopes.includes(read) ? [read] : [];
  // "read_write", or anything else submitted — grant everything the client requested and the
  // golfer therefore had the option to approve. Never more than requestedScopes: this function
  // has no way to add a scope that wasn't already there.
  return [...requestedScopes];
};

export const handleConsentSubmit = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  const bodyText = await request.text();
  const body = new URLSearchParams(bodyText);
  const consentId = body.get("consent_id");
  const action = body.get("action");
  const scopeChoice = body.get("scope_choice");

  if (consentId === null) return badRequest("missing consent_id");

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

  // The code carries ONLY the scopes actually approved at this page — never the requested set.
  const approvedScopes = approvedScopesFrom(record.requestedScopes, scopeChoice, deps.resource);

  const generateId = deps.generateId ?? randomUUID;
  const code = generateId();
  const grant: AuthorizeCodeGrant = omitUndefined({
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    approvedScopes,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    cognitoAccessToken: record.cognitoAccessToken,
    cognitoRefreshToken: record.cognitoRefreshToken,
  });
  await deps.store.putCode(code, grant);

  const redirectUrl = new URL(record.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (record.clientState !== undefined) redirectUrl.searchParams.set("state", record.clientState);
  // RFC 9207 issuer identification, on the success path too.
  redirectUrl.searchParams.set("iss", new URL(deps.resource).origin);
  return Response.redirect(redirectUrl.toString(), 302);
};
