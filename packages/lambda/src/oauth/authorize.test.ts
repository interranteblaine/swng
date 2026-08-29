import { describe, expect, it } from "vitest";
import type { Clock } from "@swng/application";
import type { ClientRecord, ClientStore, FetchCimdDeps } from "./clients.js";
import type { AuthorizeCodeGrant, AuthorizeDeps, AuthorizeRequestRecord } from "./authorize.js";
import { CALLBACK_PATH, handleAuthorize, handleCallback, handleConsentSubmit } from "./authorize.js";

// ---------------------------------------------------------------------------------------------
// A hand-rolled in-memory store, matching Task 14's OAuthStore contract (put/take, single-use)
// closely enough to prove the flow's ordering — plus TEST-ONLY introspection
// (debugCodeCount/debugPeekCode) that is NOT part of the production AuthorizeStore interface.
// ---------------------------------------------------------------------------------------------

const createFakeStore = () => {
  const requests = new Map<string, AuthorizeRequestRecord>();
  const codes = new Map<string, AuthorizeCodeGrant>();
  return {
    putRequest: async (id: string, value: AuthorizeRequestRecord) => {
      requests.set(id, value);
    },
    takeRequest: async (id: string) => {
      const value = requests.get(id);
      requests.delete(id);
      return value;
    },
    putCode: async (code: string, value: AuthorizeCodeGrant) => {
      codes.set(code, value);
    },
    debugCodeCount: async () => codes.size,
    debugPeekCode: (code: string) => codes.get(code),
  };
};

const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const REGISTERED_REDIRECT = "https://client.example.com/cb";
const CLIENT_ID = "test-client-1";

const fixedClock: Clock = { now: () => 1_000_000 };

const buildClientStore = (record: ClientRecord | undefined): ClientStore => ({
  putClient: async () => {},
  getClient: async (id: string) => (id === record?.clientId ? record : undefined),
});

const buildCimd = (): FetchCimdDeps => ({ clock: fixedClock });

let idCounter = 0;
const nextId = () => `id-${(idCounter += 1)}`;

const buildDeps = (overrides: {
  clientRecord?: ClientRecord;
  fetchImpl?: typeof fetch;
  store?: ReturnType<typeof createFakeStore>;
}): { deps: AuthorizeDeps; store: ReturnType<typeof createFakeStore> } => {
  const store = overrides.store ?? createFakeStore();
  const clientRecord = overrides.clientRecord ?? { clientId: CLIENT_ID, redirectUris: [REGISTERED_REDIRECT], clientName: "Test Client" };
  const deps: AuthorizeDeps = {
    resource: CANONICAL,
    clientStore: buildClientStore(clientRecord),
    cimd: buildCimd(),
    store,
    cognito: {
      domain: "https://swng-beta.auth.us-east-1.amazoncognito.com",
      clientId: "cognito-mcp-client-id",
      clientSecret: "shh",
      callbackUrl: `https://mcp.beta.swng.golf${CALLBACK_PATH}`,
    },
    fetchImpl: overrides.fetchImpl,
    generateId: nextId,
    generatePkce: () => ({ verifier: "fixed-verifier", challenge: "fixed-challenge" }),
  };
  return { deps, store };
};

const authorizeRequest = (params: Record<string, string>): Request => {
  const url = new URL("https://mcp.beta.swng.golf/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
};

const baseParams = {
  client_id: CLIENT_ID,
  redirect_uri: REGISTERED_REDIRECT,
  response_type: "code",
  code_challenge: "client-challenge",
  code_challenge_method: "S256",
  state: "client-state-123",
};

const fakeCognitoTokenFetch = (accessToken = "cognito-access-token", refreshToken: string | undefined = "cognito-refresh-token"): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ access_token: accessToken, ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

// Drives /authorize through to the rendered consent page, returning the requestId and the
// consent response. Fails the test loudly (via expect) if any hop didn't behave.
const driveToConsent = async (deps: AuthorizeDeps, params: Record<string, string> = baseParams) => {
  const authRes = await handleAuthorize(authorizeRequest(params), deps);
  expect(authRes.status).toBe(302);
  const location = authRes.headers.get("location");
  expect(location).not.toBeNull();
  const requestId = new URL(location!).searchParams.get("state");
  expect(requestId).not.toBeNull();

  const callbackUrl = new URL(`https://mcp.beta.swng.golf${CALLBACK_PATH}`);
  callbackUrl.searchParams.set("state", requestId!);
  callbackUrl.searchParams.set("code", "cognito-code-abc");
  const consentRes = await handleCallback(new Request(callbackUrl.toString()), deps);
  return { consentRes, requestId: requestId! };
};

describe("handleAuthorize", () => {
  it("redirects to Cognito with the canonical resource bound and S256 PKCE", async () => {
    const { deps } = buildDeps({});
    const res = await handleAuthorize(authorizeRequest(baseParams), deps);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://swng-beta.auth.us-east-1.amazoncognito.com/oauth2/authorize");
    expect(location.searchParams.get("resource")).toBe(CANONICAL);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBe("fixed-challenge");
    expect(location.searchParams.get("client_id")).toBe("cognito-mcp-client-id");
  });

  it("rejects an unregistered redirect_uri WITHOUT redirecting to it", async () => {
    const { deps } = buildDeps({});
    const res = await handleAuthorize(authorizeRequest({ ...baseParams, redirect_uri: "https://evil.example.com/steal" }), deps);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a scope the resource server does not own", async () => {
    const { deps } = buildDeps({});
    const res = await handleAuthorize(authorizeRequest({ ...baseParams, scope: "https://other-resource.example/admin" }), deps);
    // redirect_uri is already registered/trusted at this point, so the error IS a redirect —
    // legible to the client, per the brief, rather than an opaque Cognito invalid_request later.
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REGISTERED_REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("returns iss on the redirect, per RFC 9207", async () => {
    const { deps, store } = buildDeps({ fetchImpl: fakeCognitoTokenFetch() });
    const { consentRes } = await driveToConsent(deps);
    expect(consentRes.status).toBe(200); // consent page, not yet a redirect

    const consentIdMatch = (await consentRes.text()).match(/name="consent_id" value="([^"]+)"/);
    expect(consentIdMatch).not.toBeNull();
    const form = new URLSearchParams({ consent_id: consentIdMatch![1]!, action: "approve", scope_choice: "read" });
    const approveRes = await handleConsentSubmit(new Request("https://mcp.beta.swng.golf/oauth/consent", { method: "POST", body: form }), {
      ...deps,
      store,
    });
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get("location")!);
    expect(location.searchParams.get("iss")).toBe(new URL(CANONICAL).origin);
    expect(location.searchParams.get("code")).not.toBeNull();
  });
});

describe("handleCallback / consent", () => {
  it("issues NO code until consent is granted", async () => {
    const { deps, store } = buildDeps({ fetchImpl: fakeCognitoTokenFetch() });
    const { consentRes } = await driveToConsent(deps);

    // Falsifiable per the brief: BOTH must hold.
    expect(consentRes.headers.get("location")).toBeNull();
    expect(await store.debugCodeCount()).toBe(0);
  });

  it("shows the client name and the redirect URI hostname", async () => {
    const clientRecord: ClientRecord = { clientId: CLIENT_ID, redirectUris: [REGISTERED_REDIRECT], clientName: "My <Cool> App & Co" };
    const { deps } = buildDeps({ clientRecord, fetchImpl: fakeCognitoTokenFetch() });
    const { consentRes } = await driveToConsent(deps);
    const html = await consentRes.text();
    // Escaped, not raw — attacker-supplied client name must not inject markup.
    expect(html).toContain("My &lt;Cool&gt; App &amp; Co");
    expect(html).not.toContain("My <Cool> App");
    expect(html).toContain("client.example.com");
  });

  it("renders the whole redirect URI, not a blank, when the redirect_uri has no hostname (private-use scheme)", async () => {
    const privateUseRedirect = "com.example.app:/callback";
    const clientRecord: ClientRecord = { clientId: CLIENT_ID, redirectUris: [privateUseRedirect], clientName: "Private App" };
    const { deps } = buildDeps({ clientRecord, fetchImpl: fakeCognitoTokenFetch() });
    const { consentRes } = await driveToConsent(deps, { ...baseParams, redirect_uri: privateUseRedirect });
    const html = await consentRes.text();
    expect(html).toContain(privateUseRedirect);
  });

  it("warns when every registered redirect URI is loopback", async () => {
    const loopbackRedirect = "http://127.0.0.1:51000/cb";
    const clientRecord: ClientRecord = { clientId: CLIENT_ID, redirectUris: [loopbackRedirect], clientName: "Loopback App" };
    const { deps } = buildDeps({ clientRecord, fetchImpl: fakeCognitoTokenFetch() });
    const { consentRes } = await driveToConsent(deps, { ...baseParams, redirect_uri: loopbackRedirect });
    const html = await consentRes.text();
    expect(html.toLowerCase()).toContain("loopback");
  });

  it("grants only read when the golfer picks read-only", async () => {
    const { deps, store } = buildDeps({ fetchImpl: fakeCognitoTokenFetch() });
    // Client requested BOTH read and write.
    const { consentRes } = await driveToConsent(deps, { ...baseParams, scope: `${CANONICAL}/read ${CANONICAL}/write` });
    const html = await consentRes.text();
    const consentIdMatch = html.match(/name="consent_id" value="([^"]+)"/);
    expect(consentIdMatch).not.toBeNull();

    const form = new URLSearchParams({ consent_id: consentIdMatch![1]!, action: "approve", scope_choice: "read" });
    const approveRes = await handleConsentSubmit(new Request("https://mcp.beta.swng.golf/oauth/consent", { method: "POST", body: form }), {
      ...deps,
      store,
    });
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get("location")!);
    const code = location.searchParams.get("code");
    expect(code).not.toBeNull();

    // Inspect the STORED GRANT's scopes, not the rendered page — this is the falsifiable half.
    const grant = store.debugPeekCode(code!);
    expect(grant).toBeDefined();
    expect(grant!.approvedScopes).toEqual([`${CANONICAL}/read`]);
    expect(grant!.approvedScopes).not.toContain(`${CANONICAL}/write`);
  });
});
