// The MCP beta gate (swng-speaks-mcp Task 21, design spec §8's last bullet).
//
// WHY THIS FILE IS A PLAYWRIGHT SPEC AND NOT PART OF `pnpm e2e:beta`. Cognito binds an audience
// to an access token only when `resource=` rides an /authorize request through MANAGED LOGIN
// (design spec §4.2, F3) — the `InitiateAuth USER_PASSWORD_AUTH` shortcut every other suite uses
// (support.ts's own mintThrowawayCredentials) cannot produce an audience-bound token at all. So
// the only way to hold a real MCP credential is to type a real password into Cognito's real
// login form in a real browser and walk the real consent page. That is this file.
//
// WHAT ONLY THIS FILE CAN PROVE. Everything else in the arc was proven against fakes: an
// in-process handler, a stubbed store, a synthesized CloudFormation template. Two properties
// survive only here:
//
//   1. **The write consent is a real choice.** Picking "Read and write" runs a SECOND, silent
//      Cognito round trip (authorize.ts's `beginWriteStepUp`) — silent because the golfer's
//      Cognito session from leg 1 is still live, which is a behaviour of Cognito's, not of ours,
//      and therefore cannot be asserted hermetically. This spec observes that hop on the wire
//      (the navigation list `cognitoAuthorizeHops` collects) and asserts the scopes it carried.
//   2. **The choice CHANGES the outcome.** Asserting only that `record_score` shows up under a
//      read+write grant would pass identically against a server that granted write
//      unconditionally — the exact class of test this arc has shipped five times. So the story
//      runs BOTH consent choices against the same golfer and asserts the difference: read+write
//      lists every write tool and read-only lists none of them, from tokens whose `scope` claims
//      differ in the same way.
//
// WHAT IT COSTS. One sealed round on beta per run. A finalized round is not removable, and
// `get_round` against a finalized round is the read the arc's product argument turns on (design
// spec §5.1: a round-scoped token can never be minted for one, which is why the route is
// "golfer"-tier) — so the round has to be real and it has to be finished. Everything else is
// reused or cleaned up: the course is the same shared `fixtureLinks18` every other spec seeds
// idempotently, the Cognito user is deleted by globalTeardown.ts, and the registered OAuth
// client carries the store's own 90-day TTL.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { getMeResponseSchema, parse, roundViewResponseSchema, startRoundResponseSchema } from "@swng/contracts";
import type { GolferView } from "@swng/contracts";
import type { CourseId, RoundId } from "@swng/domain";
import { fixtureLinks18 } from "@swng/domain";
import { ensureCourse, loadMcpResource, loadWebEnv, mintThrowawayCredentials, updateMeDirect } from "./support.js";

// --- The one constant, and the two scopes forced off it (design spec §4.3) -------------------

// Read from the deployed stack's own `McpUrl` output, never typed here: swngStack.ts derives that
// output and the `mcp` function's `MCP_RESOURCE` environment variable from the SAME `canonical`
// local, so comparing the SERVED metadata documents against this value is a live check that the
// deployed lambda's environment still agrees with the deployed domain name. Every request this
// spec makes goes to this URL, so a document that disagreed with it would be a document pointing
// at an endpoint nobody is talking to — which is precisely the failure Claude refuses on.
const CANONICAL = loadMcpResource();
const AS_ORIGIN = new URL(CANONICAL).origin;
const READ_SCOPE = `${CANONICAL}/read`;
const WRITE_SCOPE = `${CANONICAL}/write`;

// Authored here, deliberately, rather than imported from packages/lambda's TOOL_TABLE — this is
// the "bridging two independently authored places" shape design spec §8 asks a drift guard to
// take, and apps/web could not import @swng/lambda anyway. A tool ADDED to the write surface
// later does not break this list; a write tool that stops being gated on the write scope does.
const WRITE_TOOLS = [
  "abandon_round",
  "add_game",
  "finalize_round",
  "join_round",
  "leave_round",
  "record_score",
  "set_participant_strokes",
  "set_round_holes",
  "set_round_played_at",
  "share_round",
  "start_round",
  "terminate_game",
] as const;

// Claude allows 10 s for discovery, registration and the token exchange (design spec §7,
// "Timeouts"). Asserted on the exchange itself, which by then runs against an mcpAuth Lambda
// three requests warm — a failure here is a real budget finding, not a cold start.
const EXCHANGE_BUDGET_MS = 10_000;

// --- PKCE, JWTs, and the loopback the code comes home to ------------------------------------

interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

const newPkce = (): Pkce => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

// Reads a JWT's payload WITHOUT verifying it. That is correct here and nowhere else: the gate is
// asserting what claims Cognito minted (`aud`, `scope`), and the signature check that matters is
// the one the deployed verifier performs on every /mcp call this spec then makes with the very
// same token — a forged token would fail there, loudly, on the next assertion.
const jwtClaims = (token: string): Record<string, unknown> => {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error(`not a JWT: ${token.slice(0, 24)}…`);
  const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("JWT payload is not an object");
  return decoded as Record<string, unknown>;
};

const claimString = (claims: Record<string, unknown>, name: string): string => {
  const value = claims[name];
  if (typeof value !== "string") throw new Error(`token has no string "${name}" claim (got ${JSON.stringify(value)})`);
  return value;
};

interface Loopback {
  /** The address the browser is redirected to — an EPHEMERAL port, never the registered one. */
  readonly redirectUri: string;
  /** Resolves with the full callback URL the browser lands on, query string and all. */
  next(): Promise<URL>;
  close(): Promise<void>;
}

// The client end of the flow: a real HTTP server on 127.0.0.1, exactly like the loopback catcher
// Claude Code binds. Deliberately bound on port 0 (the OS picks) while the client REGISTERS a
// different, fixed port — so a successful redirect is itself the proof that /authorize matched
// the loopback redirect URI port-agnostically per RFC 8252 §7.3 (clients.ts), which is the rule
// every real MCP client depends on and which nothing else in this arc exercises live.
const startLoopback = async (): Promise<Loopback> => {
  let deliver: ((url: URL) => void) | undefined;
  const pending: URL[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>swng gate</title><p>callback received</p>");
    // Only the authorization response itself counts — a stray favicon fetch must not resolve a
    // waiter with a URL carrying no code, which would turn every downstream assertion vacuous.
    if (url.pathname !== "/callback" || (!url.searchParams.has("code") && !url.searchParams.has("error"))) return;
    if (deliver) {
      const send = deliver;
      deliver = undefined;
      send(url);
    } else {
      pending.push(url);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    next: () =>
      new Promise<URL>((resolve, reject) => {
        const queued = pending.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => {
          deliver = undefined;
          reject(new Error("no authorization response reached the loopback redirect URI within 60s"));
        }, 60_000);
        deliver = (url) => {
          clearTimeout(timer);
          resolve(url);
        };
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// --- The endpoints, spoken directly --------------------------------------------------------

const registerClient = async (redirectUri: string, name: string): Promise<string> => {
  const response = await fetch(`${AS_ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: name }),
  });
  const json: unknown = await response.json();
  expect(response.status, `POST /register -> ${JSON.stringify(json)}`).toBe(201);
  const clientId = (json as { client_id?: unknown }).client_id;
  if (typeof clientId !== "string" || clientId.length === 0) throw new Error(`POST /register returned no client_id: ${JSON.stringify(json)}`);
  return clientId;
};

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

const postToken = async (form: Record<string, string>): Promise<TokenResponse> => {
  const response = await fetch(`${AS_ORIGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const json: unknown = await response.json();
  expect(response.status, `POST /token (${form.grant_type ?? "?"}) -> ${JSON.stringify(json)}`).toBe(200);
  const body = json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown };
  expect(body.token_type).toBe("Bearer");
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error(`POST /token returned an unusable body: ${JSON.stringify(json)}`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
};

const authorizeUrl = (clientId: string, redirectUri: string, pkce: Pkce, state: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    // What the CLIENT asks for. It is deliberately NOT what decides the grant — design spec §4.4
    // names the client's own scope request as precisely the thing that must not choose for the
    // golfer, and the consent page offers both choices regardless. Asking for read only here and
    // still coming home with write is that rule holding, live.
    scope: READ_SCOPE,
  });
  return `${AS_ORIGIN}/authorize?${params.toString()}`;
};

// --- The browser leg -------------------------------------------------------------------------

// Every navigation the page makes, recorded from `request` (not `framenavigated`) because a 302
// chain commits once but issues one navigation REQUEST per hop — and the hop this spec exists to
// see is a pure redirect through Cognito that never renders.
const watchNavigations = (page: Page): string[] => {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) urls.push(request.url());
  });
  return urls;
};

const cognitoAuthorizeHops = (urls: readonly string[], hostedUiDomain: string): URL[] =>
  urls.filter((url) => url.startsWith(`${hostedUiDomain}/oauth2/authorize`)).map((url) => new URL(url));

// Cognito managed login v2, server-rendered: a real <form> with an "Email address" field, a
// "Password" field and a "Sign in" submit. Named by their visible labels rather than by the
// `name="username"` / `name="password"` attributes, so a Cognito re-skin that keeps the semantics
// keeps this working, and one that changes them fails loudly instead of silently typing into the
// wrong box. Scoped to role "textbox", not a bare getByLabel: the password field ships beside a
// "Show password" CHECKBOX that also carries "Password" in its accessible name, and a bare label
// lookup matches both (observed live, first run of this gate).
const signInThroughManagedLogin = async (page: Page, username: string, password: string): Promise<void> => {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("textbox", { name: "Email address" }).fill(username);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
};

type ConsentChoice = "read" | "read_write";

// The consent page authorize.ts renders (its own markup: an <h1> naming the client, a "It will
// return to:" line naming the redirect hostname, two radios, Approve/Deny).
const approveConsent = async (page: Page, choice: ConsentChoice): Promise<void> => {
  await expect(page).toHaveURL(new RegExp(`^${AS_ORIGIN}/oauth/callback`));
  const label = choice === "read_write" ? /^Read and write/ : /^Read-only/;
  await page.getByRole("radio", { name: label }).check();
  await page.getByRole("button", { name: "Approve" }).click();
};

// --- MCP over the real endpoint ---------------------------------------------------------------

const connectMcp = async (accessToken: string): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(CANONICAL), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "swng-mcp-beta-gate", version: "0.0.0" });
  await client.connect(transport);
  return client;
};

const structured = (result: { structuredContent?: unknown; isError?: boolean; content?: unknown }, label: string): Record<string, unknown> => {
  expect(result.isError, `${label} -> ${JSON.stringify(result.content)}`).toBeFalsy();
  const value = result.structuredContent;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned no structuredContent: ${JSON.stringify(result)}`);
  return value as Record<string, unknown>;
};

// ==============================================================================================

test.describe.serial("MCP against deployed beta", () => {
  let hostedUiDomain = "";

  let username = "";
  let password = "";
  let golfer: GolferView;
  let course: { courseId: CourseId; cardId: string };

  let loopback: Loopback;
  let clientId = "";
  const REGISTERED_PORT = 51000; // deliberately NOT the port the loopback binds — see startLoopback

  // ONE browser context for the whole story, created here rather than taken from the per-test
  // `page` fixture — and that is load-bearing, not tidiness. Playwright hands each test a FRESH
  // context (fresh cookies), which would destroy the Cognito session test 8 depends on and turn
  // its "no password was typed" assertion into a test of nothing. Same reason fieldTest.spec.ts
  // builds its own contexts in beforeAll.
  let page: Page;
  let navigations: string[] = [];

  let writeTokens: TokenResponse;
  let roundId: RoundId;

  test.beforeAll(async ({ browser }) => {
    ({ hostedUiDomain } = loadWebEnv());
    const { httpUrl } = loadWebEnv();
    // The golfer, named through the ordinary API so the round this story finalizes belongs to a
    // real, named account — and so `whoami` over MCP has a golferId to be checked against.
    const minted = await mintThrowawayCredentials("mcp");
    username = minted.username;
    password = minted.password;
    const named = await updateMeDirect(httpUrl, minted.tokens.idToken, { name: "Mac" });
    golfer = named.golfer;
    // The same shared fixture course every other spec seeds — search-first, create-if-absent, so
    // three consecutive gate runs add nothing to beta.
    course = await ensureCourse(fixtureLinks18.courseName, fixtureLinks18, { tokens: minted.tokens, golfer });
    loopback = await startLoopback();
    page = await browser.newContext().then((context) => context.newPage());
    navigations = watchNavigations(page);
  });

  test.afterAll(async () => {
    await page?.context().close();
    await loopback?.close();
  });

  // -- 1. Discovery, exactly as an MCP client performs it ------------------------------------

  test("1. an unauthenticated POST is challenged, and the challenge leads to metadata that names this endpoint", async () => {
    const started = Date.now();
    const challenged = await fetch(CANONICAL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    console.log(`[mcp gate] first (cold) request to ${CANONICAL}: ${Date.now() - started}ms`);

    // POST, not GET: only POST and GET are routed on the canonical path, and the SDK's
    // legacy-stateless mode answers a GET with 405 rather than a challenge (asserted in step 4,
    // where there is a token to make the difference visible).
    expect(challenged.status).toBe(401);
    const challenge = challenged.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    // The pointer RFC 9728 §5.1 requires: without it a client has nowhere to go from a 401.
    const advertised = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(advertised, `no resource_metadata in: ${challenge}`).toBe(`${AS_ORIGIN}/.well-known/oauth-protected-resource/mcp`);

    // Both documents are followed from where the challenge actually pointed, not from a path
    // typed here — the bare form is checked too because clients disagree about which to try.
    for (const url of [advertised!, `${AS_ORIGIN}/.well-known/oauth-protected-resource`]) {
      const prm = (await (await fetch(url)).json()) as { resource?: unknown; authorization_servers?: unknown; scopes_supported?: unknown };
      expect(prm.resource, `PRM at ${url}`).toBe(CANONICAL);
      expect(prm.authorization_servers).toEqual([AS_ORIGIN]);
      // Read only, deliberately (metadata.ts): write is granted at the consent page and never
      // invited by a metadata document, because the CLIENT chooses from what it is offered.
      expect(prm.scopes_supported).toEqual([READ_SCOPE]);
    }

    const as = (await (await fetch(`${AS_ORIGIN}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(AS_ORIGIN);
    expect(as.authorization_endpoint).toBe(`${AS_ORIGIN}/authorize`);
    expect(as.token_endpoint).toBe(`${AS_ORIGIN}/token`);
    expect(as.registration_endpoint).toBe(`${AS_ORIGIN}/register`);
    // A client-side MUST-refuse-to-proceed if absent (design spec §4.3): omitting it fails every
    // connection before it starts.
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    // The pair Claude requires TOGETHER before it will use CIMD instead of deprecated DCR.
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  test("2. a client registers itself with a loopback redirect URI", async () => {
    // The registered port and the bound port differ on purpose (startLoopback binds port 0), so
    // every later redirect that lands is RFC 8252 §7.3 port-agnostic matching working live.
    expect(new URL(loopback.redirectUri).port).not.toBe(String(REGISTERED_PORT));
    clientId = await registerClient(`http://127.0.0.1:${REGISTERED_PORT}/callback`, "swng MCP beta gate");
  });

  // -- 2. The write consent: the one property nothing hermetic can reach ----------------------

  test("3. a golfer signs in at managed login, chooses read AND write, and the grant carries both", async () => {
    const pkce = newPkce();
    const state = `gate-write-${Date.now()}`;

    await page.goto(authorizeUrl(clientId, loopback.redirectUri, pkce, state));
    await signInThroughManagedLogin(page, username, password);

    // The consent page must name who is asking and where the code will go — the two facts a
    // mediating proxy holding a static upstream client id is required to show (design spec §4.3).
    await expect(page.getByRole("heading", { name: /^swng MCP beta gate wants to access your swng account$/ })).toBeVisible();
    await expect(page.getByText("127.0.0.1", { exact: true })).toBeVisible();

    const beforeConsent = navigations.length;
    const landed = loopback.next();
    await approveConsent(page, "read_write");
    const callback = await landed;

    // THE SILENT SECOND LEG. Choosing read+write mints nothing at the consent page: it 302s back
    // through Cognito with the widened scope, and Cognito does not re-prompt because the session
    // from the sign-in above is still live. Nothing hermetic can observe that — this can.
    const stepUp = cognitoAuthorizeHops(navigations.slice(beforeConsent), hostedUiDomain);
    expect(stepUp, `no Cognito /oauth2/authorize hop after consent; navigations were ${JSON.stringify(navigations.slice(beforeConsent))}`).toHaveLength(1);
    expect(stepUp[0]!.searchParams.get("scope")).toBe(`${READ_SCOPE} ${WRITE_SCOPE}`);
    expect(stepUp[0]!.searchParams.get("resource")).toBe(CANONICAL);
    // Silent: the golfer typed a password once, at the top of this test, and never saw a form
    // again. A re-prompt would have parked the browser on Cognito's /login instead of coming home.
    expect(page.url()).toContain(loopback.redirectUri);

    expect(callback.searchParams.get("state")).toBe(state);
    // RFC 9207 issuer identification — a mix-up defence Claude checks.
    expect(callback.searchParams.get("iss")).toBe(AS_ORIGIN);
    const code = callback.searchParams.get("code");
    expect(code, `authorization response carried no code: ${callback.search}`).toBeTruthy();

    const exchangeStarted = Date.now();
    writeTokens = await postToken({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: loopback.redirectUri,
      code_verifier: pkce.verifier,
    });
    const exchangeMs = Date.now() - exchangeStarted;
    console.log(`[mcp gate] /token authorization_code exchange: ${exchangeMs}ms`);
    expect(exchangeMs, "design spec §7: Claude allows 10s for the token exchange").toBeLessThan(EXCHANGE_BUDGET_MS);

    const claims = jwtClaims(writeTokens.accessToken);
    // The whole design in one claim (design spec §4.2 F3): a Cognito resource server identifier
    // may carry a path, so ONE string is the endpoint, the audience and the PRM `resource`.
    expect(claims.aud).toBe(CANONICAL);
    expect(claims.token_use).toBe("access");
    const granted = claimString(claims, "scope").split(" ");
    expect(granted).toContain(READ_SCOPE);
    expect(granted).toContain(WRITE_SCOPE);
  });

  // -- 3. Speaking MCP with the token that consent produced -----------------------------------

  test("4. GET is 405 with a real token — the answer the SDK's client returns cleanly on", async () => {
    // A deploy-blocking finding one round ago, and only a real token can see it: without one the
    // 401 challenge fires first and hides whatever the transport would have got. Anything but 405
    // makes @modelcontextprotocol/client throw ClientHttpFailedToOpenStream instead of shrugging
    // at "no SSE stream here".
    const withToken = await fetch(CANONICAL, {
      method: "GET",
      headers: { authorization: `Bearer ${writeTokens.accessToken}`, accept: "text/event-stream" },
    });
    expect(withToken.status).toBe(405);
  });

  test("5. tools/list under a read+write grant shows the whole write surface", async () => {
    const client = await connectMcp(writeTokens.accessToken);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("get_round");
      for (const write of WRITE_TOOLS) expect(names, `${write} missing from a read+write grant`).toContain(write);
    } finally {
      await client.close();
    }
  });

  test("6. a round is started, scored and finalized entirely over MCP", async () => {
    const client = await connectMcp(writeTokens.accessToken);
    try {
      // The MCP credential resolves to the SAME golfer the ordinary API bound to this `sub` —
      // if the sub-binding differed, the round below would be started by a stranger.
      const me = parse(getMeResponseSchema, structured(await client.callTool({ name: "whoami", arguments: {} }), "whoami"));
      expect(me.golfer?.golferId).toBe(golfer.golferId);

      const started = parse(
        startRoundResponseSchema,
        structured(
          await client.callTool({ name: "start_round", arguments: { course: { courseId: course.courseId, cardId: course.cardId }, host: { tee: "white" } } }),
          "start_round",
        ),
      );
      roundId = started.roundId;
      // A live, write-capable round credential must never reach the model's transcript
      // (server.ts's REDACTS_TOKEN) — the response shape still carries the field, redacted.
      expect(started.token).toContain("[redacted:");

      // The headline write. `record_score` is a "participant"-tier route, so this ALSO exercises
      // dispatchTool minting a round-scoped token from the golfer credential mid-call.
      const scored = await client.callTool({
        name: "record_score",
        arguments: { roundId, golferId: golfer.golferId, hole: 1, result: { kind: "strokes", strokes: 4 } },
      });
      expect(scored.isError, `record_score -> ${JSON.stringify(scored.content)}`).toBeFalsy();

      const finalized = await client.callTool({ name: "finalize_round", arguments: { roundId } });
      expect(finalized.isError, `finalize_round -> ${JSON.stringify(finalized.content)}`).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  test("7. get_round reads a FINALIZED round — the read no round-scoped token could ever serve", async () => {
    const client = await connectMcp(writeTokens.accessToken);
    try {
      const view = parse(roundViewResponseSchema, structured(await client.callTool({ name: "get_round", arguments: { roundId } }), "get_round"));
      // mintParticipantToken throws "round-final" for exactly this round, which is why
      // /rounds/{roundId}/view is "golfer"-tier (design spec §5.1). A settled card is the whole
      // product argument for the arc, and it is only readable because of that tier choice.
      expect(view.status).toBe("final");
      expect(view.card.courseName).toBe(fixtureLinks18.courseName);
      expect(view.participants.map((entry) => entry.golferId)).toContain(golfer.golferId);
    } finally {
      await client.close();
    }
  });

  // -- 4. The differential: read-only actually means read-only --------------------------------

  test("8. the same golfer consenting read-only gets a read-only token and no write tools", async () => {
    const pkce = newPkce();
    const state = `gate-read-${Date.now()}`;

    await page.goto(authorizeUrl(clientId, loopback.redirectUri, pkce, state));
    // No password is typed in this test at all. The Cognito session from test 3 is still live, so
    // /authorize lands straight on our consent page — the SAME session reuse the silent write
    // step-up depends on, observed here from the other side.
    await expect(page).toHaveURL(new RegExp(`^${AS_ORIGIN}/oauth/callback`));

    const beforeConsent = navigations.length;
    const landed = loopback.next();
    await approveConsent(page, "read");
    const callback = await landed;

    // Read-only mints the code from the leg-1 tokens already held: no second Cognito hop at all.
    // This is the counterpart of test 3's assertion — together they show the radio is what
    // decides, not the client's request (which asked for read in both).
    expect(cognitoAuthorizeHops(navigations.slice(beforeConsent), hostedUiDomain)).toHaveLength(0);
    expect(callback.searchParams.get("state")).toBe(state);

    const readTokens = await postToken({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: loopback.redirectUri,
      code_verifier: pkce.verifier,
    });

    const claims = jwtClaims(readTokens.accessToken);
    expect(claims.aud).toBe(CANONICAL);
    const granted = claimString(claims, "scope").split(" ");
    expect(granted).toContain(READ_SCOPE);
    expect(granted).not.toContain(WRITE_SCOPE);

    const client = await connectMcp(readTokens.accessToken);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("get_round");
      for (const write of WRITE_TOOLS) expect(names, `${write} offered to a read-only grant`).not.toContain(write);
    } finally {
      await client.close();
    }
  });

  // -- 5. Refresh ------------------------------------------------------------------------------

  test("9. refresh rotates the handle and the audience survives it", async () => {
    const refreshed = await postToken({ grant_type: "refresh_token", refresh_token: writeTokens.refreshToken, client_id: clientId });

    // Design spec §4.3: the handle is OURS, opaque, and rotated on every redemption — OAuth 2.1
    // requires rotation for the public clients every CIMD/DCR client is.
    expect(refreshed.refreshToken).not.toBe(writeTokens.refreshToken);

    // Spec §4.2 F4: Cognito carries `aud` and `scope` through the refresh grant unchanged. If it
    // did not, a connection would silently lose its audience an hour in and start 401-ing.
    const claims = jwtClaims(refreshed.accessToken);
    expect(claims.aud).toBe(CANONICAL);
    const granted = claimString(claims, "scope").split(" ");
    expect(granted).toContain(READ_SCOPE);
    expect(granted).toContain(WRITE_SCOPE);
    expect(refreshed.accessToken).not.toBe(writeTokens.accessToken);

    // And the refreshed token still opens the endpoint — the claim that matters is not the
    // decoded JSON but that the deployed verifier accepts it.
    const client = await connectMcp(refreshed.accessToken);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("record_score");
    } finally {
      await client.close();
    }
  });
});
