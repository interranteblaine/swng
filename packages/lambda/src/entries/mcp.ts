import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { OAuthError, OAuthErrorCode, getOAuthProtectedResourceMetadataUrl, originValidationResponse, requireBearerAuth } from "@modelcontextprotocol/server";
import type { AuthInfo, McpHttpHandler, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { createMcpVerifiers } from "@swng/adapters-cognito";
import { buildApp, requireEnv } from "../compositionRoot.js";
import type { App } from "../compositionRoot.js";
import { fromFetchResponse, toFetchRequest } from "../http/fetchAdapter.js";
import { createSwngMcpHandler } from "../mcp/server.js";

// Requirement 1 (task-13 brief / design spec §4.3's "Verification at the endpoint"): the SDK's
// own bearerAuthChallengeResponse answers a non-OAuthError with a bare 500 — no
// WWW-Authenticate, no challenge — which is exactly wrong for a wrong-audience token or an
// ordinary expired one, both of which Task 9's adapters throw as a plain Error. Wrapped here at
// the seam between the adapter and requireBearerAuth: every rejection becomes an
// OAuthError(InvalidToken), which bearerAuthChallengeResponse maps to 401 +
// `WWW-Authenticate: Bearer …` — the exact answer a client's refresh/re-authorize recovery
// keys on. An OAuthError thrown by the verifier itself (there is none today, but a future one
// might reasonably want the InsufficientScope/ServerError distinction) passes through
// unwrapped rather than being reclassified.
//
// Review round 1, fix 5: the raw verifier's own message (which names the exact expected
// audience — e.g. `Token audience does not match required resource "https://…"`) is NEVER
// forwarded. The SDK renders `error.message` verbatim into BOTH the `WWW-Authenticate` header's
// `error_description` and the JSON body, so an unauthenticated caller would otherwise learn
// swng's exact resource identifier for free. A fixed, generic description carries the same
// actionable signal (re-authenticate) with nothing to fingerprint.
//
// Exported (not module-private) solely so mcp.test.ts can prove the 401-not-500 mapping
// directly against `requireBearerAuth` — the real SDK gate, not a re-implementation of its
// status-code logic — without standing up a whole buildMcpEntry (Cognito/DynamoDB/Secrets
// Manager config this test has no business needing).
export const wrapVerifierErrorsAsInvalidToken = (verifier: OAuthTokenVerifier): OAuthTokenVerifier => ({
  verifyAccessToken: async (token: string): Promise<AuthInfo> => {
    try {
      return await verifier.verifyAccessToken(token);
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid, expired, or was not issued for this resource.");
    }
  },
});

// Design spec §7: "the policy is deliberately permissive — any Origin admitted, the header
// logged" — this is a public HTTPS endpoint whose only credential is a bearer token in a
// header, so there is no ambient cookie authority a rebound-hostname Origin could borrow, and
// an allow-list of swng web origins would 403 the very browser-hosted MCP clients this exists
// to serve while admitting a set that never calls this endpoint at all. Echoing the request's
// OWN Origin hostname back as its allowlist keeps `originValidationResponse`'s real checks live
// (a well-formed Origin always passes; an unparseable one is still refused) without ever
// rejecting a legitimate one. The literal string `"null"` (what a browser sends for a
// sandboxed/opaque origin — one of the browser-hosted MCP clients this targets) is handled
// separately in `handler` below: `new URL("null")` throws, so it can't be echoed back this way,
// and `originValidationResponse` has no built-in exception for it the way it does for a
// genuinely MISSING header.
const permissiveOriginAllowlist = (request: Request): string[] => {
  const origin = request.headers.get("origin");
  if (origin === null) return [];
  try {
    return [new URL(origin).hostname];
  } catch {
    return [];
  }
};

// Design spec §7: "No streaming... none of the fifteen comes close." — but `createMcpHandler`
// serves `subscriptions/listen` UNCONDITIONALLY (no capability check — verified against the
// SDK's own source, `dist/index.mjs`'s modern-route handling), answering with a `Response` over
// a stream that emits an ack then keepalive frames forever, closing only on transport teardown.
// This is not just an abuse vector: `McpServer` advertises `tools.listChanged`, so a
// well-behaved 2026-07-28 client may legitimately open one on first connect. Buffering that
// Response (`fromFetchResponse`'s `await response.text()`) never resolves — API Gateway 29s-
// timeouts, burning one invocation per attempt, every time.
//
// Refused HERE, before the real handler ever runs, keyed on the `Mcp-Method` header the shim
// guarantees survives (fetchAdapter.test.ts's own "preserves Mcp-Method and Mcp-Name") — a
// legitimate modern-era request always carries it (the transport's own header/body
// cross-check depends on it), so this never needs to parse the body on the hot path. Exported
// for the same reason `wrapVerifierErrorsAsInvalidToken` is: a direct, fast test that proves
// this returns promptly rather than hanging.
const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";

export const rejectSubscriptionsListen = async (request: Request): Promise<Response | undefined> => {
  if (request.headers.get("mcp-method") !== SUBSCRIPTIONS_LISTEN_METHOD) return undefined;

  // Best-effort: echo the caller's own JSON-RPC id back when it's cheaply readable, so the
  // rejection is a well-formed correlated JSON-RPC error rather than a bare id:null — never
  // throws on a malformed/unreadable body, which would defeat the whole point of answering
  // promptly instead of hanging.
  let id: string | number | null = null;
  try {
    const body: unknown = JSON.parse(await request.clone().text());
    if (body !== null && typeof body === "object" && !Array.isArray(body) && "id" in body) {
      const candidate = (body as { id?: unknown }).id;
      if (typeof candidate === "string" || typeof candidate === "number") id = candidate;
    }
  } catch {
    // Body unreadable/not JSON — id stays null, matching every other entry-built error response
    // this file and the SDK itself produce for the cases where no id is determinable.
  }

  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "subscriptions/listen is not supported — this endpoint serves no long-lived stream (design spec §7)." },
    },
    { status: 404 },
  );
};

interface McpEntry {
  readonly gate: (request: Request) => Promise<AuthInfo | Response>;
  readonly mcpHandler: McpHttpHandler;
}

// Built ONCE per cold start, the same cached-promise idiom entries/http.ts documents (a
// rejected promise is cleared back to undefined before rethrowing, so a transient cold-start
// failure — a JWKS fetch blip, a Secrets Manager throttle — retries on the NEXT invocation
// instead of poisoning the whole warm container).
const buildMcpEntry = async (env: NodeJS.ProcessEnv): Promise<McpEntry> => {
  // Design spec §4.3: ONE constant, three roles — the MCP endpoint URL, the Cognito resource
  // server identifier, and the PRM `resource`. Read once from env (never hardcoded per-stage —
  // beta and prod share one Lambda deployment, differing only by typed env, never a code
  // branch) and referenced everywhere below — `writeScope`, `resourceMetadataUrl`, and the
  // shared Cognito verifier's `resource` argument all derive from this ONE read, so there is no
  // second place `CANONICAL` could drift from itself.
  const resource = requireEnv(env, "MCP_RESOURCE");
  const userPoolId = requireEnv(env, "USER_POOL_ID");
  const mcpClientId = requireEnv(env, "MCP_CLIENT_ID");
  const writeScope = `${resource}/write`;

  // Review round 1, fix 2: buildApp treats TABLE_CORE/TABLE_PROJECTIONS/TABLE_SNAPSHOTS as
  // OPTIONAL (compositionRoot.ts's own unavailable* stores) — a story that's correct for
  // wsConnect/wsDisconnect, which never dispatch a course/golfer/crew/finalize route, but wrong
  // for this entry: the MCP tool surface calls get_course/whoami/start_round (TABLE_CORE),
  // list_my_rounds/my_course_record (TABLE_PROJECTIONS) and finalize_round (TABLE_SNAPSHOTS)
  // among the rest. Left optional here, a missing var would surface as a per-tool 500 mystery
  // the first time an agent happens to call one of those six tools — required here instead so a
  // missing var is a loud cold-start crash on the VERY FIRST invocation, not a scavenger hunt.
  requireEnv(env, "TABLE_CORE");
  requireEnv(env, "TABLE_PROJECTIONS");
  requireEnv(env, "TABLE_SNAPSHOTS");

  // Review round 1, fix 3: BOTH Cognito faces this entry needs — the OAuthTokenVerifier
  // requireBearerAuth gates on, and the AccountVerifier Task 11's dispatcher seam
  // (buildApp's `deps.accountVerifier`) needs — built over ONE shared CognitoJwtVerifier
  // instance, in the adapters layer where Cognito construction belongs (docs/engineering-
  // conventions.md) rather than a second raw verifier built directly here. One JWKS cache, one
  // cold-start fetch, one RS256 verify per token per request.
  const { tokenVerifier, accountVerifier } = createMcpVerifiers({ userPoolId, clientId: mcpClientId, resource });

  // Requirement 3 (task-13 brief): wired through Task 11's seam WITH its resource argument
  // already applied inside createMcpVerifiers above.
  const app: App = await buildApp(env, { accountVerifier });

  const gate = requireBearerAuth({
    verifier: wrapVerifierErrorsAsInvalidToken(tokenVerifier),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)),
  });

  // Requirement 2 + 4: writeScope is CANONICAL + "/write", supplied explicitly (Task 12 left it
  // with no default on purpose); routes is buildApp's OWN buildRoutes(useCases) output
  // (App.routes, added this task), never a second `buildRoutes(...)` call re-derived here.
  const mcpHandler = createSwngMcpHandler({ dispatch: app.dispatcher, routes: app.routes, writeScope });

  return { gate, mcpHandler };
};

let entryPromise: Promise<McpEntry> | undefined;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  entryPromise ??= buildMcpEntry(process.env).catch((e) => {
    entryPromise = undefined;
    throw e;
  });
  const entry = await entryPromise;

  // swng-speaks-mcp task-19 fix round 1, Minor 2 (the same two lines in entries/mcpAuth.ts, and
  // the reason this already-deployed entry is edited alongside it): `toFetchRequest` THROWS on
  // inputs API Gateway can still deliver — undici refuses the fetch spec's forbidden methods
  // (`TRACE`/`CONNECT`/`TRACK`), and a malformed `Host` header fails `new URL(...)`. Unguarded,
  // that is an unhandled Lambda error — API Gateway answers 502 and the function's error metric
  // (and its alarm) fires for what is plainly a bad request. Answered here as a well-formed
  // JSON-RPC `-32600 Invalid Request`, the same shape every other refusal this entry writes
  // itself uses.
  let request: Request;
  try {
    request = toFetchRequest(event);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "mcp: request could not be represented",
        path: event.rawPath,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return fromFetchResponse(
      Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "The request could not be parsed." } }, { status: 400 }),
    );
  }

  // Review round 1, fix 6: log the Origin header unconditionally (spec §7's "the header
  // logged"), then treat a missing header AND the literal string "null" (a sandboxed/opaque
  // browser origin) identically — admitted, no gate call. `originValidationResponse` already
  // has its own fast path for a genuinely missing header; "null" needs this explicit one
  // because `new URL("null")` throws, so it can't reach that fast path through
  // permissiveOriginAllowlist's echo trick the way any OTHER present Origin does.
  const originHeader = request.headers.get("origin");
  console.log(JSON.stringify({ level: "info", message: "mcp: request Origin", origin: originHeader }));
  if (originHeader !== null && originHeader !== "null") {
    const originRejection = originValidationResponse(request, permissiveOriginAllowlist(request));
    if (originRejection) return fromFetchResponse(originRejection);
  }

  const auth = await entry.gate(request);
  if (auth instanceof Response) return fromFetchResponse(auth);

  const subscriptionsRejection = await rejectSubscriptionsListen(request);
  if (subscriptionsRejection) return fromFetchResponse(subscriptionsRejection);

  return fromFetchResponse(await entry.mcpHandler.fetch(request, { authInfo: auth }));
};
