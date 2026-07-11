import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { AccountClaims, AccountVerifier, Logger, ParticipantClaims, TokenIssuer } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { ContractError, parse } from "@swng/contracts";
import type { Route, RouteContext } from "./routes.js";
import { jsonResponse, toHttpError } from "./errorMapping.js";

const BEARER_PREFIX = "Bearer ";

// Splits a request path into decoded, non-empty segments. Decoding happens ONCE per request
// here rather than per candidate route in matchPath below — and a malformed percent-escape
// (e.g. `/rounds/%zz/scores`) is a client mistake, not a routing failure, so it's raised as
// a ContractError (400 via errorMapping.ts) rather than left to throw a raw URIError.
const decodePathSegments = (path: string): string[] =>
  path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new ContractError("invalid-request", [`path: malformed percent-escape in segment "${segment}"`]);
      }
    });

// Matches already-decoded path segments against a route's `{name}` template one segment at a
// time — the one generic path matcher every route shares (conventions §3: "do each
// cross-cutting thing once"), rather than each route hand-rolling its own parse.
const matchPath = (template: string, actualSegments: readonly string[]): Record<string, string> | undefined => {
  const templateSegments = template.split("/").filter(Boolean);
  if (templateSegments.length !== actualSegments.length) return undefined;

  const pathParams: Record<string, string> = {};
  for (let i = 0; i < templateSegments.length; i += 1) {
    const templateSegment = templateSegments[i]!;
    const actualSegment = actualSegments[i]!;
    if (templateSegment.startsWith("{") && templateSegment.endsWith("}")) {
      pathParams[templateSegment.slice(1, -1)] = actualSegment;
    } else if (templateSegment !== actualSegment) {
      return undefined;
    }
  }
  return pathParams;
};

const bearerToken = (event: APIGatewayProxyEventV2): string | undefined => {
  // HTTP API (payload format 2.0) lower-cases header names, but this never trusts that.
  const header = event.headers["authorization"] ?? event.headers["Authorization"];
  return header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : undefined;
};

const readJsonBody = (event: APIGatewayProxyEventV2): unknown => {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ContractError("invalid-request", ["body: invalid JSON"]);
  }
};

// One generic dispatcher over the declarative route table (conventions §3): routing,
// auth, parsing, and error-mapping all happen exactly once, here, never per-route.
export const createDispatcher =
  (routes: readonly Route[], tokens: TokenIssuer, verifier: AccountVerifier, logger: Logger) =>
  async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    try {
      // Route matching (including decodePathSegments, which can throw on a malformed
      // percent-escape) lives inside this try too — every failure from here down must come
      // out mapped, never as an unhandled Lambda crash.
      const pathSegments = decodePathSegments(path);

      let route: Route | undefined;
      let pathParams: Record<string, string> | undefined;
      for (const candidate of routes) {
        if (candidate.method !== method) continue;
        const candidateParams = matchPath(candidate.path, pathSegments);
        if (candidateParams) {
          route = candidate;
          pathParams = candidateParams;
          break;
        }
      }
      if (!route || !pathParams) {
        // Routed through errorMapping's jsonResponse rather than hand-built here — one
        // error-shaping site, even though "no route matched" never becomes a thrown error
        // (there's nothing to throw against; `route` is just undefined).
        const { statusCode, body } = jsonResponse(404, { code: "not-found", message: `no route for ${method} ${path}` });
        return { statusCode, headers: { "content-type": "application/json" }, body };
      }

      let claims: ParticipantClaims | undefined;
      if (route.auth === "participant") {
        const token = bearerToken(event);
        const verified = token ? tokens.verify(token) : undefined;
        if (!verified) throw new ApplicationError("invalid-token");
        // Every "participant" route declares a {roundId} path segment (routes.ts) — a
        // token minted for a different round must never authorize this path.
        if (verified.roundId !== pathParams.roundId) throw new ApplicationError("token-round-mismatch");
        claims = verified;
      }

      let account: AccountClaims | undefined;
      if (route.auth === "golfer" || route.auth === "optional-golfer") {
        const token = bearerToken(event);
        if (!token) {
          // "golfer" REQUIRES a token — missing is a 401, same as "participant" above.
          // "optional-golfer" (M8 Task 4: StartRound/JoinRound) proceeds anonymously instead
          // — ctx.account simply stays unset, byte-identical to this route's pre-M8 behavior.
          if (route.auth === "golfer") throw new ApplicationError("invalid-token");
        } else {
          // A PRESENTED token is verified on both tiers, identically — "optional-golfer" never
          // silently swallows a bad token into "treat as anonymous" (fail loud: a client that
          // sent a token meant it). The injected AccountVerifier rejects on a bad signature,
          // expiry, or wrong issuer/audience (createCognitoVerifier's own doc comment) — every
          // one of those collapses to the same 401 a missing/garbage bearer token already
          // produces above, never a distinct error code a client could use to enumerate WHY a
          // token failed.
          account = await verifier.verify(token).catch(() => {
            throw new ApplicationError("invalid-token");
          });
        }
      }

      const body = route.schema ? parse(route.schema, readJsonBody(event)) : undefined;
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
        if (value !== undefined) query[key] = value;
      }
      const ctx: RouteContext = { claims, account, pathParams, query };

      const result = await route.handler(ctx, body);
      return { statusCode: route.successStatus, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
    } catch (error) {
      const { statusCode, body } = toHttpError(error, logger);
      return { statusCode, headers: { "content-type": "application/json" }, body };
    }
  };
