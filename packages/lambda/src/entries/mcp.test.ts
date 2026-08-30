import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { requireBearerAuth } from "@modelcontextprotocol/server";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { buildRoutes } from "../http/routes.js";
import type { UseCases } from "../http/routes.js";
import type { App } from "../compositionRoot.js";
import { rejectSubscriptionsListen, wrapVerifierErrorsAsInvalidToken } from "./mcp.js";

const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const WRITE_SCOPE = `${CANONICAL}/write`;
const READ_SCOPE = `${CANONICAL}/read`;
const futureExpiry = (): number => Math.floor(Date.now() / 1000) + 3600;

// Requirement 1 (task-13 brief): Task 9's createAccessTokenVerifier throws a plain Error on a
// wrong-audience or expired token. Fed straight to requireBearerAuth, the SDK's own
// bearerAuthChallengeResponse answers a non-OAuthError with a bare 500 and no
// WWW-Authenticate — the client's refresh/re-authorize recovery keys on exactly that header, so
// this is the whole point of the fix, proven end to end through the REAL SDK gate rather than
// by reading the wrapper's source.
const rejectingVerifier: OAuthTokenVerifier = {
  verifyAccessToken: async (): Promise<AuthInfo> => {
    throw new Error(`Token audience does not match required resource "${CANONICAL}"`);
  },
};

const requestWithBearer = (token: string): Request => new Request(CANONICAL, { headers: { authorization: `Bearer ${token}` } });

describe("wrapVerifierErrorsAsInvalidToken", () => {
  it("BASELINE: an unwrapped plain-Error verifier answers 500, no WWW-Authenticate — the bug this task fixes", async () => {
    const gate = requireBearerAuth({ verifier: rejectingVerifier, resourceMetadataUrl: `${CANONICAL}/.well-known/oauth-protected-resource/mcp` });

    const result = await gate(requestWithBearer("bad-token"));

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(500);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("wrapped, the SAME rejection answers 401 with a WWW-Authenticate: Bearer challenge, not 500 — and never leaks the raw verifier message", async () => {
    const gate = requireBearerAuth({
      verifier: wrapVerifierErrorsAsInvalidToken(rejectingVerifier),
      resourceMetadataUrl: `${CANONICAL}/.well-known/oauth-protected-resource/mcp`,
    });

    const result = await gate(requestWithBearer("bad-token"));

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // Review round 1, fix 5: the raw verifier's own message (which names the exact expected
    // audience) must never reach `error_description` — the field the SDK renders verbatim into
    // both the header and the JSON body. `resource_metadata` legitimately carries the resource
    // URL (RFC 9728 discovery, present on every challenge regardless of WHY it failed), so the
    // assertion targets `error_description`/the body's `error_description` specifically, not
    // the whole header line.
    const description = /error_description="([^"]*)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1];
    expect(description).not.toContain(CANONICAL);
    expect(description).toBe("The access token is invalid, expired, or was not issued for this resource.");
    const body = (await response.json()) as { error_description?: string };
    expect(body.error_description).not.toContain(CANONICAL);
  });

  it("passes an AuthInfo through untouched on success", async () => {
    const info: AuthInfo = { token: "t", clientId: "c", scopes: [], expiresAt: futureExpiry() };
    const verifier: OAuthTokenVerifier = { verifyAccessToken: async () => info };

    const gate = requireBearerAuth({ verifier: wrapVerifierErrorsAsInvalidToken(verifier) });

    await expect(gate(requestWithBearer("good-token"))).resolves.toEqual(info);
  });
});

// Review round 1, fix 1: createMcpHandler serves subscriptions/listen unconditionally with a
// Response over a stream that only closes on transport teardown — buffering it (fromFetchResponse's
// `await response.text()`) never resolves, and API Gateway 29s-times-out, burning one invocation
// per attempt. rejectSubscriptionsListen is the guard that answers PROMPTLY instead.
describe("rejectSubscriptionsListen", () => {
  it("returns undefined (nothing to refuse) for an ordinary tool call", async () => {
    const request = new Request(CANONICAL, { method: "POST", headers: { "mcp-method": "tools/call" }, body: "{}" });
    await expect(rejectSubscriptionsListen(request)).resolves.toBeUndefined();
  });

  it("refuses subscriptions/listen promptly with 404 + JSON-RPC -32601, echoing the request id", async () => {
    const request = new Request(CANONICAL, {
      method: "POST",
      headers: { "mcp-method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "subscriptions/listen", params: {} }),
    });

    const response = await rejectSubscriptionsListen(request);

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(404);
    const body: unknown = await response?.json();
    expect(body).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: expect.stringContaining("subscriptions/listen") } });
  });

  it("still refuses with id:null when the body is unreadable — never throws, never hangs", async () => {
    const request = new Request(CANONICAL, { method: "POST", headers: { "mcp-method": "subscriptions/listen" }, body: "not json" });

    const response = await rejectSubscriptionsListen(request);

    expect(response).toBeInstanceOf(Response);
    const body = (await response?.json()) as { id: unknown };
    expect(body.id).toBeNull();
  });
});

// The assembled entry (review round 1, fix 4): every seam pinned by a real test through the
// REAL `handler` export, not held together only by inspection. Mocks exactly two boundaries —
// @swng/adapters-cognito's createMcpVerifiers (the Cognito/JWKS boundary) and
// ../compositionRoot.js's buildApp (the DynamoDB/Secrets-Manager boundary) — the same class of
// boundary mock entries/http.test.ts uses for its own secret-reader seam. `../mcp/server.js`'s
// createSwngMcpHandler is spied, not replaced (`mockImplementation(actual.createSwngMcpHandler)`)
// so it still runs for real — this proves both the ARGUMENTS entries/mcp.ts hands it (writeScope,
// routes) AND that they produce the right runtime behavior (tools/list's own scope filtering).
const tokenVerifierMock = vi.hoisted(() => ({ verifyAccessToken: vi.fn() }));
const accountVerifierMock = vi.hoisted(() => ({ verify: vi.fn() }));
const createMcpVerifiersMock = vi.hoisted(() => vi.fn(() => ({ tokenVerifier: tokenVerifierMock, accountVerifier: accountVerifierMock })));

vi.mock("@swng/adapters-cognito", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@swng/adapters-cognito")>();
  return { ...actual, createMcpVerifiers: createMcpVerifiersMock };
});

const dispatchSpy = vi.hoisted(() =>
  vi.fn(async () => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) })),
);
// The REAL buildRoutes output (the same stub-UseCases pattern mcp/server.test.ts's own ROUTES
// constant uses) — a distinguishable object identity `app.routes` returns, so `toHaveBeenCalledWith`
// below can prove createSwngMcpHandler received THIS array, not a second one re-derived at the
// call site (Task 11's own flag — requirement 4).
const stubUseCases = new Proxy({}, { get: () => async () => undefined }) as UseCases;
const FAKE_ROUTES = buildRoutes(stubUseCases);
const buildAppMock = vi.hoisted(() => vi.fn());

vi.mock("../compositionRoot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compositionRoot.js")>();
  return { ...actual, buildApp: buildAppMock };
});

const createSwngMcpHandlerMock = vi.hoisted(() => vi.fn());

vi.mock("../mcp/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/server.js")>();
  createSwngMcpHandlerMock.mockImplementation(actual.createSwngMcpHandler);
  return { ...actual, createSwngMcpHandler: createSwngMcpHandlerMock };
});

let handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

beforeAll(async () => {
  process.env["MCP_RESOURCE"] = CANONICAL;
  process.env["USER_POOL_ID"] = "us-east-1_TestPool1";
  process.env["MCP_CLIENT_ID"] = "test-mcp-client-id";
  // Review round 1, fix 2: these three are OPTIONAL to buildApp itself, but this entry's own
  // requireEnv calls (entries/mcp.ts) make them mandatory at cold start — set here so the
  // (mocked) buildApp call is reached at all; buildAppMock never reads them itself.
  process.env["TABLE_CORE"] = "core-table";
  process.env["TABLE_PROJECTIONS"] = "projections-table";
  process.env["TABLE_SNAPSHOTS"] = "snapshots-table";

  buildAppMock.mockResolvedValue({
    dispatcher: dispatchSpy,
    // Neither registry nor tokens is ever read by this test — the assembled entry (entries/mcp.ts)
    // only reads `app.dispatcher` and `app.routes` — so a bare object cast stands in rather than a
    // fully-shaped fake.
    registry: {} as App["registry"],
    tokens: {} as App["tokens"],
    routes: FAKE_ROUTES,
  } satisfies App);

  const mod = await import("./mcp.js");
  handler = mod.handler as typeof handler;
});

beforeEach(() => {
  tokenVerifierMock.verifyAccessToken.mockReset();
  accountVerifierMock.verify.mockReset();
  dispatchSpy.mockClear();
});

const makeEvent = (opts: { authorization?: string; mcpMethod?: string; body: unknown }): APIGatewayProxyEventV2 => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: "/mcp",
  rawQueryString: "",
  headers: {
    host: "mcp.beta.swng.golf",
    "content-type": "application/json",
    // The streamable-HTTP transport 406s a POST whose Accept header doesn't name both media
    // types it may answer with (dist/index.mjs's own "Client must accept both application/json
    // and text/event-stream") — required on every real client request, not just this test's.
    accept: "application/json, text/event-stream",
    ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
    ...(opts.mcpMethod !== undefined ? { "mcp-method": opts.mcpMethod } : {}),
  },
  requestContext: {
    accountId: "test-account",
    apiId: "test-api",
    domainName: "mcp.beta.swng.golf",
    domainPrefix: "mcp",
    http: { method: "POST", path: "/mcp", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    requestId: "req-1",
    routeKey: "$default",
    stage: "$default",
    time: "07/Jul/2026:00:00:00 +0000",
    timeEpoch: 0,
  },
  body: JSON.stringify(opts.body),
  isBase64Encoded: false,
});

describe("handler — the assembled entry", () => {
  it("a rejecting verifier produces 401 + WWW-Authenticate through the REAL handler, and the tool dispatcher is never reached", async () => {
    tokenVerifierMock.verifyAccessToken.mockRejectedValueOnce(new Error(`Token audience does not match required resource "${CANONICAL}"`));

    const result = await handler(
      makeEvent({ authorization: "Bearer bad-token", body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } }),
    );

    expect(result.statusCode).toBe(401);
    expect(result.headers?.["www-authenticate"]).toMatch(/^Bearer /);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("a read-only token's tools/list omits every write tool, and pins writeScope + app.routes onto the REAL createSwngMcpHandler", async () => {
    const authInfo: AuthInfo = { token: "read-token", clientId: "c", scopes: [READ_SCOPE], expiresAt: futureExpiry() };
    tokenVerifierMock.verifyAccessToken.mockResolvedValueOnce(authInfo);

    const result = await handler(
      makeEvent({ authorization: "Bearer read-token", body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } }),
    );

    expect(result.statusCode).toBe(200);
    // The streamable-HTTP transport answers a single-response POST as one SSE frame
    // ("event: message\ndata: {...}\n\n") when the client's Accept header admits
    // text/event-stream (real clients always send both media types) — the JSON-RPC payload is
    // the "data:" line's value, not the raw body.
    const dataLine = (result.body ?? "").split("\n").find((line) => line.startsWith("data: "));
    const parsed = JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as { result: { tools: { name: string }[] } };
    const names = parsed.result.tools.map((tool) => tool.name);
    expect(names).toContain("get_round");
    expect(names).not.toContain("record_score");

    // Requirement 2 + 4, proven by construction: entries/mcp.ts is REQUIRED to have called the
    // real createSwngMcpHandler at least once by now (tools/list just answered through it) — this
    // asserts it was called with writeScope === CANONICAL + "/write" (never a default, never a
    // literal typo) and routes === the EXACT array the mocked buildApp returned as `app.routes`
    // (never a second `buildRoutes(...)` re-derived at the call site).
    expect(createSwngMcpHandlerMock).toHaveBeenCalledWith({ dispatch: dispatchSpy, routes: FAKE_ROUTES, writeScope: WRITE_SCOPE });

    // Requirement 3: createMcpVerifiers (Task 9's shared-instance factory, review round 1 fix
    // 3) was called with the SAME `resource` — dropping this argument, or passing a different
    // string, is exactly the seam this pins: buildApp's own `deps.accountVerifier` (Task 11's
    // seam) is fed accountVerifierFromAccessToken(verifier, resource) ONLY inside that factory,
    // so proving THIS call site forwards `resource` correctly is what's left for this entry to
    // own.
    expect(createMcpVerifiersMock).toHaveBeenCalledWith({ userPoolId: "us-east-1_TestPool1", clientId: "test-mcp-client-id", resource: CANONICAL });

    // buildApp received the account verifier createMcpVerifiers produced — the exact object,
    // not a re-derived stand-in — proving Task 11's seam (`deps.accountVerifier`) is actually
    // fed by Task 9's adapter rather than left at its Cognito default.
    expect(buildAppMock).toHaveBeenCalledWith(expect.anything(), { accountVerifier: accountVerifierMock });
  });

  it("subscriptions/listen is refused through the REAL handler — 404 promptly, never reaching the tool dispatcher", async () => {
    tokenVerifierMock.verifyAccessToken.mockResolvedValueOnce({ token: "t", clientId: "c", scopes: [READ_SCOPE], expiresAt: futureExpiry() });

    const result = await handler(
      makeEvent({
        authorization: "Bearer t",
        mcpMethod: "subscriptions/listen",
        body: { jsonrpc: "2.0", id: 9, method: "subscriptions/listen", params: {} },
      }),
    );

    expect(result.statusCode).toBe(404);
    const parsed = JSON.parse(result.body ?? "{}") as { error: { code: number } };
    expect(parsed.error.code).toBe(-32601);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  // swng-speaks-mcp task-19 fix round 1, Minor 2 — the same defect as entries/mcpAuth.ts, in the
  // already-deployed entry: `toFetchRequest` throws on the fetch spec's forbidden methods, and
  // above any boundary that is an unhandled Lambda error (API Gateway 502, function error metric,
  // alarm) for what is plainly a bad request. What is asserted here is first and foremost that
  // the handler RESOLVES rather than throws.
  it("answers a forbidden HTTP method with a JSON-RPC 400 instead of throwing out of the handler", async () => {
    const event = makeEvent({ authorization: "Bearer t", body: { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} } });

    const result = await handler({ ...event, requestContext: { ...event.requestContext, http: { ...event.requestContext.http, method: "TRACE" } } });

    expect(result.statusCode).toBe(400);
    const parsed = JSON.parse(result.body ?? "{}") as { error: { code: number } };
    expect(parsed.error.code).toBe(-32600);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("a missing Origin header and the literal 'null' Origin are both admitted (design spec §7)", async () => {
    tokenVerifierMock.verifyAccessToken.mockResolvedValue({ token: "t", clientId: "c", scopes: [READ_SCOPE], expiresAt: futureExpiry() });

    const withoutOrigin = await handler(makeEvent({ authorization: "Bearer t", body: { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} } }));
    expect(withoutOrigin.statusCode).toBe(200);

    const event = makeEvent({ authorization: "Bearer t", body: { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} } });
    const withNullOrigin = await handler({ ...event, headers: { ...event.headers, origin: "null" } });
    expect(withNullOrigin.statusCode).toBe(200);
  });
});
