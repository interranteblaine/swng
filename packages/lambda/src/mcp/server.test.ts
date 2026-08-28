import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { buildRoutes } from "../http/routes.js";
import type { UseCases } from "../http/routes.js";
import type { HttpRequest, HttpResponse } from "../http/httpRequest.js";
import { createSwngMcpHandler } from "./server.js";

// buildRoutes only needs a UseCases-shaped value to read the route TABLE off — matching
// toolDispatch.test.ts's own stubUseCases. No test here ever calls a real use case; `dispatch`
// is a fake that answers whatever the test wants dispatchTool to see.
const stubUseCases = new Proxy({}, { get: () => async () => undefined }) as UseCases;
const ROUTES = buildRoutes(stubUseCases);

const READ_SCOPE = "https://mcp.swng.golf/mcp/read";
const WRITE_SCOPE = "https://mcp.swng.golf/mcp/write";

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

// Do NOT use InMemoryTransport: it wires a Client straight to a Server and bypasses
// createMcpHandler entirely, proving nothing about the path production uses (`POST /mcp` →
// `handler.fetch`). This drives the SAME `McpHttpHandler.fetch` a real Lambda entry calls, over
// a real StreamableHTTPClientTransport, with a custom `fetch` that is the ONLY thing standing in
// for the network — `authInfo` rides in exactly where the brief says it must:
// `handler.fetch(request, { authInfo })`.
const connect = async (dispatch: (request: HttpRequest) => Promise<HttpResponse>, scopes: readonly string[]): Promise<Client> => {
  const handler = createSwngMcpHandler({ dispatch, routes: ROUTES });
  const info = authInfo(scopes);

  const fetchThroughHandler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler.fetch(request, { authInfo: info });
  };

  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test.swng.golf/mcp"), { fetch: fetchThroughHandler });
  const client = new Client({ name: "server.test.ts", version: "0.0.0" });
  await client.connect(transport);
  return client;
};

describe("createSwngMcpHandler", () => {
  it("hides write tools from a read-only token", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(dispatch, [READ_SCOPE]);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("get_round");
    expect(names).not.toContain("record_score");

    await client.close();
  });

  it("shows write tools when the write scope is present", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const client = await connect(dispatch, [READ_SCOPE, WRITE_SCOPE]);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("get_round");
    expect(names).toContain("record_score");

    await client.close();
  });

  it("reports an application error as a tool execution error, not a protocol error", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(404, { code: "round-not-found", message: "no such round" }));
    const client = await connect(dispatch, [READ_SCOPE]);

    const result = await client.callTool({ name: "get_round", arguments: { roundId: "no-such-round" } });

    expect(result.isError).toBe(true);

    await client.close();
  });
});
