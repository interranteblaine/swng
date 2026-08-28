import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildRoutes } from "../http/routes.js";
import type { Route, UseCases } from "../http/routes.js";
import type { HttpRequest, HttpResponse } from "../http/httpRequest.js";
import { TOOL_TABLE } from "./toolTable.js";
import type { ToolDefinition } from "./toolTable.js";
import { dispatchTool } from "./toolDispatch.js";

// buildRoutes only needs a UseCases-shaped value to read the route TABLE off (toolTable.test.ts's
// own stubUseCases) — none of these tests ever call a use case, they only assert on what
// dispatchTool sends to `deps.dispatch`.
const stubUseCases = new Proxy({}, { get: () => async () => undefined }) as UseCases;
const REAL_ROUTES = buildRoutes(stubUseCases);

const tool = (name: string): ToolDefinition => {
  const found = TOOL_TABLE.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

const jsonResponse = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("dispatchTool", () => {
  it("sends the caller's own access token for a golfer-tier route", async () => {
    const dispatch = vi.fn(async (_request: HttpRequest): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const deps = { dispatch, routes: REAL_ROUTES };

    await dispatchTool(deps, tool("get_round"), { roundId: "r1" }, "ACCESS");

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      method: "GET",
      path: "/rounds/r1/view",
      headers: { authorization: "Bearer ACCESS" },
    });
  });

  it("mints a round-scoped token for a participant route and sends THAT", async () => {
    const dispatch = vi.fn(
      async (request: HttpRequest): Promise<HttpResponse> =>
        request.path === "/rounds/r1/token" ? jsonResponse(200, { roundId: "r1", token: "ROUND-TOKEN", golferId: "g1", joinCode: "ABC123" }) : jsonResponse(200, { ok: true }),
    );
    const deps = { dispatch, routes: REAL_ROUTES };

    await dispatchTool(deps, tool("set_round_holes"), { roundId: "r1", holes: "back" }, "ACCESS");

    expect(dispatch).toHaveBeenCalledTimes(2);
    // The credential rides in `headers.authorization` — HttpRequest has no `bearer` field, and
    // the dispatcher reads the header exactly as it does for a real HTTP call.
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ path: "/rounds/r1/token", headers: { authorization: "Bearer ACCESS" } });
    expect(dispatch.mock.calls[1]![0]).toMatchObject({ path: "/rounds/r1/holes", headers: { authorization: "Bearer ROUND-TOKEN" } });
  });

  it("surfaces a failed mint instead of calling the route with a bad token", async () => {
    const dispatch = vi.fn(async (): Promise<HttpResponse> => jsonResponse(409, { code: "round-final", message: "the round is finalized" }));
    const deps = { dispatch, routes: REAL_ROUTES };

    const result = await dispatchTool(deps, tool("set_round_holes"), { roundId: "r1", holes: "back" }, "ACCESS");

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toMatchObject({ code: "round-final" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("routes path args to the path, query args to the query, the rest to the body", async () => {
    const customTool: ToolDefinition = {
      name: "custom_tool",
      title: "Custom tool",
      description: "test fixture",
      scope: "write",
      method: "POST",
      path: "/rounds/{roundId}/things",
      pathParams: ["roundId"],
      queryParams: ["verbose"],
      inputSchema: z.object({ roundId: z.string(), verbose: z.string(), note: z.string() }),
    };
    const customRoute: Route = {
      method: "POST",
      path: "/rounds/{roundId}/things",
      auth: "golfer",
      successStatus: 200,
      handler: async () => ({}),
    };
    const dispatch = vi.fn(async (_request: HttpRequest): Promise<HttpResponse> => jsonResponse(200, { ok: true }));
    const deps = { dispatch, routes: [...REAL_ROUTES, customRoute] };

    await dispatchTool(deps, customTool, { roundId: "r9", verbose: "true", note: "hi" }, "ACCESS");

    expect(dispatch).toHaveBeenCalledTimes(1);
    const sent = dispatch.mock.calls[0]![0]!;
    expect(sent.path).toBe("/rounds/r9/things");
    expect(sent.query).toEqual({ verbose: "true" });
    expect(JSON.parse(sent.body!)).toEqual({ note: "hi" });
  });

  it("sends no body for a GET", async () => {
    const dispatch = vi.fn(async (_request: HttpRequest): Promise<HttpResponse> => jsonResponse(200, { courses: [] }));
    const deps = { dispatch, routes: REAL_ROUTES };

    await dispatchTool(deps, tool("search_courses"), { query: "pebble", limit: 5 }, "ACCESS");

    expect(dispatch).toHaveBeenCalledTimes(1);
    const sent = dispatch.mock.calls[0]![0]!;
    expect(sent.method).toBe("GET");
    expect(sent.body).toBeUndefined();
    expect(sent.query).toEqual({ query: "pebble", limit: "5" });
  });

  it("mints opId/hlc for record_score; a model-supplied opId/hlc never reaches the wire", async () => {
    const dispatch = vi.fn(async (_request: HttpRequest): Promise<HttpResponse> => jsonResponse(200, { duplicate: false, seq: 1 }));

    // Even though record_score is a "participant" tier, this test only cares about the SECOND
    // dispatch call's body — the mint is exercised by its own test above.
    const mintingDispatch = vi.fn(
      async (request: HttpRequest): Promise<HttpResponse> =>
        request.path === "/rounds/r1/token"
          ? jsonResponse(200, { roundId: "r1", token: "ROUND-TOKEN", golferId: "g1", joinCode: "ABC123" })
          : dispatch(request),
    );

    await dispatchTool(
      { dispatch: mintingDispatch, routes: REAL_ROUTES },
      tool("record_score"),
      // A model handing back opId/hlc anyway (it can't, per the tool's `.omit`ed schema, but
      // dispatchTool must not trust that upstream enforcement alone) must not reach the wire.
      { roundId: "r1", golferId: "g1", hole: 1, result: { kind: "strokes", strokes: 4 }, opId: "smuggled-op", hlc: { wallMs: 1, counter: 1, deviceId: "smuggled" } },
      "ACCESS",
    );

    expect(mintingDispatch).toHaveBeenCalledTimes(2);
    const sent = mintingDispatch.mock.calls[1]![0]!;
    const body = JSON.parse(sent.body!);
    expect(body.opId).not.toBe("smuggled-op");
    expect(body.hlc.deviceId).toBe("mcp");
    expect(body.golferId).toBe("g1");
    expect(body.hole).toBe(1);
  });
});
