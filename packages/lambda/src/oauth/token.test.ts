import { describe, expect, it } from "vitest";
import { CODE_TTL_MS, HANDLE_GRACE_MS, HANDLE_TTL_MS } from "@swng/adapters-dynamodb";
import type { AuthorizeCodeGrant, AuthorizeCognitoConfig } from "./authorize.js";
import type { RefreshHandleRecord, TokenDeps } from "./token.js";
import { handleToken, parseStoredRefreshHandle } from "./token.js";

// ---------------------------------------------------------------------------------------------
// A hand-rolled in-memory store reproducing Task 14's OAuthStore semantics for the three slots
// /token touches. Fidelity here is what makes every assertion in this file mean anything, so
// each method mirrors the real one line for line:
//
//   takeCode     — ONE conditional delete on `attribute_exists(pk) AND expiresAtMs > :now`, so an
//                  expired code is neither returned NOR deleted (fix round 1, M-10: this used to
//                  be a plain get+delete, which silently dropped the expiry clause).
//   putHandle /  — an explicit `expiresAtMs` comparison against the injected clock, never mere
//   getHandle      presence: DynamoDB's `ttl` is cleanup, not expiry.
//   retireHandle — SHRINKS expiresAtMs to now + HANDLE_GRACE_MS and stamps retiredAtMs, so only
//                  the FIRST retire ever takes effect.
//
// CODE_TTL_MS / HANDLE_GRACE_MS / HANDLE_TTL_MS are IMPORTED, never retyped: they are the store's
// constants, and a copy here would silently desync the day one of them moves.
// ---------------------------------------------------------------------------------------------

interface StoredHandle {
  readonly value: RefreshHandleRecord;
  readonly expiresAtMs: number;
  readonly retiredAtMs?: number;
}

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

const createClock = (startMs = NOW_MS) => {
  let nowMs = startMs;
  return { now: () => nowMs, advance: (ms: number) => (nowMs += ms) };
};

const createFakeStore = (clock: { now: () => number }) => {
  const codes = new Map<string, { value: AuthorizeCodeGrant; expiresAtMs: number }>();
  const handles = new Map<string, StoredHandle>();
  let takeCodeCalls = 0;
  let getHandleCalls = 0;
  return {
    takeCode: async (code: string) => {
      takeCodeCalls += 1;
      const stored = codes.get(code);
      if (stored === undefined) return undefined;
      if (stored.expiresAtMs <= clock.now()) return undefined; // the condition fails: nothing returned, nothing deleted
      codes.delete(code);
      return stored.value;
    },
    putHandle: async (handleId: string, value: RefreshHandleRecord) => {
      handles.set(handleId, { value, expiresAtMs: clock.now() + HANDLE_TTL_MS });
    },
    getHandle: async (handleId: string) => {
      getHandleCalls += 1;
      const stored = handles.get(handleId);
      if (stored === undefined) return undefined;
      if (stored.expiresAtMs <= clock.now()) return undefined;
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
    debugPutCode: (code: string, grant: AuthorizeCodeGrant) => codes.set(code, { value: grant, expiresAtMs: clock.now() + CODE_TTL_MS }),
    debugPutHandle: (handleId: string, value: RefreshHandleRecord) => handles.set(handleId, { value, expiresAtMs: clock.now() + HANDLE_TTL_MS }),
    debugPeekHandle: (handleId: string) => handles.get(handleId),
    debugHandleCount: () => handles.size,
    debugTakeCodeCalls: () => takeCodeCalls,
    debugGetHandleCalls: () => getHandleCalls,
  };
};

type FakeStore = ReturnType<typeof createFakeStore>;

const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const CLIENT_ID = "test-client-1";
const REGISTERED_REDIRECT = "https://client.example.com/cb";

// The S256 pairs, hard-coded rather than recomputed here: a test that derives the challenge with
// its own `createHash("sha256")` shares the production algorithm choice and would follow it
// anywhere. These literals are the fixed answers S256 must produce for those verifiers.
const CODE_VERIFIER = "a-forty-three-plus-character-code-verifier-value-0123456789";
const CODE_CHALLENGE = "_9VsrwI8EFcpmtTykQ_NYvolh90s5Pb9o5MPRUru_mM";
const VERIFIER_43 = "a".repeat(43); // RFC 7636 §4.1's shortest legal verifier
const CHALLENGE_43 = "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA";
const VERIFIER_128 = "b".repeat(128); // …and its longest
const CHALLENGE_128 = "cK4cUwf1JQ1cueQHQrqWE_zfm42ett05MzBEOy1e_70";

// A JWT-shaped access token. Nothing signs or verifies these — `expires_in` is read from `exp`
// advisorily (see token.ts), so the signature segment is a literal.
const jwtWith = (payload: object): string =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature-nothing-here-verifies",
  ].join(".");

const COGNITO_ACCESS_TOKEN = jwtWith({ sub: "golfer-1", token_use: "access", exp: NOW_S + 3600 });
const COGNITO_REFRESH_TOKEN = "cognito-refresh-token-THE-CREDENTIAL-WE-WRAP";
const refreshedAccessToken = (n: number): string => jwtWith({ sub: "golfer-1", token_use: "access", exp: NOW_S + 3600, jti: `refreshed-${n}` });

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
// as the real endpoint does — NO new refresh token. `status` / `payload` / `throws` exist so the
// upstream-failure branches are reachable from a test.
const buildCognitoFetch = (opts: { status?: number; refreshToken?: string; payload?: Record<string, unknown>; throws?: boolean } = {}) => {
  const calls: { url: string; body: URLSearchParams; authorization: string | null }[] = [];
  let issued = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      authorization: headers.get("authorization"),
    });
    if (opts.throws === true) throw new TypeError("fetch failed"); // what undici throws when the network is gone
    issued += 1;
    const payload = opts.payload ?? {
      access_token: refreshedAccessToken(issued),
      token_type: "Bearer",
      expires_in: 3600,
      ...(opts.refreshToken === undefined ? {} : { refresh_token: opts.refreshToken }),
    };
    return new Response(JSON.stringify(payload), { status: opts.status ?? 200, headers: { "content-type": "application/json" } });
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
    clock,
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
// recovery on that exact code." Never invalid_request, never a custom code. RFC 6749 §5.1 wants
// BOTH cache headers on a token endpoint response, so both are asserted on every failure.
const expectInvalidGrant = async (res: Response): Promise<void> => {
  expect(res.status).toBe(400);
  const body = await bodyOf(res);
  expect(body.error).toBe("invalid_grant");
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("pragma")).toBe("no-cache");
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

  it("refuses a JSON content-type that SMUGGLES the form media type in a parameter", async () => {
    // fix round 1, M-1: the reviewer redeemed a real code with exactly this header, because the
    // guard was a substring test. The media type is everything before the first ";" — nothing else.
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const smuggled = 'application/json; note="application/x-www-form-urlencoded"';
    await expectInvalidGrant(await handleToken(tokenRequest(codeForm(), { contentType: smuggled }), deps));
    expect(store.debugTakeCodeCalls()).toBe(0); // refused before the store was ever touched
    expect((await handleToken(tokenRequest(codeForm()), deps)).status).toBe(200); // the code survived
  });

  it("accepts the form media type with parameters attached", async () => {
    // The other half of M-1's fix: a charset is a PARAMETER, and stripping it must not make the
    // guard reject an ordinary, conformant client.
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const res = await handleToken(tokenRequest(codeForm(), { contentType: "Application/X-WWW-Form-UrlEncoded; charset=UTF-8" }), deps);
    expect(res.status).toBe(200);
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

  it("never echoes anything the caller sent back in the error body", async () => {
    // fix round 1, M-6: the report claimed this property and nothing held it. A description built
    // with a template literal over `client_id` / `refresh_token` turns this red.
    const marker = "MARKER-9d41f0-reflected-input";
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store } = buildDeps({ fetchImpl });
    store.debugPutCode("the-opaque-code", buildGrant());
    store.debugPutHandle("handle-original", { clientId: CLIENT_ID, approvedScopes: [`${CANONICAL}/read`], cognitoRefreshToken: COGNITO_REFRESH_TOKEN });

    const responses = [
      await handleToken(tokenRequest(codeForm({ client_id: marker })), deps),
      await handleToken(tokenRequest(codeForm({ code: marker, code_verifier: marker })), deps),
      await handleToken(tokenRequest({ grant_type: marker }), deps),
      await handleToken(tokenRequest(refreshForm(marker)), deps),
      await handleToken(tokenRequest(refreshForm("handle-original", { client_id: marker })), deps),
    ];
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(JSON.stringify(await bodyOf(res))).not.toContain(marker);
    }
  });
});

describe("handleToken — authorization_code", () => {
  it("returns the Cognito access token verbatim and an OPAQUE refresh handle that is not the Cognito refresh token", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const res = await handleToken(tokenRequest(codeForm()), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await bodyOf(res);

    expect(body.access_token).toBe(COGNITO_ACCESS_TOKEN);
    expect(body.token_type).toBe("Bearer");
    // The complete key set — nothing extra is ever published from a stored record.
    expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "refresh_token", "token_type"]);

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

  it("refuses a grant whose challenge method is not S256, even when the challenge DOES match", async () => {
    // fix round 1, M-2: the old version of this test used a plain-style challenge, so it passed
    // on the hash mismatch and the method guard could be deleted with all tests green. Here the
    // stored challenge is the correct S256 of the presented verifier and ONLY the method is
    // wrong, so deleting `codeChallengeMethod !== "S256"` turns this 200.
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant({ codeChallengeMethod: "plain" }));

    await expectInvalidGrant(await handleToken(tokenRequest(codeForm()), deps));
    expect(store.debugHandleCount()).toBe(0);
  });

  it("burns the code on a failed PKCE check — a retry with the RIGHT verifier finds nothing left", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    await expectInvalidGrant(await handleToken(tokenRequest(codeForm({ code_verifier: CODE_VERIFIER.replace("a", "z") })), deps));
    await expectInvalidGrant(await handleToken(tokenRequest(codeForm()), deps));
  });

  it("refuses a replayed code", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    expect((await handleToken(tokenRequest(codeForm()), deps)).status).toBe(200);
    await expectInvalidGrant(await handleToken(tokenRequest(codeForm()), deps));
  });

  it("refuses an expired code", async () => {
    const { deps, store, clock } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    clock.advance(CODE_TTL_MS + 1);
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

  // fix round 1, M-7: each of these used to pass for the wrong reason — a missing `client_id`
  // failed the LATER mismatch check, so the presence guard was deletable with everything green.
  // The store counter is what pins it: a malformed request must be refused before the code is
  // taken, so the code is still redeemable afterwards.
  it.each([["code"], ["client_id"], ["redirect_uri"], ["code_verifier"]])(
    "refuses an authorization_code grant missing %s WITHOUT touching the store",
    async (field) => {
      const { deps, store } = buildDeps({});
      store.debugPutCode("the-opaque-code", buildGrant());

      const form = codeForm();
      delete form[field];
      await expectInvalidGrant(await handleToken(tokenRequest(form), deps));
      expect(store.debugTakeCodeCalls()).toBe(0);
      expect((await handleToken(tokenRequest(codeForm()), deps)).status).toBe(200);
    },
  );

  // fix round 1, M-9: RFC 7636 §4.1 fixes the verifier at 43–128 characters, and a
  // one-character verifier used to be accepted. Bounds live on the REQUEST schema (CLAUDE.md).
  it.each([
    ["one character", "a"],
    ["42 characters", "a".repeat(42)],
    ["129 characters", "a".repeat(129)],
  ])("refuses a code_verifier of %s without touching the store", async (_label, verifier) => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    await expectInvalidGrant(await handleToken(tokenRequest(codeForm({ code_verifier: verifier })), deps));
    expect(store.debugTakeCodeCalls()).toBe(0);
  });

  it.each([
    ["43 characters", VERIFIER_43, CHALLENGE_43],
    ["128 characters", VERIFIER_128, CHALLENGE_128],
  ])("accepts a code_verifier of %s — the range is inclusive at both ends", async (_label, verifier, challenge) => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant({ codeChallenge: challenge }));

    expect((await handleToken(tokenRequest(codeForm({ code_verifier: verifier })), deps)).status).toBe(200);
  });
});

describe("handleToken — expires_in", () => {
  // Spec §4.3 justifies the 30-second rotation grace with "Claude refreshes proactively up to
  // five minutes before expiry" — a schedule the client cannot compute without this field. It is
  // read from the access token's own `exp` (advisory; nothing here verifies a signature), so both
  // grant types report it identically.
  it("reports the seconds left on the Cognito access token, on the authorization_code path", async () => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant());

    const body = await bodyOf(await handleToken(tokenRequest(codeForm()), deps));
    expect(body.expires_in).toBe(3600);
  });

  it("counts down against the injected clock, never a wall clock", async () => {
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store, clock } = buildDeps({ fetchImpl });
    store.debugPutHandle("handle-original", { clientId: CLIENT_ID, approvedScopes: [`${CANONICAL}/read`], cognitoRefreshToken: COGNITO_REFRESH_TOKEN });
    clock.advance(600_000); // ten minutes — well past a code's 60s TTL, which is why this runs on a handle

    const body = await bodyOf(await handleToken(tokenRequest(refreshForm("handle-original")), deps));
    expect(body.expires_in).toBe(3000);
  });

  it("reports the seconds left on the refreshed token, on the refresh_token path", async () => {
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store } = buildDeps({ fetchImpl });
    store.debugPutHandle("handle-original", { clientId: CLIENT_ID, approvedScopes: [`${CANONICAL}/read`], cognitoRefreshToken: COGNITO_REFRESH_TOKEN });

    const body = await bodyOf(await handleToken(tokenRequest(refreshForm("handle-original")), deps));
    expect(body.expires_in).toBe(3600);
  });

  // Every degradation OMITS the field and still issues the token — exactly the behaviour this
  // endpoint had before `expires_in` existed. Nothing here may throw or refuse.
  it.each([
    ["an opaque, non-JWT access token", "opaque-token-with-no-segments"],
    ["a two-segment token whose second segment WOULD parse", `header.${Buffer.from(JSON.stringify({ exp: NOW_S + 3600 })).toString("base64url")}`],
    ["a payload that is not JSON", `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.bm90LWpzb24.sig`],
    ["a payload that is JSON null", `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from("null").toString("base64url")}.sig`],
    ["a payload that is a bare number", `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from("42").toString("base64url")}.sig`],
    ["no exp claim", jwtWith({ sub: "golfer-1" })],
    ["an exp that is not a number", jwtWith({ sub: "golfer-1", exp: "soon" })],
    ["an exp that is not finite", `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from('{"exp":1e999}').toString("base64url")}.sig`],
    ["an exp already in the past", jwtWith({ sub: "golfer-1", exp: NOW_S - 10 })],
    ["an exp exactly now", jwtWith({ sub: "golfer-1", exp: NOW_S })],
  ])("omits expires_in for %s, and still issues the token", async (_label, accessToken) => {
    const { deps, store } = buildDeps({});
    store.debugPutCode("the-opaque-code", buildGrant({ cognitoAccessToken: accessToken }));

    const res = await handleToken(tokenRequest(codeForm()), deps);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.access_token).toBe(accessToken);
    expect(body).not.toHaveProperty("expires_in");
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
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await bodyOf(res);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${COGNITO.domain}/oauth2/token`);
    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]!.body.get("refresh_token")).toBe(COGNITO_REFRESH_TOKEN); // the real credential, never the handle
    expect(calls[0]!.authorization).toBe(`Basic ${Buffer.from(`${COGNITO.clientId}:${COGNITO.clientSecret}`).toString("base64")}`);

    expect(body.access_token).toBe(refreshedAccessToken(1));
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

  it.each([["refresh_token"], ["client_id"]])("refuses a refresh grant missing %s WITHOUT touching the store", async (field) => {
    // fix round 1, M-7 again: a missing client_id used to be caught by the later mismatch check,
    // so the presence guard was deletable. The store counter pins the ORDER.
    const { fetchImpl } = buildCognitoFetch();
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    const form = refreshForm(handle);
    delete form[field];
    await expectInvalidGrant(await handleToken(tokenRequest(form), deps));
    expect(store.debugGetHandleCalls()).toBe(0);
  });
});

describe("handleToken — what comes back from Cognito", () => {
  const seedHandle = (store: FakeStore) => {
    store.debugPutHandle("handle-original", { clientId: CLIENT_ID, approvedScopes: [`${CANONICAL}/read`], cognitoRefreshToken: COGNITO_REFRESH_TOKEN });
    return "handle-original";
  };

  // fix round 1, M-3: `!response.ok` and the `access_token` type check were individually
  // deletable — the suite pinned "a refused response is refused" without pinning WHICH line does
  // it. These two tests separate them: the first is refused only by the type check, the second
  // only by `!response.ok`.
  it("refuses a 200 whose body carries no access_token, and does not retire the handle", async () => {
    const { fetchImpl } = buildCognitoFetch({ payload: { token_type: "Bearer", expires_in: 3600 } });
    const { deps, store, clock } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle)), deps));
    expect(store.debugHandleCount()).toBe(1); // no fresh handle minted

    clock.advance(HANDLE_GRACE_MS + 1); // the handle kept its FULL life, not a grace window
    const { fetchImpl: healthy } = buildCognitoFetch();
    expect((await handleToken(tokenRequest(refreshForm(handle)), { ...deps, fetchImpl: healthy })).status).toBe(200);
  });

  it("refuses a non-2xx even when it carries a perfectly good access_token — the token never escapes", async () => {
    const leaked = refreshedAccessToken(99);
    const { fetchImpl } = buildCognitoFetch({ status: 401, payload: { access_token: leaked, token_type: "Bearer" } });
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    const res = await handleToken(tokenRequest(refreshForm(handle)), deps);
    const rawBody = await res.clone().text();
    await expectInvalidGrant(res);
    expect(rawBody).not.toContain(leaked);
    expect(store.debugHandleCount()).toBe(1);
  });

  it("answers invalid_grant — not a thrown 500 — when the network is gone", async () => {
    // fix round 1, M-5: removing the try/catch around fetchImpl left every test green, so nothing
    // stopped "every failure answers invalid_grant" regressing into an unhandled rejection.
    const { fetchImpl } = buildCognitoFetch({ throws: true });
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle)), deps));
    expect(store.debugHandleCount()).toBe(1);
  });

  it("answers invalid_grant when the upstream body is not JSON at all", async () => {
    const fetchImpl = (async () => new Response("<html>gateway error</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const { deps, store } = buildDeps({ fetchImpl });
    const handle = seedHandle(store);

    await expectInvalidGrant(await handleToken(tokenRequest(refreshForm(handle)), deps));
    expect(store.debugHandleCount()).toBe(1);
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
