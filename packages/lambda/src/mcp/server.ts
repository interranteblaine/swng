import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult, McpHandlerRequestOptions, McpHttpHandler, McpRequestContext } from "@modelcontextprotocol/server";
import type { Route } from "../http/routes.js";
import type { HttpRequest, HttpResponse } from "../http/httpRequest.js";
import { dispatchTool } from "./toolDispatch.js";
import { TOOL_TABLE } from "./toolTable.js";
import type { ToolDefinition } from "./toolTable.js";

// The 2026-07-28 revision is stateless (design spec §2): no `initialize` handshake, no
// `Mcp-Session-Id`, no server-initiated requests — so `createMcpHandler` calls this factory
// once PER HTTP REQUEST, never once per connection. That is exactly what makes per-request tool
// filtering possible: `ctx.authInfo` is this request's own credential, not something remembered
// from an earlier call, so a `McpServer` built here sees only what THIS token is entitled to.
export interface McpServerDeps {
  readonly dispatch: (request: HttpRequest) => Promise<HttpResponse>;
  readonly routes: readonly Route[];
}

// Design spec §4.4: read tools are on every connection (scopes_supported advertises only
// `…/mcp/read`, so a bare connection request still lists them); a write tool is listed only when
// the granted scopes carry `…/mcp/write` — never inferred from anything else, and never a
// runtime step-up (a tool never listed is never called, so `requireBearerAuth`'s
// `requiredScopes` step-up path cannot fire here — deliberately, per §4.4, not wired).
const isVisible = (tool: ToolDefinition, scopes: readonly string[]): boolean =>
  tool.scope === "read" || scopes.some((scope) => scope.endsWith("/write"));

// Renders one dispatcher HttpResponse as a CallToolResult. A 4xx/5xx becomes `isError: true` —
// a normal RETURN value from `dispatchTool` (a failed mint, a use-case ApplicationError already
// mapped to a status code by errorMapping.ts), never a thrown protocol error — so it is handled
// as data here, not caught. What IS thrown — e.g. `mintedToken`'s `parse()` on a malformed 2xx
// mint body (toolDispatch.ts's own comment: "deliberately, for this layer to handle") —
// propagates OUT of this function uncaught. It is the SDK's own `tools/call` request handler
// (registerTool's `executeToolHandler`, wrapped in a try/catch one layer up, outside this file)
// that turns an uncaught throw into the identical `{ content: [...], isError: true }` shape —
// there is deliberately no second try/catch here duplicating that.
//
// Every response body IS valid JSON (the dispatcher only ever emits `jsonResponse`d bodies,
// errorMapping.ts included) — `structuredContent` is parsed unconditionally, not defensively
// re-tried, and no `outputSchema` is declared (spec §5) so nothing validates it against a
// schema.
const renderResult = (response: HttpResponse): CallToolResult => ({
  content: [{ type: "text", text: response.body }],
  structuredContent: JSON.parse(response.body) as Record<string, unknown>,
  isError: response.statusCode >= 400,
});

// The one entry point: builds the `McpHttpHandler` (`{ fetch, close, notify, bus }`) that a
// Lambda entry (Task 13) hands `POST /mcp` to. `createMcpHandler`'s own `legacy: 'stateless'`
// default is kept (design spec §2) — 2025-era Claude and the 2026-07-28 revision both land on
// this one endpoint.
export const createSwngMcpHandler = (deps: McpServerDeps): McpHttpHandler =>
  createMcpHandler((ctx: McpRequestContext) => {
    // `authInfo` is OPTIONAL on the factory context (strictly pass-through — the SDK performs
    // no verification of its own) and so is `.scopes` on it; `?? []` is the only safe read.
    const scopes = ctx.authInfo?.scopes ?? [];
    const credential = ctx.authInfo?.token ?? "";

    const server = new McpServer({ name: "swng", version: "0.1.0" });

    for (const tool of TOOL_TABLE) {
      if (!isVisible(tool, scopes)) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          // No `outputSchema` in v1 (design spec §5): authoring one means a zod mirror of every
          // response shape, including a five-arm GameState union — real work with its own
          // review, not a field on a tool definition.
        },
        async (args) => renderResult(await dispatchTool(deps, tool, args as Record<string, unknown>, credential)),
      );
    }

    return server;
  });

// Re-exported so a caller (Task 13's Lambda entry, and this file's own test) never has to reach
// past this module into the SDK for the request-options shape `handler.fetch` takes.
export type { McpHandlerRequestOptions };
