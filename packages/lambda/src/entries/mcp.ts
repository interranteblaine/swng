import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { OAuthError, OAuthErrorCode, getOAuthProtectedResourceMetadataUrl, originValidationResponse, requireBearerAuth } from "@modelcontextprotocol/server";
import type { AuthInfo, McpHttpHandler, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { accountVerifierFromAccessToken, createAccessTokenVerifier } from "@swng/adapters-cognito";
import { buildApp } from "../compositionRoot.js";
import type { App } from "../compositionRoot.js";
import { fromFetchResponse, toFetchRequest } from "../http/fetchAdapter.js";
import { createSwngMcpHandler } from "../mcp/server.js";

// Design spec §4.3: ONE constant, three roles — the MCP endpoint URL, the Cognito resource
// server identifier, and the PRM `resource`. Read once from env (never hardcoded per-stage,
// the same requireEnv discipline compositionRoot.ts's own buildApp uses for every other
// stage-varying value — CLAUDE.md: beta and prod share one Lambda deployment, differing only by
// typed env, never a code branch) and referenced everywhere below — `writeScope`,
// `resourceMetadataUrl`, and both Cognito verifiers' `resource` argument all derive from this
// ONE read, so there is no second place `CANONICAL` could drift from itself.
const requireEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`entries/mcp: missing required env var ${key}`);
  return value;
};

// Requirement 1 (task-13 brief / design spec §4.3's "Verification at the endpoint"): the SDK's
// own bearerAuthChallengeResponse answers a non-OAuthError with a bare 500 — no
// WWW-Authenticate, no challenge — which is exactly wrong for a wrong-audience token or an
// ordinary expired one, both of which createAccessTokenVerifier (Task 9) throws as a plain
// Error. Wrapped here at the seam between the adapter and requireBearerAuth: every rejection
// becomes an OAuthError(InvalidToken), which bearerAuthChallengeResponse maps to 401 +
// `WWW-Authenticate: Bearer …` — the exact answer a client's refresh/re-authorize recovery
// keys on. An OAuthError thrown by the verifier itself (there is none today, but a future one
// might reasonably want the InsufficientScope/ServerError distinction) passes through
// unwrapped rather than being reclassified.
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
      throw new OAuthError(OAuthErrorCode.InvalidToken, error instanceof Error ? error.message : String(error));
    }
  },
});

// Design spec §7: "the policy is deliberately permissive — any Origin admitted, the header
// logged" — this is a public HTTPS endpoint whose only credential is a bearer token in a
// header, so there is no ambient cookie authority a rebound-hostname Origin could borrow, and
// an allow-list of swng web origins would 403 the very browser-hosted MCP clients this exists
// to serve while admitting a set that never calls this endpoint at all. Echoing the request's
// OWN Origin hostname back as its allowlist keeps `originValidationResponse`'s real checks live
// (a missing Origin always passes; an opaque/unparseable one is still refused) without ever
// rejecting a legitimate one.
const permissiveOriginAllowlist = (request: Request): string[] => {
  const origin = request.headers.get("origin");
  if (origin === null) return [];
  try {
    return [new URL(origin).hostname];
  } catch {
    return [];
  }
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
  const resource = requireEnv(env, "MCP_RESOURCE");
  const userPoolId = requireEnv(env, "USER_POOL_ID");
  const mcpClientId = requireEnv(env, "MCP_CLIENT_ID");
  const writeScope = `${resource}/write`;

  // Requirement 1: the OAuthTokenVerifier requireBearerAuth gates on — Task 9's
  // createAccessTokenVerifier, wrapped so its plain-Error rejections answer 401, never 500.
  const tokenVerifier = wrapVerifierErrorsAsInvalidToken(createAccessTokenVerifier({ userPoolId, clientId: mcpClientId, resource }));

  // Requirement 3: the account verifier Task 11's dispatcher seam (buildApp's
  // `deps.accountVerifier`) needs, wired through Task 9's OTHER adapter — accountVerifierFromAccessToken
  // — WITH its resource argument. A second CognitoJwtVerifier.create() (a second JWKS cache,
  // same user pool/app client as tokenVerifier's own) rather than reusing one instance across
  // both: accessTokenVerifierFrom (createAccessTokenVerifier's own internal builder) is not
  // part of @swng/adapters-cognito's public surface, and duplicating one more RS256 verify per
  // request — the SAME token is independently re-verified inside app.dispatcher for every
  // "golfer"-tier tool call regardless (toolDispatch.ts sends the caller's own bearer straight
  // through) — costs nothing a JWKS-cached Lambda container notices.
  const accountVerifier = accountVerifierFromAccessToken(
    CognitoJwtVerifier.create({ userPoolId, tokenUse: "access", clientId: mcpClientId }),
    resource,
  );

  const app: App = await buildApp(env, { accountVerifier });

  const gate = requireBearerAuth({ verifier: tokenVerifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)) });

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

  const request = toFetchRequest(event);

  const originRejection = originValidationResponse(request, permissiveOriginAllowlist(request));
  if (originRejection) return fromFetchResponse(originRejection);

  const auth = await entry.gate(request);
  if (auth instanceof Response) return fromFetchResponse(auth);

  return fromFetchResponse(await entry.mcpHandler.fetch(request, { authInfo: auth }));
};
