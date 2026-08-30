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

// A real Cognito token endpoint never resends `scope` — the scope a token carries was fixed
// back at the /oauth2/authorize hop that minted the code being exchanged. This fake models that
// faithfully: the TEST registers, per Cognito `code`, the scope that was ACTUALLY placed on the
// authorize redirect for that code (`scopeGrantedForCode`, populated by driveToConsent/the
// write-step-up test as they capture each redirect's own `scope` query param) — so the returned
// access token's content is genuinely derived from what this file asked Cognito for, not from a
// convention the mock invents. That's what makes the "grants only read" test end-to-end
// sensitive to a leg-1 scope-forwarding regression, not just a redirect-URL assertion.
const buildFetchSpy = () => {
  const calls: string[] = [];
  const scopeGrantedForCode = new Map<string, string>();
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const code = new URLSearchParams(bodyText).get("code") ?? "";
    calls.push(code);
    const grantedScope = scopeGrantedForCode.get(code) ?? "(unregistered)";
    const accessToken = `cognito-access-token-for-${code}-scope[${grantedScope}]`;
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: `refresh-${code}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, scopeGrantedForCode };
};

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
    generatePkce: () => ({ verifier: `verifier-${nextId()}`, challenge: "fixed-challenge" }),
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

const consentSubmitRequest = (form: Record<string, string>): Request =>
  new Request("https://mcp.beta.swng.golf/oauth/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

// Drives /authorize through to the rendered consent page (leg 1 only), returning the consent
// response and the consent_id extracted from its form. `scopeGrantedForCode` (from
// buildFetchSpy) is OPTIONAL so tests that don't care about token-scope fidelity (most of the
// consent-page-rendering tests) can omit it.
const driveToConsent = async (
  deps: AuthorizeDeps,
  params: Record<string, string> = baseParams,
  scopeGrantedForCode?: Map<string, string>,
) => {
  const authRes = await handleAuthorize(authorizeRequest(params), deps);
  expect(authRes.status).toBe(302);
  const location = authRes.headers.get("location");
  expect(location).not.toBeNull();
  const cognitoAuthorizeUrl = new URL(location!);
  const requestId = cognitoAuthorizeUrl.searchParams.get("state");
  expect(requestId).not.toBeNull();
  // Register EXACTLY the scope this hop put on the Cognito redirect — never re-derived or
  // assumed — against the code the test is about to simulate Cognito returning.
  scopeGrantedForCode?.set("cognito-code-leg1", cognitoAuthorizeUrl.searchParams.get("scope") ?? "");

  const callbackUrl = new URL(`https://mcp.beta.swng.golf${CALLBACK_PATH}`);
  callbackUrl.searchParams.set("state", requestId!);
  callbackUrl.searchParams.set("code", "cognito-code-leg1");
  const consentRes = await handleCallback(new Request(callbackUrl.toString()), deps);
  expect(consentRes.status).toBe(200);
  const html = await consentRes.text();
  const consentIdMatch = html.match(/name="consent_id" value="([^"]+)"/);
  expect(consentIdMatch).not.toBeNull();
  return { consentRes, html, consentId: consentIdMatch![1]! };
};

describe("handleAuthorize", () => {
  it("redirects to Cognito with the canonical resource bound, S256 PKCE, and scope capped at read regardless of what was requested", async () => {
    const { deps } = buildDeps({});
    // The client asks for write too — leg 1 must still cap Cognito's own request at read.
    const res = await handleAuthorize(authorizeRequest({ ...baseParams, scope: `${CANONICAL}/read ${CANONICAL}/write` }), deps);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://swng-beta.auth.us-east-1.amazoncognito.com/oauth2/authorize");
    expect(location.searchParams.get("resource")).toBe(CANONICAL);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBe("fixed-challenge");
    expect(location.searchParams.get("client_id")).toBe("cognito-mcp-client-id");
    expect(location.searchParams.get("scope")).toBe(`${CANONICAL}/read`);
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
    const { fetchImpl } = buildFetchSpy();
    const { deps, store } = buildDeps({ fetchImpl });
    const { consentId } = await driveToConsent(deps);

    const approveRes = await handleConsentSubmit(consentSubmitRequest({ consent_id: consentId, action: "approve", scope_choice: "read" }), {
      ...deps,
      store,
    });
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get("location")!);
    expect(location.searchParams.get("iss")).toBe(new URL(CANONICAL).origin);
    expect(location.searchParams.get("code")).not.toBeNull();
  });
});

describe("consent page", () => {
  it("issues NO code until consent is granted", async () => {
    const { fetchImpl } = buildFetchSpy();
    const { deps, store } = buildDeps({ fetchImpl });
    const { consentRes } = await driveToConsent(deps);

    // Falsifiable per the brief: BOTH must hold.
    expect(consentRes.headers.get("location")).toBeNull();
    expect(await store.debugCodeCount()).toBe(0);
  });

  it("shows the client name and the redirect URI hostname, escaped", async () => {
    const clientRecord: ClientRecord = { clientId: CLIENT_ID, redirectUris: [REGISTERED_REDIRECT], clientName: "My <Cool> App & Co" };
    const { fetchImpl } = buildFetchSpy();
    const { deps } = buildDeps({ clientRecord, fetchImpl });
    const { html } = await driveToConsent(deps);
    // Escaped, not raw — attacker-supplied client name must not inject markup.
    expect(html).toContain("My &lt;Cool&gt; App &amp; Co");
    expect(html).not.toContain("My <Cool> App");
    expect(html).toContain("client.example.com");
  });

  it("renders the whole redirect URI, not a blank, when the redirect_uri has no hostname (private-use scheme)", async () => {
    const privateUseRedirect = "com.example.app:/callback";
    const clientRecord: ClientRecord = { clientId: CLIENT_ID, redirectUris: [privateUseRedirect], clientName: "Private App" };
    const { fetchImpl } = buildFetchSpy();
    const { deps } = buildDeps({ clientRecord, fetchImpl });
    const { html } = await driveToConsent(deps, { ...baseParams, redirect_uri: privateUseRedirect });
    expect(html).toContain(privateUseRedirect);
  });

  it("warns when every registered redirect URI is loopback", async () => {
    const loopbackRedirect = "http://127.0.0.1:51000/cb";
    const clientRecord: ClientRecord = { clientId: CLIENT_ID, redirectUris: [loopbackRedirect], clientName: "Loopback App" };
    const { fetchImpl } = buildFetchSpy();
    const { deps } = buildDeps({ clientRecord, fetchImpl });
    const { html } = await driveToConsent(deps, { ...baseParams, redirect_uri: loopbackRedirect });
    expect(html.toLowerCase()).toContain("loopback");
  });

  it("does NOT warn when the redirect URI is not loopback", async () => {
    const { fetchImpl } = buildFetchSpy();
    const { deps } = buildDeps({ fetchImpl });
    const { html } = await driveToConsent(deps);
    expect(html.toLowerCase()).not.toContain("loopback");
  });

  it("offers the read/write choice unconditionally, even for a client that only requested read (fix round 1, Critical 2)", async () => {
    const { fetchImpl } = buildFetchSpy();
    const { deps } = buildDeps({ fetchImpl });
    // The default scopes_supported-conformant request: read only.
    const { html } = await driveToConsent(deps, { ...baseParams, scope: `${CANONICAL}/read` });
    expect(html).toContain('value="read_write"');
    expect(html).toContain('value="read"');
  });

  it("serves the page with clickjacking and caching protections", async () => {
    const { fetchImpl } = buildFetchSpy();
    const { deps } = buildDeps({ fetchImpl });
    const { consentRes } = await driveToConsent(deps);
    expect(consentRes.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(consentRes.headers.get("x-frame-options")).toBe("DENY");
    expect(consentRes.headers.get("cache-control")).toContain("no-store");
  });
});

describe("handleConsentSubmit", () => {
  it("grants only read when the golfer picks read-only, and the token handed back was NEVER issued for write (fix round 1, Critical 1)", async () => {
    const { fetchImpl, calls, scopeGrantedForCode } = buildFetchSpy();
    const { deps, store } = buildDeps({ fetchImpl });
    // Client requested BOTH read and write — must not matter.
    const { consentId } = await driveToConsent(deps, { ...baseParams, scope: `${CANONICAL}/read ${CANONICAL}/write` }, scopeGrantedForCode);

    const approveRes = await handleConsentSubmit(consentSubmitRequest({ consent_id: consentId, action: "approve", scope_choice: "read" }), {
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

    // The stronger, structural assertion the review demanded: leg 2 (the only exchange that can
    // ever produce a write-capable token) never ran at all —
    expect(calls).toEqual(["cognito-code-leg1"]);
    // — AND the token handed back was ACTUALLY issued (per the fake's own scope registry, fed
    // straight from what handleAuthorize really put on the Cognito redirect) for read only, even
    // though the client asked for write too. This is the assertion that is sensitive to a
    // leg-1-forwards-the-requested-scope regression, not just to the dispatch structure above.
    expect(grant!.cognitoAccessToken).not.toContain(`${CANONICAL}/write`);
    expect(grant!.cognitoAccessToken).toContain(`scope[${CANONICAL}/read]`);
  });

  it.each([
    ["missing entirely", undefined],
    ["empty string", ""],
    ["wrong case", "READ"],
    ["trailing space", "read "],
    ["garbage", "anything"],
  ])("fails CLOSED to read-only when scope_choice is %s (fix round 1, Important 1)", async (_label, scopeChoice) => {
    const { fetchImpl } = buildFetchSpy();
    const { deps, store } = buildDeps({ fetchImpl });
    const { consentId } = await driveToConsent(deps);

    const form: Record<string, string> = { consent_id: consentId, action: "approve" };
    if (scopeChoice !== undefined) form.scope_choice = scopeChoice;
    const approveRes = await handleConsentSubmit(consentSubmitRequest(form), { ...deps, store });

    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get("location")!);
    // Only an exact "read_write" ever redirects to Cognito for a step-up; everything else mints
    // a read-only code directly, straight back to the client.
    expect(location.origin + location.pathname).toBe(REGISTERED_REDIRECT);
    const code = location.searchParams.get("code");
    const grant = store.debugPeekCode(code!);
    expect(grant!.approvedScopes).toEqual([`${CANONICAL}/read`]);
  });

  it("completes a silent second Cognito leg and grants write only on an exact read_write choice", async () => {
    const { fetchImpl, calls, scopeGrantedForCode } = buildFetchSpy();
    const { deps, store } = buildDeps({ fetchImpl });
    const { consentId } = await driveToConsent(deps, baseParams, scopeGrantedForCode);

    const stepUpRes = await handleConsentSubmit(consentSubmitRequest({ consent_id: consentId, action: "approve", scope_choice: "read_write" }), {
      ...deps,
      store,
    });
    // NOT a code yet — a second hop to Cognito, silent (same golfer, same session).
    expect(stepUpRes.status).toBe(302);
    const stepUpLocation = new URL(stepUpRes.headers.get("location")!);
    expect(stepUpLocation.origin + stepUpLocation.pathname).toBe("https://swng-beta.auth.us-east-1.amazoncognito.com/oauth2/authorize");
    expect(stepUpLocation.searchParams.get("scope")).toBe(`${CANONICAL}/read ${CANONICAL}/write`);
    expect(await store.debugCodeCount()).toBe(0); // still nothing minted
    scopeGrantedForCode.set("cognito-code-leg2", stepUpLocation.searchParams.get("scope") ?? "");

    const leg2Id = stepUpLocation.searchParams.get("state")!;
    const leg2CallbackUrl = new URL(`https://mcp.beta.swng.golf${CALLBACK_PATH}`);
    leg2CallbackUrl.searchParams.set("state", leg2Id);
    leg2CallbackUrl.searchParams.set("code", "cognito-code-leg2");
    const finalRes = await handleCallback(new Request(leg2CallbackUrl.toString()), deps);

    expect(finalRes.status).toBe(302);
    const finalLocation = new URL(finalRes.headers.get("location")!);
    expect(finalLocation.origin + finalLocation.pathname).toBe(REGISTERED_REDIRECT);
    const code = finalLocation.searchParams.get("code");
    expect(code).not.toBeNull();

    const grant = store.debugPeekCode(code!);
    expect(grant!.approvedScopes).toEqual([`${CANONICAL}/read`, `${CANONICAL}/write`]);
    expect(grant!.cognitoAccessToken).toContain("cognito-code-leg2");
    expect(grant!.cognitoAccessToken).toContain(`scope[${CANONICAL}/read ${CANONICAL}/write]`);
    expect(calls).toEqual(["cognito-code-leg1", "cognito-code-leg2"]);
  });

  it("rejects a non-POST submission", async () => {
    const { fetchImpl } = buildFetchSpy();
    const { deps, store } = buildDeps({ fetchImpl });
    const { consentId } = await driveToConsent(deps);

    const req = new Request("https://mcp.beta.swng.golf/oauth/consent?consent_id=" + consentId + "&action=approve&scope_choice=read", {
      method: "PUT",
    });
    const res = await handleConsentSubmit(req, { ...deps, store });
    expect(res.status).toBe(400);
    expect(await store.debugCodeCount()).toBe(0);
  });

  it("rejects a submission that isn't form-urlencoded", async () => {
    const { fetchImpl } = buildFetchSpy();
    const { deps, store } = buildDeps({ fetchImpl });
    const { consentId } = await driveToConsent(deps);

    const req = new Request("https://mcp.beta.swng.golf/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consent_id: consentId, action: "approve", scope_choice: "read" }),
    });
    const res = await handleConsentSubmit(req, { ...deps, store });
    expect(res.status).toBe(400);
    expect(await store.debugCodeCount()).toBe(0);
  });
});
