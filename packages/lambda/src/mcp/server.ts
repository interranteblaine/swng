import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult, McpHttpHandler, McpRequestContext } from "@modelcontextprotocol/server";
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
//
// `writeScope` is the exact granted-scope string (Task 13's `CANONICAL + "/write"`) that unlocks
// write tools — an explicit input, never a hardcoded suffix. Review round 1: a suffix match
// (`scope.endsWith("/write")`) fails OPEN the day a second resource server ever issues a scope
// ending in "/write" — any such token would unlock every write tool here regardless of which
// resource it was actually bound to. Taking the canonical scope as a caller-supplied value and
// comparing for EQUALITY closes that: only a token carrying exactly Task 13's own write scope
// can see a write tool, ever.
export interface McpServerDeps {
  readonly dispatch: (request: HttpRequest) => Promise<HttpResponse>;
  readonly routes: readonly Route[];
  readonly writeScope: string;
}

// Design spec §4.4: read tools are on every connection (scopes_supported advertises only
// `…/mcp/read`, so a bare connection request still lists them); a write tool is listed only when
// the granted scopes carry EXACTLY `writeScope` — never inferred from anything else, and never a
// runtime step-up (a tool never listed is never called, so `requireBearerAuth`'s
// `requiredScopes` step-up path cannot fire here — deliberately, per §4.4, not wired).
const isVisible = (tool: ToolDefinition, scopes: readonly string[], writeScope: string): boolean =>
  tool.scope === "read" || scopes.includes(writeScope);

// Two tools mint a round-scoped credential as a SIDE EFFECT of the write they perform —
// StartRoundResponse/JoinRoundResponse both carry `token` (contracts/commands.ts) — and
// toolDispatch.ts's own doc comment on why "participant" routes exist at all says the model is
// never supposed to hold one of these: "an agent authenticates as a golfer, not as a device that
// joined a round." dispatchTool mints a FRESH round-scoped token per participant-tier call, so
// the agent never needs the one riding home from start/join — putting it in the tool result
// anyway would place a live write-capable bearer credential into the model's own transcript,
// exfiltratable by prompt injection and loggable by any client sitting in front of the model.
// Redacted here, not upstream in dispatchTool, because dispatchTool's job is "what goes on the
// wire to swng," not "what a model is allowed to see" — redaction is a rendering concern.
const REDACTS_TOKEN = new Set(["start_round", "join_round"]);
const REDACTED_TOKEN = "[redacted: the agent is never handed this credential — dispatchTool mints a fresh round-scoped token per participant-tier call]";

// A response body the dispatcher emits is always a JSON object (every route answers through
// jsonResponse, errorMapping.ts included) — but that invariant lives in another file, and
// CLAUDE.md is explicit ("a type must not assert what the read path cannot guarantee — parse
// stored data, never cast it"). So this parses defensively rather than casting an unconditional
// `JSON.parse(...)`: an empty body, a bare scalar, or an array all parse to `undefined` here
// instead of throwing (which, uncaught, would turn a successful empty-body 2xx into a spurious
// `isError: true`) or silently mistyping as a "record" (which would misreport a non-object
// success as clean `structuredContent`). `content[0].text` always carries the RAW body either
// way — only `structuredContent` is affected.
const parseObjectBody = (body: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
};

// Renders one dispatcher HttpResponse as a CallToolResult. A 4xx/5xx becomes `isError: true` —
// a normal RETURN value from `dispatchTool` (a failed mint, a use-case ApplicationError already
// mapped to a status code by errorMapping.ts), never a thrown protocol error — so it is handled
// as data here, not caught. What IS thrown — e.g. `mintedToken`'s `parse()` on a malformed 2xx
// mint body (toolDispatch.ts's own comment: "deliberately, for this layer to handle") —
// propagates OUT of this function uncaught. It is the SDK's own `tools/call` request handler
// (registerTool's `executeToolHandler`, wrapped in a try/catch one layer up, outside this file)
// that turns an uncaught throw into the identical `{ content: [...], isError: true }` shape —
// there is deliberately no second try/catch here duplicating that.
const renderResult = (tool: ToolDefinition, response: HttpResponse): CallToolResult => {
  const parsed = parseObjectBody(response.body);
  const redact = parsed !== undefined && REDACTS_TOKEN.has(tool.name) && "token" in parsed;
  const structuredContent = redact ? { ...parsed, token: REDACTED_TOKEN } : parsed;
  const text = redact ? JSON.stringify(structuredContent) : response.body;

  return {
    content: [{ type: "text", text }],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    isError: response.statusCode >= 400,
  };
};

// The one entry point: builds the `McpHttpHandler` (`{ fetch, close, notify, bus }`) that a
// Lambda entry (Task 13) hands `POST /mcp` to. `createMcpHandler`'s own `legacy: 'stateless'`
// default is kept (design spec §2) — 2025-era Claude and the 2026-07-28 revision both land on
// this one endpoint.
export const createSwngMcpHandler = (deps: McpServerDeps): McpHttpHandler =>
  createMcpHandler((ctx: McpRequestContext) => {
    // `authInfo` is OPTIONAL on the factory context (strictly pass-through — the SDK performs
    // no verification of its own) and so is `.scopes` on it; `?? []` is the only safe read. An
    // ENTIRELY absent `authInfo` (no bearer token at all, or Task 13's own gate not yet wired in
    // front of this handler) degrades to the same posture as a granted-but-empty scope list:
    // read tools only, and whatever credential-less request `dispatchTool` sends onward is the
    // dispatcher's own 401 to handle, not this file's.
    const scopes = ctx.authInfo?.scopes ?? [];
    const credential = ctx.authInfo?.token ?? "";

    const server = new McpServer({ name: "swng", version: "0.1.0" });

    for (const tool of TOOL_TABLE) {
      if (!isVisible(tool, scopes, deps.writeScope)) continue;
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
        async (args) => renderResult(tool, await dispatchTool(deps, tool, args as Record<string, unknown>, credential)),
      );
    }

    return server;
  });
