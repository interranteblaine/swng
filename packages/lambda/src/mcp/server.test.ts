import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { buildRoutes } from "../http/routes.js";
import type { UseCases } from "../http/routes.js";
import type { HttpRequest, HttpResponse } from "../http/httpRequest.js";
import { createSwngMcpHandler } from "./server.js";

// buildRoutes only needs a UseCases-shaped value to read the route TABLE off — matching
// toolDispatch.test.ts's own stubUseCases. No test here ever calls a real use case; `dispatch`
// is a fake that answers whatever the test wants dispatchTool to see.
const stubUseCases = new Proxy({}, { get: () => async () => undefined }) as UseCases;
const ROUTES = buildRoutes(stubUseCases);

// The canonical write scope this test suite's handlers are built with — deliberately NOT the
// suffix-matched string review round 1 flagged (`server.ts`'s `isVisible` now compares for
// EQUALITY against this exact value, taken as an explicit McpServerDeps.writeScope input).
const WRITE_SCOPE = "https://mcp.swng.golf/mcp/write";
const READ_SCOPE = "https://mcp.swng.golf/mcp/read";

const jsonResponse = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const authInfo = (scopes: readonly string[]): AuthInfo => ({
  token: "ACCESS",
  clientId: "test-client",
  scopes: [...scopes],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

const buildHandler = (dispatch: (request: HttpRequest) => Promise<HttpResponse>): McpHttpHandler =>
  createSwngMcpHandler({ dispatch, routes: ROUTES, writeScope: WRITE_SCOPE });

// Do NOT use InMemoryTransport: it wires a Client straight to a Server and bypasses
// createMcpHandler entirely, proving nothing about the path production uses (`POST /mcp` →
// `handler.fetch`). This drives the SAME `McpHttpHandler.fetch` a real Lambda entry calls, over
// a real StreamableHTTPClientTransport, with a custom `fetch` that is the ONLY thing standing in
// for the network — `authInfo` rides in exactly where the brief says it must:
// `handler.fetch(request, { authInfo })`. Takes an already-built `handler` (rather than building
// one itself) so a caller can reuse the SAME handler across multiple `connect` calls — the only
// way to test that one handler instance never leaks one request's tool list into another's
// (review round 1, fix 3: per-request isolation).
const connect = async (handler: McpHttpHandler, info: AuthInfo | undefined): Promise<Client> => {
  const fetchThroughHandler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return info === undefined ? handler.fetch(request) : handler.fetch(request, { authInfo: info });
  };

  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test.swng.golf/mcp"), { fetch: fetchThroughHandler });
  const client = new Client({ name: "server.test.ts", version: "0.0.0" });
  await client.connect(transport);
  return client;
};

describe("createSwngMcpHandler", () => {
  it("hides write tools from a read-only token", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE]));

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("get_round");
    expect(names).not.toContain("record_score");

    await client.close();
  });

  it("shows write tools when the write scope is present", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE, WRITE_SCOPE]));

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("get_round");
    expect(names).toContain("record_score");

    await client.close();
  });

  // Fix 1 (review round 1, "important"): a suffix match on "/write" fails OPEN — any granted
  // scope ending in "/write", from ANY resource server, would have unlocked every write tool.
  // A token scoped to a wholly different resource server's own "/write" scope must see NONE of
  // swng's write tools; only equality with `deps.writeScope` may unlock them.
  it("does not treat a foreign resource server's own write scope as swng's write scope", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(buildHandler(dispatch), authInfo(["https://other.example/api/write"]));

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    const writeToolNames = ["start_round", "join_round", "record_score", "set_participant_strokes", "set_round_holes", "set_round_played_at", "add_game", "terminate_game", "finalize_round", "abandon_round", "leave_round", "share_round"];
    for (const writeTool of writeToolNames) expect(names).not.toContain(writeTool);
    expect(names).toContain("get_round");

    await client.close();
  });

  it("reports an application error as a tool execution error, not a protocol error", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(404, { code: "round-not-found", message: "no such round" }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE]));

    const result = await client.callTool({ name: "get_round", arguments: { roundId: "no-such-round" } });

    expect(result.isError).toBe(true);

    await client.close();
  });

  // Fix 3, "the success path": no prior test ever asserted a SUCCESSFUL call's rendered shape —
  // only the 404 path exercised `content`/`structuredContent` at all.
  it("renders a successful call's structuredContent and text from the dispatcher's own body", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { status: "live", card: { holes: 18 } }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE]));

    const result = await client.callTool({ name: "get_round", arguments: { roundId: "r1" } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "live", card: { holes: 18 } });
    const [content] = result.content as { type: string; text: string }[];
    expect(content?.type).toBe("text");
    expect(JSON.parse(content?.text ?? "")).toEqual({ status: "live", card: { holes: 18 } });

    await client.close();
  });

  // Fix 3, "the credential": replacing `ctx.authInfo?.token ?? ""` with `""` would break every
  // authenticated call in production while every OTHER test in this file kept passing, because
  // none of them ever inspected what `dispatch` was actually called WITH. This one does.
  it("dispatches the tool call with the caller's own bearer token and the filled path", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE]));

    await client.callTool({ name: "get_round", arguments: { roundId: "r-credential-test" } });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/rounds/r-credential-test/view",
        headers: expect.objectContaining({ authorization: "Bearer ACCESS" }),
      }),
    );

    await client.close();
  });

  // Fix 3, "per-request isolation": the SDK's own claim (confirmed against source in the task 12
  // report) is that `createMcpHandler`'s factory runs once PER REQUEST under `legacy:
  // 'stateless'`, so ONE handler instance serving a read-only request and then a write-scoped
  // request must not leak either list into the other, in either direction.
  it("never leaks one request's visible tool list into another request on the SAME handler", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const handler = buildHandler(dispatch);

    const readOnlyClient = await connect(handler, authInfo([READ_SCOPE]));
    const readOnlyNames = (await readOnlyClient.listTools()).tools.map((tool) => tool.name);
    await readOnlyClient.close();

    const writeClient = await connect(handler, authInfo([READ_SCOPE, WRITE_SCOPE]));
    const writeNames = (await writeClient.listTools()).tools.map((tool) => tool.name);
    await writeClient.close();

    const readOnlyAgainClient = await connect(handler, authInfo([READ_SCOPE]));
    const readOnlyAgainNames = (await readOnlyAgainClient.listTools()).tools.map((tool) => tool.name);
    await readOnlyAgainClient.close();

    expect(readOnlyNames).not.toContain("record_score");
    expect(writeNames).toContain("record_score");
    expect(readOnlyAgainNames).not.toContain("record_score");
  });

  // Fix 3, "call-by-name rejection": "hidden" and "forbidden" are indistinguishable unless
  // something actually tries calling the unlisted tool by name. A read-only connection has never
  // REGISTERED record_score at all (server.ts's own `for` loop skips it), so the SDK's own
  // `tools/call` handler answers `Tool record_score not found` — a real protocol-level rejection,
  // not merely an absence from `tools/list`.
  it("rejects calling a write tool by name on a read-only connection", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE]));

    await expect(client.callTool({ name: "record_score", arguments: { roundId: "r1", golferId: "g1", holeNumber: 1, strokes: 4 } })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();

    await client.close();
  });

  // Fix 3, "absent authInfo": no test previously called `handler.fetch` with NO options object at
  // all (only with `authInfo: undefined` inside one). `ctx.authInfo` is genuinely absent (not
  // merely scopeless) on a bare/unauthenticated request, and `isVisible`/the credential fallback
  // must both still degrade safely — read tools only, no throw.
  it("degrades to read-only tools when authInfo is entirely absent from the fetch call", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(buildHandler(dispatch), undefined);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("get_round");
    expect(names).not.toContain("record_score");

    await client.close();
  });

  // Fix 2 (review round 1, "important"): start_round/join_round mint a round-scoped token as a
  // SIDE EFFECT of the write — a live write-capable bearer credential the agent never needs
  // (dispatchTool mints a FRESH one per participant-tier call) and must never see in its own
  // transcript.
  it("redacts the minted round token from start_round's result", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(201, { roundId: "r1", joinCode: "ABC123", token: "LIVE-WRITE-CAPABLE-SECRET", golferId: "g1" }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE, WRITE_SCOPE]));

    const result = await client.callTool({ name: "start_round", arguments: { course: { courseId: "c1", cardId: "card1" }, host: { tee: "White" } } });

    const [content] = result.content as { type: string; text: string }[];
    expect(content?.text ?? "").not.toContain("LIVE-WRITE-CAPABLE-SECRET");
    expect(JSON.stringify(result.structuredContent)).not.toContain("LIVE-WRITE-CAPABLE-SECRET");
    // The rest of the mint response is still legible — only `token` is redacted, not the whole result.
    expect(result.structuredContent).toMatchObject({ roundId: "r1", joinCode: "ABC123", golferId: "g1" });

    await client.close();
  });

  it("redacts the minted round token from join_round's result", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { roundId: "r1", token: "LIVE-WRITE-CAPABLE-SECRET", golferId: "g1", joinCode: "ABC123" }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE, WRITE_SCOPE]));

    const result = await client.callTool({ name: "join_round", arguments: { code: "ABC23G", tee: "White" } });

    const [content] = result.content as { type: string; text: string }[];
    expect(content?.text ?? "").not.toContain("LIVE-WRITE-CAPABLE-SECRET");
    expect(JSON.stringify(result.structuredContent)).not.toContain("LIVE-WRITE-CAPABLE-SECRET");

    await client.close();
  });

  // A read tool's response never carries a "token" field to begin with in this fixture, but the
  // redaction gate is keyed on TOOL NAME, not field sniffing alone — pin that get_round (never in
  // REDACTS_TOKEN) passes any body through untouched, including one that happens to have a
  // `token`-shaped key, so the gate is provably name-scoped and not a blanket field strip.
  it("does not redact a token-shaped field on a tool outside the redaction list", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { status: "live", token: "not-actually-a-credential" }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE]));

    const result = await client.callTool({ name: "get_round", arguments: { roundId: "r1" } });

    expect(result.structuredContent).toEqual({ status: "live", token: "not-actually-a-credential" });

    await client.close();
  });

  // Fix 5: an empty successful body must not become a spurious tool-execution error (an
  // unconditional `JSON.parse("")` would throw, get caught by the SDK's own try/catch one layer
  // up, and mis-render a genuine 2xx as `isError: true`).
  it("does not report isError on a successful call whose body is empty", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => ({ statusCode: 200, headers: {}, body: "" }));
    const client = await connect(buildHandler(dispatch), authInfo([READ_SCOPE]));

    const result = await client.callTool({ name: "get_round", arguments: { roundId: "r1" } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeUndefined();

    await client.close();
  });
});
