import { beforeAll, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { CALLBACK_PATH, CONSENT_SUBMIT_PATH, parseStoredAuthorizeRequest, parseStoredCodeGrant } from "../oauth/authorize.js";
import type { AuthorizeDeps } from "../oauth/authorize.js";
import { ClientRegistrationError, parseStoredClientRecord } from "../oauth/clients.js";
import type { ClientRecord } from "../oauth/clients.js";
import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata } from "../oauth/metadata.js";
import { parseStoredRefreshHandle } from "../oauth/token.js";
import type { TokenDeps } from "../oauth/token.js";

// The `mcpAuth` entry is a ROUTER: eight surfaces (design spec §3's own diagram), one lazily
// built dependency set, and a 404 for anything else. So this file proves two classes of thing
// and deliberately not a third:
//
//   1. Every surface the oauth/ modules export is REACHED, with the request handed through
//      intact and the handler's own Response returned verbatim. An unrouted path is a feature
//      that is dead on arrival, and nothing else in the tree would catch it.
//   2. The dependencies those handlers receive are the RIGHT ones — in particular all four of
//      `createDynamoOAuthStore`'s injected parsers (passing fewer is not a type error; it is a
//      crash the first time that slot is read), one shared clock, and a Cognito config whose
//      callbackUrl is DERIVED from the one canonical resource rather than typed a second time.
//
// It does NOT re-test what /authorize, /token, consent or registration DO — those have ~2,000
// lines of their own tests. The four handlers are therefore spied (their modules spread through
// `importOriginal`, so every other export stays real), which also keeps this file hermetic:
// a real handleAuthorize would fetch a CIMD document over the network.
const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const TABLE_NAME = "mcp-oauth-test";
const COGNITO_DOMAIN = "https://swng-test.auth.us-east-1.amazoncognito.com";
const MCP_CLIENT_ID = "test-mcp-app-client";
const MCP_CLIENT_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-mcp-client-secret-test";
const CLIENT_SECRET = "test-cognito-app-client-secret";

const REQUIRED_ENV: Readonly<Record<string, string>> = {
  MCP_RESOURCE: CANONICAL,
  TABLE_MCP_OAUTH: TABLE_NAME,
  COGNITO_DOMAIN,
  MCP_CLIENT_ID,
  MCP_CLIENT_SECRET_ARN,
};

// --- Boundary mocks (the same two classes entries/http.test.ts and mcp.test.ts mock) ---------

const readSecretCalls = vi.hoisted(() => ({ count: 0 }));

// entries/http.test.ts's own idiom: the entry uses the REAL default secret reader (no injected
// seam at the entry level, by design), so the module it comes from is mocked here. Failing the
// FIRST read simulates the transient cold-start fault the cached-promise self-heal exists for.
vi.mock("@swng/adapters-secretsmanager", () => ({
  createSecretsManagerReader:
    () =>
    async (_arn: string): Promise<string> => {
      readSecretCalls.count += 1;
      if (readSecretCalls.count === 1) throw new Error("simulated transient Secrets Manager failure");
      return CLIENT_SECRET;
    },
}));

const oauthStore = vi.hoisted(() => ({
  putClient: vi.fn(),
  getClient: vi.fn(),
  putRequest: vi.fn(),
  takeRequest: vi.fn(),
  putCode: vi.fn(),
  takeCode: vi.fn(),
  putHandle: vi.fn(),
  getHandle: vi.fn(),
  retireHandle: vi.fn(),
}));
const documentClient = vi.hoisted(() => ({ marker: "the-document-client" }));
const createDynamoOAuthStoreMock = vi.hoisted(() => vi.fn((_config: Record<string, unknown>) => oauthStore));

// Spread through `importOriginal` rather than replaced wholesale: oauth/authorize.ts imports
// MAX_OAUTH_ID_BYTES from this package as a VALUE at module scope, so a bare factory would
// leave its key-length schema undefined.
vi.mock("@swng/adapters-dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@swng/adapters-dynamodb")>();
  return { ...actual, createDocumentClient: () => documentClient, createDynamoOAuthStore: createDynamoOAuthStoreMock };
});

const handleAuthorizeMock = vi.hoisted(() => vi.fn());
const handleCallbackMock = vi.hoisted(() => vi.fn());
const handleConsentSubmitMock = vi.hoisted(() => vi.fn());
const handleTokenMock = vi.hoisted(() => vi.fn());
const registerDcrClientMock = vi.hoisted(() => vi.fn());

vi.mock("../oauth/authorize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oauth/authorize.js")>();
  return { ...actual, handleAuthorize: handleAuthorizeMock, handleCallback: handleCallbackMock, handleConsentSubmit: handleConsentSubmitMock };
});

vi.mock("../oauth/token.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oauth/token.js")>();
  return { ...actual, handleToken: handleTokenMock };
});

vi.mock("../oauth/clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oauth/clients.js")>();
  return { ...actual, registerDcrClient: registerDcrClientMock };
});

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;
let handler: Handler;

beforeAll(async () => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
  handler = (await import("./mcpAuth.js")).handler as Handler;
});

const makeEvent = (opts: { method: string; path: string; query?: string; body?: string; contentType?: string }): APIGatewayProxyEventV2 => ({
  version: "2.0",
  routeKey: `${opts.method} ${opts.path}`,
  rawPath: opts.path,
  rawQueryString: opts.query ?? "",
  headers: {
    host: "mcp.beta.swng.golf",
    ...(opts.contentType !== undefined ? { "content-type": opts.contentType } : {}),
  },
  requestContext: {
    accountId: "test-account",
    apiId: "test-api",
    domainName: "mcp.beta.swng.golf",
    domainPrefix: "mcp",
    http: { method: opts.method, path: opts.path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    requestId: "req-1",
    routeKey: `${opts.method} ${opts.path}`,
    stage: "$default",
    time: "23/Aug/2026:00:00:00 +0000",
    timeEpoch: 0,
  },
  ...(opts.body !== undefined ? { body: opts.body } : {}),
  isBase64Encoded: false,
});

const marker = (name: string): Response => new Response(JSON.stringify({ reached: name }), { status: 299, headers: { "content-type": "application/json" } });

// --- Cold start ------------------------------------------------------------------------------

// FIRST in the file on purpose (entries/http.test.ts's own ordering): the entry builds its
// dependencies on the first INVOCATION, so this is the only test that can observe a failed
// build — and the self-heal it proves is what keeps a transient Secrets Manager blip from
// 500ing every request for the warm container's whole remaining lifetime.
describe("mcpAuth cold start", () => {
  it("retries a transient dependency failure on the NEXT invocation instead of caching the rejection forever", async () => {
    await expect(handler(makeEvent({ method: "GET", path: "/.well-known/oauth-authorization-server" }))).rejects.toThrow(
      /simulated transient Secrets Manager failure/,
    );

    const second = await handler(makeEvent({ method: "GET", path: "/.well-known/oauth-authorization-server" }));
    expect(second.statusCode).toBe(200);
  });
});

// --- The eight routable surfaces (design spec §3) --------------------------------------------

describe("mcpAuth routing", () => {
  it("serves RFC 9728 protected-resource metadata at BOTH well-known paths — the suffixed one clients probe first, and the bare one", async () => {
    const expected = buildProtectedResourceMetadata(CANONICAL);

    const suffixed = await handler(makeEvent({ method: "GET", path: "/.well-known/oauth-protected-resource/mcp" }));
    const bare = await handler(makeEvent({ method: "GET", path: "/.well-known/oauth-protected-resource" }));

    expect(suffixed.statusCode).toBe(200);
    expect(suffixed.headers?.["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(suffixed.body ?? "")).toEqual(expected);
    expect(bare.statusCode).toBe(200);
    expect(JSON.parse(bare.body ?? "")).toEqual(expected);
    // The suffix is the RESOURCE's own path, derived from the one canonical constant — not a
    // second hardcoded "/mcp" that a stage with a different path would silently 404.
    expect(new URL(CANONICAL).pathname).toBe("/mcp");
  });

  it("serves RFC 8414 authorization-server metadata at the bare well-known path", async () => {
    const result = await handler(makeEvent({ method: "GET", path: "/.well-known/oauth-authorization-server" }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "")).toEqual(buildAuthorizationServerMetadata(CANONICAL));
  });

  it("routes GET /authorize to handleAuthorize with the query string intact, and returns its Response verbatim", async () => {
    handleAuthorizeMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: `${COGNITO_DOMAIN}/oauth2/authorize?x=1`, "cache-control": "no-store" } }),
    );

    const result = await handler(
      makeEvent({ method: "GET", path: "/authorize", query: "client_id=https%3A%2F%2Fapp.example%2Fid&response_type=code" }),
    );

    expect(result.statusCode).toBe(302);
    expect(result.headers?.["location"]).toBe(`${COGNITO_DOMAIN}/oauth2/authorize?x=1`);
    expect(result.headers?.["cache-control"]).toBe("no-store");
    const request = handleAuthorizeMock.mock.calls.at(-1)?.[0] as Request;
    expect(new URL(request.url).searchParams.get("client_id")).toBe("https://app.example/id");
  });

  it("routes GET /oauth/callback to handleCallback — at the path authorize.ts exports, not a retyped literal", async () => {
    handleCallbackMock.mockResolvedValueOnce(marker("callback"));

    const result = await handler(makeEvent({ method: "GET", path: CALLBACK_PATH, query: "code=abc&state=req-1" }));

    expect(result.statusCode).toBe(299);
    expect(JSON.parse(result.body ?? "")).toEqual({ reached: "callback" });
    const request = handleCallbackMock.mock.calls.at(-1)?.[0] as Request;
    expect(new URL(request.url).searchParams.get("state")).toBe("req-1");
  });

  it("routes POST /oauth/consent to handleConsentSubmit with the form body intact", async () => {
    handleConsentSubmitMock.mockResolvedValueOnce(marker("consent"));

    const result = await handler(
      makeEvent({
        method: "POST",
        path: CONSENT_SUBMIT_PATH,
        body: "consent_id=c-1&action=approve&scope_choice=read_write",
        contentType: "application/x-www-form-urlencoded",
      }),
    );

    expect(result.statusCode).toBe(299);
    const request = handleConsentSubmitMock.mock.calls.at(-1)?.[0] as Request;
    expect(request.method).toBe("POST");
    expect(await request.text()).toBe("consent_id=c-1&action=approve&scope_choice=read_write");
  });

  it("routes POST /token to handleToken with the form body intact", async () => {
    handleTokenMock.mockResolvedValueOnce(marker("token"));

    const result = await handler(
      makeEvent({
        method: "POST",
        path: "/token",
        body: "grant_type=authorization_code&code=abc",
        contentType: "application/x-www-form-urlencoded",
      }),
    );

    expect(result.statusCode).toBe(299);
    const request = handleTokenMock.mock.calls.at(-1)?.[0] as Request;
    expect(await request.text()).toBe("grant_type=authorization_code&code=abc");
  });

  it("routes POST /register to registerDcrClient — the RAW body string, since it is the one handler not shaped like a Request", async () => {
    const record: ClientRecord = { clientId: "dcr-1", redirectUris: ["http://127.0.0.1/cb"], clientName: "Test Client" };
    registerDcrClientMock.mockResolvedValueOnce(record);
    const body = JSON.stringify({ redirect_uris: ["http://127.0.0.1/cb"], client_name: "Test Client" });

    const result = await handler(makeEvent({ method: "POST", path: "/register", body, contentType: "application/json" }));

    expect(registerDcrClientMock).toHaveBeenCalledWith(body, { store: oauthStore });
    // RFC 7591 §3.2.1: 201, and the registered metadata echoed back in its OAuth spelling.
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body ?? "")).toMatchObject({
      client_id: "dcr-1",
      redirect_uris: ["http://127.0.0.1/cb"],
      client_name: "Test Client",
      token_endpoint_auth_method: "none",
    });
  });

  it("answers 404 on a path nothing routes, without waking any handler", async () => {
    const handlers = [handleAuthorizeMock, handleCallbackMock, handleConsentSubmitMock, handleTokenMock, registerDcrClientMock];
    const before = handlers.map((mock) => mock.mock.calls.length);

    const result = await handler(makeEvent({ method: "GET", path: "/oauth/authorise" }));

    expect(result.statusCode).toBe(404);
    expect(handlers.map((mock) => mock.mock.calls.length)).toEqual(before);
  });
});

// --- What the handlers were handed -----------------------------------------------------------

describe("mcpAuth dependencies", () => {
  it("builds the OAuth store with ALL FOUR injected parsers — a missing one is not a type error, it is a crash on first read", () => {
    const config = createDynamoOAuthStoreMock.mock.calls.at(-1)?.[0] as {
      client: unknown;
      tableName: string;
      clock: { now: () => number };
      parseClient: unknown;
      parseRequest: unknown;
      parseCodeGrant: unknown;
      parseHandle: unknown;
    };

    expect(config.client).toBe(documentClient);
    expect(config.tableName).toBe(TABLE_NAME);
    expect(config.parseClient).toBe(parseStoredClientRecord);
    expect(config.parseRequest).toBe(parseStoredAuthorizeRequest);
    expect(config.parseCodeGrant).toBe(parseStoredCodeGrant);
    expect(config.parseHandle).toBe(parseStoredRefreshHandle);
    expect(config.clock.now()).toBeCloseTo(Date.now(), -4);
  });

  it("hands /authorize the canonical resource, the store in both slots, and a Cognito config whose callbackUrl is DERIVED from that resource", () => {
    const deps = handleAuthorizeMock.mock.calls.at(-1)?.[1] as AuthorizeDeps;

    expect(deps.resource).toBe(CANONICAL);
    expect(deps.store).toBe(oauthStore);
    expect(deps.clientStore).toBe(oauthStore);
    expect(deps.cognito).toEqual({
      domain: COGNITO_DOMAIN,
      clientId: MCP_CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      // `${origin of CANONICAL}${CALLBACK_PATH}` — the same string the Cognito app client is
      // configured with. Retyping it here is exactly the drift authorize.ts exports the constant
      // to prevent.
      callbackUrl: `https://mcp.beta.swng.golf${CALLBACK_PATH}`,
    });
  });

  it("hands /token the same store and the same Cognito config, plus the ONE clock everything shares", () => {
    const authorizeDeps = handleAuthorizeMock.mock.calls.at(-1)?.[1] as AuthorizeDeps;
    const tokenDeps = handleTokenMock.mock.calls.at(-1)?.[1] as TokenDeps;
    const storeConfig = createDynamoOAuthStoreMock.mock.calls.at(-1)?.[0] as { clock: unknown };

    expect(tokenDeps.store).toBe(oauthStore);
    expect(tokenDeps.cognito).toBe(authorizeDeps.cognito);
    expect(tokenDeps.clock).toBe(storeConfig.clock);
    expect(authorizeDeps.cimd.clock).toBe(storeConfig.clock);
  });

  it("builds the dependency set ONCE and shares it across routes and invocations", () => {
    const fromAuthorize = handleAuthorizeMock.mock.calls.at(-1)?.[1] as AuthorizeDeps;
    const fromCallback = handleCallbackMock.mock.calls.at(-1)?.[1] as AuthorizeDeps;
    const fromConsent = handleConsentSubmitMock.mock.calls.at(-1)?.[1] as AuthorizeDeps;

    expect(fromCallback).toBe(fromAuthorize);
    expect(fromConsent).toBe(fromAuthorize);
    // One cold-start build: the secret was read exactly twice — the simulated failure, then the
    // one that stuck — no matter how many requests have been served since.
    expect(readSecretCalls.count).toBe(2);
    expect(createDynamoOAuthStoreMock).toHaveBeenCalledTimes(1);
  });
});

// --- The error boundary ----------------------------------------------------------------------

describe("mcpAuth failures", () => {
  it("answers an unresolvable CIMD client at /authorize with a 400 that never echoes the fetch's own message", async () => {
    handleAuthorizeMock.mockRejectedValueOnce(new ClientRegistrationError("client metadata document fetch refused: 10.0.0.5 is a private address"));

    const result = await handler(makeEvent({ method: "GET", path: "/authorize", query: "client_id=https%3A%2F%2Fevil.example%2Fid" }));

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body ?? "") as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).not.toContain("10.0.0.5");
  });

  it("answers a rejected registration with RFC 7591's 400 invalid_client_metadata", async () => {
    registerDcrClientMock.mockRejectedValueOnce(new ClientRegistrationError("registration request body is not valid JSON"));

    const result = await handler(makeEvent({ method: "POST", path: "/register", body: "not json", contentType: "application/json" }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "")).toEqual({
      error: "invalid_client_metadata",
      error_description: "registration request body is not valid JSON",
    });
  });

  it("answers a store fault with a 500 that leaks nothing — /token's own contract for a server-side fault", async () => {
    handleTokenMock.mockRejectedValueOnce(new Error("ProvisionedThroughputExceededException: table mcp-oauth-test"));

    const result = await handler(
      makeEvent({ method: "POST", path: "/token", body: "grant_type=refresh_token", contentType: "application/x-www-form-urlencoded" }),
    );

    expect(result.statusCode).toBe(500);
    expect(result.body ?? "").not.toContain("mcp-oauth-test");
    const body = JSON.parse(result.body ?? "") as { error: string };
    expect(body.error).toBe("server_error");
  });

  it("refuses a GET on /register rather than answering a misleading 'not valid JSON'", async () => {
    const result = await handler(makeEvent({ method: "GET", path: "/register" }));

    expect(result.statusCode).toBe(405);
    expect(result.headers?.["allow"]).toBe("POST");
  });
});

// --- The requireEnv discipline ---------------------------------------------------------------

describe("mcpAuth required environment", () => {
  it.each(Object.keys(REQUIRED_ENV))("a missing %s crashes the FIRST invocation, by name — never a per-route 500 mystery later", async (key) => {
    const saved = process.env[key];
    delete process.env[key];
    vi.resetModules();
    try {
      const fresh = (await import("./mcpAuth.js")).handler as Handler;
      await expect(fresh(makeEvent({ method: "GET", path: "/.well-known/oauth-authorization-server" }))).rejects.toThrow(key);
    } finally {
      process.env[key] = saved as string;
      vi.resetModules();
    }
  });
});
