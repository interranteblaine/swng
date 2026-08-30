import { describe, expect, it } from "vitest";
import { HANDLE_GRACE_MS, HANDLE_TTL_MS } from "@swng/adapters-dynamodb";
import type { AuthorizeCodeGrant, AuthorizeCognitoConfig } from "./authorize.js";
import type { RefreshHandleRecord, TokenDeps } from "./token.js";
import { handleToken, parseStoredRefreshHandle } from "./token.js";

// ---------------------------------------------------------------------------------------------
// A hand-rolled in-memory store reproducing Task 14's OAuthStore semantics for the three slots
// /token touches: `takeCode` (single-use — the delete IS the replay defence), `putHandle`/
// `getHandle` (explicit expiry against an injected clock, never mere presence), and
// `retireHandle` (SHRINKS expiresAtMs to now + HANDLE_GRACE_MS and stamps retiredAtMs, so only
// the FIRST retire ever takes effect — createDynamoOAuthStore.ts's own rule, which its contract
// suite already proves against real DynamoDB).
//
// HANDLE_GRACE_MS / HANDLE_TTL_MS are IMPORTED, never retyped as 30_000 / 30 days: the grace
// window is the store's constant, and a copy here would silently desync the day it moves.
// ---------------------------------------------------------------------------------------------

interface StoredHandle {
  readonly value: RefreshHandleRecord;
  readonly expiresAtMs: number;
  readonly retiredAtMs?: number;
}

const createClock = (startMs = 1_700_000_000_000) => {
  let nowMs = startMs;
  return { now: () => nowMs, advance: (ms: number) => (nowMs += ms) };
};

const createFakeStore = (clock: { now: () => number }) => {
  const codes = new Map<string, AuthorizeCodeGrant>();
  const handles = new Map<string, StoredHandle>();
  return {
    takeCode: async (code: string) => {
      const grant = codes.get(code);
      codes.delete(code); // single-use, exactly as the conditional delete is
      return grant;
    },
    putHandle: async (handleId: string, value: RefreshHandleRecord) => {
      handles.set(handleId, { value, expiresAtMs: clock.now() + HANDLE_TTL_MS });
    },
    getHandle: async (handleId: string) => {
      const stored = handles.get(handleId);
      if (stored === undefined) return undefined;
      if (stored.expiresAtMs <= clock.now()) return undefined; // expiry is an explicit comparison, never TTL cleanup
      return stored.value;
    },
    retireHandle: async (handleId: string) => {
      const stored = handles.get(handleId);
      if (stored === undefined) return;
      if (stored.expiresAtMs <= clock.now()) return; // never resurrect an already-expired handle
      if (stored.retiredAtMs !== undefined) return; // only the FIRST retire shrinks the window
      handles.set(handleId, { value: stored.value, expiresAtMs: clock.now() + HANDLE_GRACE_MS, retiredAtMs: clock.now() });
    },
    // TEST-ONLY introspection — not part of the production TokenStore slice.
    debugPutCode: (code: string, grant: AuthorizeCodeGrant) => codes.set(code, grant),
    debugPutHandle: (handleId: string, value: RefreshHandleRecord) => handles.set(handleId, { value, expiresAtMs: clock.now() + HANDLE_TTL_MS }),
    debugPeekHandle: (handleId: string) => handles.get(handleId),
    debugHandleCount: () => handles.size,
  };
};

type FakeStore = ReturnType<typeof createFakeStore>;

const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const CLIENT_ID = "test-client-1";
const REGISTERED_REDIRECT = "https://client.example.com/cb";

// The S256 pair, hard-coded rather than recomputed here: a test that derives the challenge with
// its own `createHash("sha256")` shares the production algorithm choice and would follow it
// anywhere. This literal is the fixed answer S256 must produce for that verifier.
const CODE_VERIFIER = "a-forty-three-plus-character-code-verifier-value-0123456789";
const CODE_CHALLENGE = "_9VsrwI8EFcpmtTykQ_NYvolh90s5Pb9o5MPRUru_mM";

const COGNITO_ACCESS_TOKEN = "cognito-access-token-from-the-authorize-legs";
const COGNITO_REFRESH_TOKEN = "cognito-refresh-token-THE-CREDENTIAL-WE-WRAP";

const COGNITO: AuthorizeCognitoConfig = {
  domain: "https://swng-beta.auth.us-east-1.amazoncognito.com",
  clientId: "cognito-mcp-client-id",
  clientSecret: "shh",
  callbackUrl: "https://mcp.beta.swng.golf/oauth/callback",
};

const buildGrant = (overrides: Partial<AuthorizeCodeGrant> = {}): AuthorizeCodeGrant => ({
  clientId: CLIENT_ID,
  redirectUri: REGISTERED_REDIRECT,
  approvedScopes: [`${CANONICAL}/read`, `${CANONICAL}/write`],
  codeChallenge: CODE_CHALLENGE,
  codeChallengeMethod: "S256",
  cognitoAccessToken: COGNITO_ACCESS_TOKEN,
  cognitoRefreshToken: COGNITO_REFRESH_TOKEN,
  ...overrides,
});

// Cognito's refresh grant, modelled faithfully: it returns a NEW access token and — by default,
// as the real endpoint does — NO new refresh token. `refreshToken` is set only by the test that
// probes what happens when a rotating issuer sends one.
const buildCognitoFetch = (opts: { ok?: boolean; refreshToken?: string } = {}) => {
  const calls: { url: string; body: URLSearchParams; authorization: string | null }[] = [];
  let issued = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      authorization: headers.get("authorization"),
    });
    if (opts.ok === false) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    issued += 1;
    const payload: Record<string, string> = { access_token: `cognito-access-refreshed-${issued}`, token_type: "Bearer", expires_in: "3600" };
    if (opts.refreshToken !== undefined) payload.refresh_token = opts.refreshToken;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

let idCounter = 0;
const nextId = () => `opaque-handle-${(idCounter += 1)}`;

const buildDeps = (overrides: { store?: FakeStore; fetchImpl?: typeof fetch; clock?: ReturnType<typeof createClock> } = {}) => {
  const clock = overrides.clock ?? createClock();
  const store = overrides.store ?? createFakeStore(clock);
  const deps: TokenDeps = {
    store,
    cognito: COGNITO,
    fetchImpl: overrides.fetchImpl,
    generateId: nextId,
  };
  return { deps, store, clock };
};

const tokenRequest = (form: Record<string, string>, init: { method?: string; contentType?: string } = {}): Request =>
  new Request("https://mcp.beta.swng.golf/token", {
    method: init.method ?? "POST",
    headers: { "content-type": init.contentType ?? "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

const codeForm = (overrides: Record<string, string> = {}): Record<string, string> => ({
  grant_type: "authorization_code",
  code: "the-opaque-code",
  client_id: CLIENT_ID,
  redirect_uri: REGISTERED_REDIRECT,
  code_verifier: CODE_VERIFIER,
  ...overrides,
});

const refreshForm = (handle: string, overrides: Record<string, string> = {}): Record<string, string> => ({
  grant_type: "refresh_token",
  refresh_token: handle,
  client_id: CLIENT_ID,
  ...overrides,
});

const bodyOf = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

// Every failure at this endpoint answers `invalid_grant` — spec §4.3 step 4, "Claude keys its
// recovery on that exact code." Never invalid_request, never a custom code.
const expectInvalidGrant = async (res: Response): Promise<void> => {
  expect(res.status).toBe(400);
  const body = await bodyOf(res);
  expect(body.error).toBe("invalid_grant");
  expect(res.headers.get("cache-control")).toContain("no-store");
};

describe("handleToken — the request envelope", () => {
  it("refuses a JSON content-type carrying a body the form parser WOULD have accepted", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    // The body is a genuine, redeemable, form-urlencoded authorization_code grant — the ONLY
    // thing wrong is the Content-Type header (`/register` is the JSON endpoint; this one is
    // not — spec §4.3 step 4, "different parsers"). Delete the guard and this 200s.
    const res = await handleToken(tokenRequest(codeForm(), { contentType: "application/json" }), deps);
    await expectInvalidGrant(res);

    // …and the proof that the body really was redeemable: the same body under the right
    // content-type succeeds, which it could not do if the refusal had consumed the code.
    const retry = await handleToken(tokenRequest(codeForm()), deps);
    expect(retry.status).toBe(200);
  });

  it("refuses a non-POST carrying an otherwise-valid form body", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const res = await handleToken(tokenRequest(codeForm(), { method: "PUT" }), deps);
    await expectInvalidGrant(res);
    expect((await handleToken(tokenRequest(codeForm()), deps)).status).toBe(200);
  });

  it("answers invalid_grant — not unsupported_grant_type — for a grant type it does not implement", async () => {
    const { deps } = buildDeps({});
    const res = await handleToken(tokenRequest({ grant_type: "client_credentials", client_id: CLIENT_ID }), deps);
    await expectInvalidGrant(res);
  });
});

describe("handleToken — authorization_code", () => {
  it("returns the Cognito access token verbatim and an OPAQUE refresh handle that is not the Cognito refresh token", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const res = await handleToken(tokenRequest(codeForm()), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await bodyOf(res);

    expect(body.access_token).toBe(COGNITO_ACCESS_TOKEN);
    expect(body.token_type).toBe("Bearer");

    // The whole reason this wrapper exists (spec §4.3, "Why wrap the refresh token"): Cognito's
    // own refresh credential must never leave the server.
    expect(body.refresh_token).toBeTypeOf("string");
    expect(body.refresh_token).not.toBe(COGNITO_REFRESH_TOKEN);
    expect(JSON.stringify(body)).not.toContain(COGNITO_REFRESH_TOKEN);

    // The handle is stored bound to the client and the approved scopes, wrapping the real token.
    const stored = store.debugPeekHandle(body.refresh_token as string);
    expect(stored?.value).toEqual({
      clientId: CLIENT_ID,
      approvedScopes: [`${CANONICAL}/read`, `${CANONICAL}/write`],
      cognitoRefreshToken: COGNITO_REFRESH_TOKEN,
    });
  });

  it("does NOT report a `scope` derived from the stored grant's approvedScopes", async () => {
    // approvedScopes is a CLAIM fixed at step-up time, never reconciled against the scope Cognito
    // actually issued the token for (exchangeCognitoCode discards the response's `scope`). It is
    // fine for binding and audit; echoing it to the client as `scope` would publish it as truth.
    // The client's authority is the token it is holding — RFC 6749 §5.1 makes `scope` OPTIONAL.
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant({ approvedScopes: [`${CANONICAL}/read`, `${CANONICAL}/write`] }));

    const body = await bodyOf(await handleToken(tokenRequest(codeForm()), deps));
    expect(body).not.toHaveProperty("scope");
    expect(JSON.stringify(body)).not.toContain(`${CANONICAL}/write`);
  });

  it("refuses a code_verifier that does not hash to the recorded challenge", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const res = await handleToken(tokenRequest(codeForm({ code_verifier: `${CODE_VERIFIER}-tampered` })), deps);
    await expectInvalidGrant(res);
    expect(store.debugHandleCount()).toBe(0); // nothing was issued
  });

  it("burns the code on a failed PKCE check — a retry with the RIGHT verifier finds nothing left", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    await expectInvalidGrant(await handleToken(tokenRequest(codeForm({ code_verifier: "wrong" })), deps));
    await expectInvalidGrant(await handleToken(tokenRequest(codeForm()), deps));
  });

  it("refuses a replayed code", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    expect((await handleToken(tokenRequest(codeForm()), deps)).status).toBe(200);
    await expectInvalidGrant(await handleToken(tokenRequest(codeForm()), deps));
  });

  it("refuses a client_id that is not the one the code was minted for", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const res = await handleToken(tokenRequest(codeForm({ client_id: "some-other-client" })), deps);
    await expectInvalidGrant(res);
    expect(store.debugHandleCount()).toBe(0);
  });

  it("refuses a redirect_uri that is not the one the code was minted for", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const res = await handleToken(tokenRequest(codeForm({ redirect_uri: "https://client.example.com/cb2" })), deps);
    await expectInvalidGrant(res);
    expect(store.debugHandleCount()).toBe(0);
  });

  it("refuses a stored grant whose challenge method is not S256", async () => {
    const { deps, store } = buildDeps({});
    // "plain" would make the challenge equal the verifier — never minted by /authorize, and not
    // something to start trusting at redemption time.
    store.debugPutCode("the-opaque-code", buildGrant({ codeChallengeMethod: "plain", codeChallenge: CODE_VERIFIER }));

    await expectInvalidGrant(await handleToken(tokenRequest(codeForm()), deps));
  });

  it("issues no refresh handle when the grant carries no Cognito refresh token", async () => {
    const { deps, store } = buildDeps({});
    // `cognitoRefreshToken` is optional on the grant — this is the record with the key ABSENT.
    store.debugPutCode("the-opaque-code", {
      clientId: CLIENT_ID,
      redirectUri: REGISTERED_REDIRECT,
      approvedScopes: [`${CANONICAL}/read`],
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      cognitoAccessToken: COGNITO_ACCESS_TOKEN,
    });

    const res = await handleToken(tokenRequest(codeForm()), deps);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.access_token).toBe(COGNITO_ACCESS_TOKEN);
    expect(body).not.toHaveProperty("refresh_token");
    expect(store.debugHandleCount()).toBe(0);
  });

  it.each([["code"], ["client_id"], ["redirect_uri"], ["code_verifier"]])("refuses an authorization_code grant missing %s", async (field) => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const form = codeForm();
    delete form[field];
    await expectInvalidGrant(await handleToken(tokenRequest(form), deps));
  });
});

describe("handleToken — refresh_token", () => {
  const seedHandle = (store: FakeStore, handleId = "handle-original") => {
    store.debugPutHandle(handleId, {
      clientId: CLIENT_ID,
      approvedScopes: [`${CANONICAL}/read`],
      cognitoRefreshToken: COGNITO_REFRESH_TOKEN,
    });
    return handleId;
  };

  it("sends the WRAPPED Cognito refresh token upstream and hands back a fresh opaque handle", async () => {
    const { fetchImpl, calls } = buildCognitoFetch();
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    const res = await handleToken(tokenRequest(refreshForm(handle)), deps);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${COGNITO.domain}/oauth2/token`);
    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]!.body.get("refresh_token")).toBe(COGNITO_REFRESH_TOKEN); // the real credential, never the handle
    expect(calls[0]!.authorization).toBe(`Basic ${Buffer.from(`${COGNITO.clientId}:${COGNITO.clientSecret}`).toString("base64")}`);

    expect(body.access_token).toBe("cognito-access-refreshed-1");
    expect(body.refresh_token).toBeTypeOf("string");
    expect(body.refresh_token).not.toBe(handle); // ROTATED
    expect(body.refresh_token).not.toBe(COGNITO_REFRESH_TOKEN); // still opaque
    expect(body).not.toHaveProperty("scope");
  });

  it("keeps the retired handle redeemable INSIDE the grace window and refuses it after", async () => {
    // Claude refreshes proactively up to five minutes early, so two in-flight requests race —
    // rotating with no grace window locks the golfer out (spec §4.3).
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store, clock } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    const first = await handleToken(tokenRequest(refreshForm(handle)), deps);
    expect(first.status).toBe(200);

    clock.advance(HANDLE_GRACE_MS - 1);
    const inFlight = await handleToken(tokenRequest(refreshForm(handle)), deps);
    expect(inFlight.status).toBe(200);

    clock.advance(HANDLE_GRACE_MS + 1);
    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle)), deps));
  });

  it("does not extend the retired handle's window when it is used again inside it", async () => {
    // The store's own review-round-1 finding: a second retire must never push expiresAtMs out
    // again, or a retired handle used on every refresh lives forever.
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store, clock } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    expect((await handleToken(tokenRequest(refreshForm(handle)), deps)).status).toBe(200);
    clock.advance(HANDLE_GRACE_MS - 1);
    expect((await handleToken(tokenRequest(refreshForm(handle)), deps)).status).toBe(200);
    clock.advance(2);
    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle)), deps));
  });

  it("keeps the chain alive across successive refreshes when Cognito sends no new refresh token", async () => {
    const { fetchImpl, calls } = buildCognitoFetch();
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    const first = await bodyOf(await handleToken(tokenRequest(refreshForm(handle)), deps));
    const second = await handleToken(tokenRequest(refreshForm(first.refresh_token as string)), deps);
    expect(second.status).toBe(200);
    // The wrapped credential was carried forward, not dropped, when Cognito answered without one.
    expect(calls[1]!.body.get("refresh_token")).toBe(COGNITO_REFRESH_TOKEN);
  });

  it("stores the new Cognito refresh token on the fresh handle when Cognito rotates one", async () => {
    const { fetchImpl } = buildCognitoFetch({ refreshToken: "cognito-refresh-token-ROTATED" });
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    const body = await bodyOf(await handleToken(tokenRequest(refreshForm(handle)), deps));
    const stored = store.debugPeekHandle(body.refresh_token as string);
    expect(stored?.value.cognitoRefreshToken).toBe("cognito-refresh-token-ROTATED");
    expect(stored?.value.approvedScopes).toEqual([`${CANONICAL}/read`]); // binding carried forward
  });

  it("refuses a handle presented by a different client, and leaves it usable by its owner", async () => {
    const { fetchImpl, calls } = buildCognitoFetch();
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle, { client_id: "some-other-client" })), deps));
    expect(calls).toHaveLength(0); // nothing was asked of Cognito on the thief's behalf
    expect((await handleToken(tokenRequest(refreshForm(handle)), deps)).status).toBe(200);
  });

  it("refuses an unknown handle", async () => {
    const { fetchImpl } = buildCognitoFetch();
    const { deps } = buildDeps({ fetchImpl });
    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm("never-issued")), deps));
  });

  it("refuses an expired handle", async () => {
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store, clock } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    clock.advance(HANDLE_TTL_MS + 1);
    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle)), deps));
  });

  it("does not retire the handle when Cognito refuses the refresh", async () => {
    // A transient upstream failure must not cost the golfer their session: the handle keeps its
    // FULL life, not a 30-second grace window.
    const { fetchImpl } = buildCognitoFetch({ ok: false });
    const { deps, store, clock } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle)), deps));
    expect(store.debugHandleCount()).toBe(1); // no fresh handle minted either

    clock.advance(HANDLE_GRACE_MS + 1);
    const { fetchImpl: healthy } = buildCognitoFetch();
    expect((await handleToken(tokenRequest(refreshForm(handle)), { ...deps, fetchImpl: healthy })).status).toBe(200);
  });

  it.each([["refresh_token"], ["client_id"]])("refuses a refresh grant missing %s", async (field) => {
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    const form = refreshForm(handle);
    delete form[field];
    await expectInvalidGrant(await handleToken(tokenRequest(form), deps));
  });
});

describe("parseStoredRefreshHandle", () => {
  const valid = { clientId: CLIENT_ID, approvedScopes: [`${CANONICAL}/read`], cognitoRefreshToken: COGNITO_REFRESH_TOKEN };

  it("round-trips a stored handle through JSON, as DynamoDB hands it back", () => {
    expect(parseStoredRefreshHandle(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it.each([
    ["not an object", "a-string"],
    ["null", null],
    ["clientId missing", { ...valid, clientId: undefined }],
    ["clientId not a string", { ...valid, clientId: 7 }],
    ["approvedScopes missing", { ...valid, approvedScopes: undefined }],
    ["approvedScopes not all strings", { ...valid, approvedScopes: [`${CANONICAL}/read`, 3] }],
    ["cognitoRefreshToken missing", { ...valid, cognitoRefreshToken: undefined }],
  ])("throws when %s", (_label, raw) => {
    expect(() => parseStoredRefreshHandle(raw)).toThrow();
  });
});
