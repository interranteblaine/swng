import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { Clock } from "@swng/application";
import { createDocumentClient, createDynamoOAuthStore } from "@swng/adapters-dynamodb";
import { createSecretsManagerReader } from "@swng/adapters-secretsmanager";
import { fromFetchResponse, toFetchRequest } from "../http/fetchAdapter.js";
import { handleAuthorize, handleCallback, handleConsentSubmit, parseStoredAuthorizeRequest, parseStoredCodeGrant } from "../oauth/authorize.js";
import type { AuthorizeCognitoConfig, AuthorizeDeps } from "../oauth/authorize.js";
import { ClientRegistrationError, parseStoredClientRecord, registerDcrClient } from "../oauth/clients.js";
import type { ClientRecord, ClientStore } from "../oauth/clients.js";
import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata } from "../oauth/metadata.js";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  CALLBACK_PATH,
  CONSENT_SUBMIT_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
} from "../oauth/paths.js";
import { handleToken, parseStoredRefreshHandle } from "../oauth/token.js";
import type { TokenDeps } from "../oauth/token.js";

// The mediating authorization server's one Lambda (design spec §3's diagram, §4.3): the two
// well-known documents, client registration, /authorize + the Cognito callback + consent, and
// /token. It is a ROUTER — every rule about OAuth lives in ../oauth/, and nothing here decides
// anything about a grant.
//
// WHY THIS IS A SEPARATE ENTRY FROM entries/mcp.ts (spec §3.4): Claude allows 10 s for
// discovery, registration and the token endpoint. So this entry carries no MCP SDK runtime and
// no aws-jwt-verify — the two well-known documents are hand-authored constants in
// ../oauth/metadata.ts typed against the SDK's `OAuthMetadata`/`OAuthProtectedResourceMetadata`
// TYPES, which erase at build. Keep every import in this file (and in everything it reaches)
// weight-conscious for the same reason; Task 19 Step 4 greps the synthesized bundle to prove
// the SDK never crept back in as a value import.

// ---------------------------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------------------------

// A LOCAL copy of compositionRoot.ts's three-line requireEnv, deliberately — importing it from
// there would drag the entire composition root (every adapter, the whole application layer, the
// AWS SDK clients none of these endpoints touch) into the bundle of the entry whose cold start
// the two-Lambda split exists to protect (spec §3.4). apps/web makes the same call twice over
// (config.ts, auth/authConfig.ts). What matters is the DISCIPLINE, which is identical: a
// missing var is a loud crash on the FIRST invocation, naming the var — never a per-route 500
// mystery discovered weeks later by whoever happens to hit the one endpoint that needed it.
const requireEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`mcpAuth: missing required env var ${key}`);
  return value;
};

// authConfig.ts's own precedent (the web reads the same class of value from its env): a
// trailing slash on the Cognito domain would build `…amazoncognito.com//oauth2/authorize`,
// which Cognito answers with a redirect loop rather than a legible error.
const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

// ---------------------------------------------------------------------------------------------
// Paths — the routing table, every entry IMPORTED from ../oauth/paths.js and never retyped
// (fix round 1, Minor 4). That file is also what metadata.ts builds its advertised
// `authorization_endpoint`/`token_endpoint`/`registration_endpoint` from, and what authorize.ts
// re-exports for the consent form's `action` and the Cognito app client's callback URL — so the
// path a client is TOLD to use and the path this switch SERVES are the same constant, not two
// literals kept in step by a comment.
// ---------------------------------------------------------------------------------------------

// RFC 9728 §3.1 inserts `.well-known/oauth-protected-resource` between the resource's host and
// its PATH — so the canonical document URL for `https://mcp.beta.swng.golf/mcp` is
// `…/.well-known/oauth-protected-resource/mcp`, which is what the SDK's own
// `getOAuthProtectedResourceMetadataUrl` puts in every 401 challenge (entries/mcp.ts) and what
// a client therefore probes FIRST. The bare path is served too: a client that never saw a
// challenge (or that treats the origin as the resource) asks for that one, and answering 404
// there is a connection failure before anything else is even attempted. Derived from the ONE
// canonical resource, never a second hardcoded "/mcp".
//
// The authorization-server document deliberately gets NO such second path. Its issuer is the
// resource's ORIGIN (metadata.ts), and RFC 8414 §3.3 has the client check that the `issuer` in
// the document it fetched matches the identifier it derived from the URL it fetched it from —
// the SDK enforces exactly that, throwing a dedicated `IssuerMismatchError`. So serving this
// document at `…/oauth-authorization-server/mcp` would POISON the only client that would ask for
// it: one that mistook the resource URL for the AS URL, and that would otherwise have been sent
// to the right document by our PRM's `authorization_servers`. (Corrected in fix round 1: a 404
// there does NOT make that client fall through to the bare path — `buildDiscoveryUrls` never
// includes the bare path once the AS URL has one, so it tries the two OIDC URLs and gives up.
// Not serving it fails; serving it fails WORSE, by breaking the client that had a good route.)
//
// The suffix is NORMALIZED exactly the way the SDK normalizes it (fix round 1, Minor 3):
// `protectedResourceMetadataPath` strips a trailing slash and maps a bare "/" to no suffix at
// all. Without that, an `MCP_RESOURCE` written with a trailing slash makes entries/mcp.ts's
// challenge point at `…/oauth-protected-resource/mcp` while this served `…/mcp/` — and per the
// client's guarded fallback, a 404 there is a hard connection failure, not a slow path. This is
// the one seam where a hand-rolled derivation and the SDK's must agree byte for byte.
//
// Fix round 2, NEW-5: this is the SDK's rule COPIED, not approximated. `stripTrailingSlash` above
// is greedy (`/\/+$/`), which is right for the Cognito domain and WRONG here: the SDK strips
// exactly one slash, and only when the path is longer than "/", so `…/mcp//` derives `…/mcp/`
// where the greedy version derived `…/mcp` — a 404, and per the client's guarded fallback a hard
// connection failure. Two different rules for two different values, each matching what consumes
// it.
const sdkResourcePath = (pathname: string): string => {
  const stripped = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return stripped === "/" ? "" : stripped;
};

const protectedResourceMetadataPathsFor = (resource: string): ReadonlySet<string> =>
  new Set([PROTECTED_RESOURCE_METADATA_PATH, `${PROTECTED_RESOURCE_METADATA_PATH}${sdkResourcePath(new URL(resource).pathname)}`]);

// ---------------------------------------------------------------------------------------------
// Responses this file owns (everything else is a handler's own Response, returned verbatim)
// ---------------------------------------------------------------------------------------------

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// The well-known documents are the one thing here that is safely cacheable — they are public,
// identical for every caller, and Claude's 10 s discovery budget is exactly what a cache spares.
const metadataResponse = (serialized: string): Response =>
  new Response(serialized, { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });

// RFC 7591 §3.2.1: 201, the assigned `client_id`, and the registered metadata echoed back in
// its OAuth spelling — including the three fields this authorization server ASSIGNS rather than
// accepts (it registers public clients only, and issues exactly the two grants its AS metadata
// advertises), because a client that can't see `token_endpoint_auth_method: "none"` has to guess
// how to authenticate at an endpoint that wants no authentication at all.
const registrationResponse = (record: ClientRecord): Response =>
  jsonResponse(
    {
      client_id: record.clientId,
      redirect_uris: record.redirectUris,
      ...(record.clientName !== undefined ? { client_name: record.clientName } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );

// ---------------------------------------------------------------------------------------------
// The composed dependency set — built ONCE per cold start (see buildMcpAuthEntry below)
// ---------------------------------------------------------------------------------------------

interface McpAuthEntry {
  readonly protectedResourceMetadataPaths: ReadonlySet<string>;
  readonly protectedResourceMetadata: string;
  readonly authorizationServerMetadata: string;
  readonly clientStore: ClientStore;
  readonly authorizeDeps: AuthorizeDeps;
  readonly tokenDeps: TokenDeps;
}

const buildMcpAuthEntry = async (env: NodeJS.ProcessEnv): Promise<McpAuthEntry> => {
  // Design spec §4.3: ONE constant, three roles — the MCP endpoint URL, the Cognito resource
  // server identifier, and the PRM `resource`. Read ONCE here (entries/mcp.ts reads the same
  // var for the same value); the AS origin, both metadata documents, the PRM well-known path
  // and the Cognito callback URL all derive from this single read, so there is no second place
  // any of them can drift from it. Never hardcoded per stage — beta and prod share one
  // deployment and differ only by typed env.
  const resource = requireEnv(env, "MCP_RESOURCE");
  const tableName = requireEnv(env, "TABLE_MCP_OAUTH");
  const cognitoDomain = requireEnv(env, "COGNITO_DOMAIN");
  const cognitoClientId = requireEnv(env, "MCP_CLIENT_ID");
  const cognitoClientSecretArn = requireEnv(env, "MCP_CLIENT_SECRET_ARN");

  // compositionRoot.ts's own ordering rule: the secret is fetched AFTER every requireEnv check
  // above, so a missing var still fails fast and synchronously without ever touching the
  // network. The app client is CONFIDENTIAL (spec §6) — token.ts sends the secret as HTTP Basic
  // on every Cognito exchange, so a deployment that forgot it would fail every code redemption
  // with an upstream error that names nothing.
  const clientSecret = await createSecretsManagerReader()(cognitoClientSecretArn);

  // ONE clock for the store's expiries, /token's `expires_in`, and the CIMD cache-header
  // arithmetic — three readers of the same wall clock, never three clocks that could disagree.
  const clock: Clock = { now: () => Date.now() };

  // All FOUR parsers are injected, and all four are load-bearing: createDynamoOAuthStore takes
  // them as required config, and omitting one is not a type error — it is a TypeError the first
  // time that slot is read, in production, on whichever endpoint happens to read it first.
  // CLAUDE.md: parse stored data, never cast it.
  const store = createDynamoOAuthStore({
    client: createDocumentClient(),
    tableName,
    clock,
    parseClient: parseStoredClientRecord,
    parseRequest: parseStoredAuthorizeRequest,
    parseCodeGrant: parseStoredCodeGrant,
    parseHandle: parseStoredRefreshHandle,
  });

  // The one Cognito face both /authorize and /token speak to — the SAME object, so the app
  // client that mints a code is by construction the one that redeems it.
  const cognito: AuthorizeCognitoConfig = {
    domain: stripTrailingSlash(cognitoDomain),
    clientId: cognitoClientId,
    clientSecret,
    callbackUrl: `${new URL(resource).origin}${CALLBACK_PATH}`,
  };

  return {
    protectedResourceMetadataPaths: protectedResourceMetadataPathsFor(resource),
    // Serialized once, at cold start: these documents never vary by request, and discovery is
    // the leg of the flow with the tightest budget.
    protectedResourceMetadata: JSON.stringify(buildProtectedResourceMetadata(resource)),
    authorizationServerMetadata: JSON.stringify(buildAuthorizationServerMetadata(resource)),
    clientStore: store,
    // `fetchImpl`/`generateId`/`generatePkce` are left at their real defaults here; they exist
    // as seams so ../oauth/'s own tests stay offline and deterministic, not as production knobs.
    authorizeDeps: { resource, clientStore: store, cimd: { clock }, store, cognito },
    tokenDeps: { store, cognito, clock },
  };
};

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

// registerDcrClient is the one handler not shaped like the others — it takes the raw body STRING
// (RFC 7591's JSON envelope; /token and consent are form-encoded, which is why the parsers are
// separate), so the adaptation lives here.
//
// The method IS pinned, unlike /authorize and the callback: those two read only the query
// string, so their behaviour is method-independent and correct either way, whereas a GET here
// would reach registerDcrClient with an empty body and answer "registration request body is not
// valid JSON" — a 400 that describes the wrong problem. (handleConsentSubmit and handleToken
// pin their own methods for the stronger reason that a body-shaped request on any verb would
// otherwise mint or redeem a credential.)
const routeRegister = async (request: Request, store: ClientStore): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "invalid_request", error_description: "client registration accepts POST only" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST", "cache-control": "no-store" },
    });
  }

  try {
    return registrationResponse(await registerDcrClient(await request.text(), { store }));
  } catch (error) {
    if (!(error instanceof ClientRegistrationError)) throw error;
    // RFC 7591 §3.2.2. The message is forwarded here — and NOT at /authorize below — because
    // every ClientRegistrationError this endpoint can raise is a verdict on the caller's OWN
    // submitted JSON, which tells them nothing they didn't send us.
    return jsonResponse({ error: "invalid_client_metadata", error_description: error.message }, 400);
  }
};

// The `cause` channel carries two shapes and both have to survive into the log: an ERROR for the
// network-layer failures clients.ts wraps (fix round 1), and a STRING for the resolved address the
// SSRF refusal keeps out of its own message (fix round 2). Rendering only the first would silently
// drop exactly the detail the second exists to preserve.
const describeCause = (cause: unknown): string | undefined => {
  if (cause === undefined) return undefined;
  return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
};

const routeAuthorize = async (request: Request, deps: AuthorizeDeps): Promise<Response> => {
  try {
    return await handleAuthorize(request, deps);
  } catch (error) {
    if (!(error instanceof ClientRegistrationError)) throw error;
    // A URL-shaped `client_id` sends handleAuthorize's resolveClient off to FETCH that document,
    // and every SSRF refusal, timeout, size cap and malformed-document verdict arrives here as a
    // ClientRegistrationError. It is the caller's fault, not ours — a 400 in the same shape
    // handleAuthorize's own `unknown client_id` uses (JSON, and never a redirect: the redirect
    // URI is not yet trusted, which is the whole reason that function refuses to redirect its
    // early errors).
    //
    // The message is LOGGED, never forwarded. THIS FIXED BODY IS THE LOAD-BEARING CONTROL (fix
    // round 2, correcting fix round 1's own claim): clients.ts giving every network-layer failure
    // one message is defence in depth, not the guarantee — `assertPublicHttpsUrl` still names the
    // hostname it refused, and only this response shape keeps any of it from reaching a stranger.
    // Echoing `error.message` here re-opens the oracle in one line, which is why two tests fail
    // the moment anyone does.
    // The `cause` is where the real DNS/TLS/socket failure lives now (fix round 1, Important 1:
    // clients.ts gives every network-layer failure ONE fixed message so the answer can't be read
    // as an oracle) — so the operator's log has to unwrap it, or the diagnosis is gone.
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "mcpAuth: /authorize could not resolve the client",
        error: error.message,
        cause: describeCause(error.cause),
      }),
    );
    return jsonResponse({ error: "invalid_request", error_description: "the client_id could not be resolved" }, 400);
  }
};

// A path switch, one arm per surface the ../oauth/ modules expose (design spec §3's diagram).
// Everything else is 404 — an unrouted path is a feature that is dead on arrival.
const route = async (request: Request, entry: McpAuthEntry): Promise<Response> => {
  const { pathname } = new URL(request.url);

  // Checked before the switch because it is the one path DERIVED from the canonical resource
  // rather than fixed (see protectedResourceMetadataPathsFor).
  if (entry.protectedResourceMetadataPaths.has(pathname)) return metadataResponse(entry.protectedResourceMetadata);

  switch (pathname) {
    case AUTHORIZATION_SERVER_METADATA_PATH:
      return metadataResponse(entry.authorizationServerMetadata);
    case REGISTER_PATH:
      return routeRegister(request, entry.clientStore);
    case AUTHORIZE_PATH:
      return routeAuthorize(request, entry.authorizeDeps);
    case CALLBACK_PATH:
      return handleCallback(request, entry.authorizeDeps);
    case CONSENT_SUBMIT_PATH:
      return handleConsentSubmit(request, entry.authorizeDeps);
    case TOKEN_PATH:
      return handleToken(request, entry.tokenDeps);
    default:
      return jsonResponse({ error: "not_found", error_description: `no authorization-server endpoint at ${pathname}` }, 404);
  }
};

// ---------------------------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------------------------

let entryPromise: Promise<McpAuthEntry> | undefined;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  // The same cached-promise idiom entries/http.ts and entries/mcp.ts document: `??=` alone would
  // keep a REJECTED promise cached forever, and Lambda does not recycle a warm container just
  // because a handler threw — so one transient cold-start failure (a Secrets Manager throttle,
  // an AccessDenied in the narrow deploy window before the grantRead policy attaches) would
  // 500 every request for that container's whole remaining life. Clearing it back to undefined
  // before rethrowing makes the NEXT invocation rebuild from scratch.
  entryPromise ??= buildMcpAuthEntry(process.env).catch((e: unknown) => {
    entryPromise = undefined;
    throw e;
  });

  // DELIBERATELY OUTSIDE the boundary below: a cold-start failure must stay a loud, unhandled
  // Lambda error (logged with its stack, visible on the function's error metric and alarm), not
  // a tidy 500 that looks like an ordinary bad request.
  const entry = await entryPromise;

  // Fix round 1, Minor 2: `toFetchRequest` THROWS on inputs API Gateway can still deliver — undici
  // refuses the fetch spec's forbidden methods (`TRACE`/`CONNECT`/`TRACK`), and a malformed `Host`
  // fails `new URL(...)`. Above the boundary that was an unhandled Lambda error: a 502 and a
  // function-error metric for what is plainly a bad request. It gets its OWN catch rather than
  // joining the 500 boundary below, because the caller sent something unrepresentable — that is a
  // 400, and folding it into `server_error` would blame us for their request.
  let request: Request;
  try {
    request = toFetchRequest(event);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "mcpAuth: request could not be represented",
        path: event.rawPath,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return fromFetchResponse(jsonResponse({ error: "invalid_request", error_description: "the request could not be parsed" }, 400));
  }

  try {
    return await fromFetchResponse(await route(request, entry));
  } catch (error) {
    // The error boundary ../oauth/token.ts's header names: a store fault or a stored record
    // that fails its parser on the way out is a SERVER-side fault, not the caller's — it must
    // never wear `invalid_grant`, which would make a client discard a perfectly good refresh
    // handle over a DynamoDB throttle. Logged in full; answered with nothing (the messages name
    // tables, ARNs and internal shapes).
    console.error(
      JSON.stringify({
        level: "error",
        message: "mcpAuth: unhandled failure",
        path: new URL(request.url).pathname,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      }),
    );
    return fromFetchResponse(jsonResponse({ error: "server_error", error_description: "the authorization server failed to handle this request" }, 500));
  }
};
