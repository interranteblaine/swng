import { randomUUID } from "node:crypto";
import { createHlcSource, deviceId, opId } from "@swng/domain";
import { joinRoundResponseSchema, parse } from "@swng/contracts";
import type { Route } from "../http/routes.js";
import type { HttpRequest, HttpResponse } from "../http/httpRequest.js";
import type { ToolDefinition } from "./toolTable.js";

// Everything dispatchTool needs from the composition root: the SAME dispatcher
// buildApp/createDispatcher already produce (design spec §3.1 — "in-process," never a second
// HTTP hop), plus the route table it was built from, so the auth tier of a given tool can be
// looked up rather than re-declared.
export interface ToolDispatchDeps {
  readonly dispatch: (request: HttpRequest) => Promise<HttpResponse>;
  readonly routes: readonly Route[];
}

// Which tier a route sits in decides which credential goes on the wire. The ten "participant"
// routes want a round-scoped token the MCP caller never holds: an agent authenticates as a
// golfer, not as a device that joined a round. Minting it here reuses POST /rounds/{roundId}/
// token, which already proves participation — the SAME dispatch() call every other route goes
// through. No new authorization logic exists in this file.
//
// Reads are deliberately not in this path: GET /rounds/{roundId}/view is "golfer"-tier
// precisely because the mint refuses a finalized round (mintParticipantToken throws
// "round-final"), and a read that only worked while the round is live would fail on exactly
// the rounds list_my_rounds/list_live_rounds return.
//
// The tier map is READ off buildRoutes' own output (deps.routes), folded into a Map keyed
// `${method} ${path}` — never duplicated into TOOL_TABLE (toolTable.ts deliberately keeps auth
// tiers out of the tool table for this reason).
const tierOf = (routes: readonly Route[], method: string, path: string): Route["auth"] | undefined => {
  const byKey = new Map<string, Route["auth"]>(routes.map((route) => [`${route.method} ${route.path}`, route.auth]));
  return byKey.get(`${method} ${path}`);
};

// Fills in a route template's `{name}` segments from the tool's own path args. Each segment is
// percent-encoded individually — HttpRequest.path is documented (httpRequest.ts) as already
// percent-encoded, a precondition dispatch.ts's own decodePathSegments trusts without
// re-checking.
const fillPath = (template: string, pathParams: readonly string[], args: Record<string, unknown>): string =>
  pathParams.reduce((path, name) => path.replace(`{${name}}`, encodeURIComponent(String(args[name]))), template);

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// Extracts the mint's own credential — StartRoundResponse/JoinRoundResponse both carry it as
// `token` (contracts/commands.ts's joinRoundResponseSchema; mintParticipantToken.ts's handler
// returns a JoinRoundResponse verbatim, routes.ts's own doc comment). Parsed against the real
// contract schema, never cast (CLAUDE.md: "a type must not assert what the read path cannot
// guarantee — parse stored data, never cast it") — a shape drift here fails loudly as a
// ContractError instead of silently producing `Bearer undefined`.
const mintedToken = (body: string): string => parse(joinRoundResponseSchema, JSON.parse(body)).token;

// Builds a real HttpRequest (Task 5's transport-agnostic type) for one tool call, given the
// credential that has already been decided (the caller's own access token for a "golfer"
// route, a freshly minted round-scoped token for a "participant" route — buildRequest itself
// doesn't know or care which). Path args go on the path, query args go on the query, everything
// else — with `authored` fields never taken from `args`, always minted here — goes on the body.
// GET carries no body at all: it is dropped on the wire (toolTable.test.ts's own "sends nothing
// in a GET body" pins the table side of this).
const buildRequest = (tool: ToolDefinition, args: Record<string, unknown>, credential: string): HttpRequest => {
  const routedNames = new Set([...tool.pathParams, ...(tool.queryParams ?? []), ...(tool.authored ?? [])]);
  const path = fillPath(tool.path, tool.pathParams, args);

  const query: Record<string, string> = {};
  for (const name of tool.queryParams ?? []) {
    const value = args[name];
    if (value !== undefined) query[name] = String(value);
  }

  if (tool.method === "GET") {
    return { method: tool.method, path, headers: bearer(credential), query, body: undefined };
  }

  const bodyFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!routedNames.has(key)) bodyFields[key] = value;
  }

  // `record_score`'s carve-out (toolTable.ts's `authored`): opId/hlc are the last-writer-wins
  // key the round's convergence rests on — minted HERE, per invocation, never taken from the
  // model's own arguments (`routedNames` above excludes them from the copy loop, so a
  // model-supplied opId/hlc in `args` never reaches `bodyFields` at all — there is nothing to
  // overwrite). ONE FRESH HlcSource per call, deviceId("mcp"). This is NOT what the browser
  // session does: client/session.ts holds a single HlcSource per session and floors it via
  // `observe(event.hlc)` on every remote event it sees (session.ts:96,211); this mints a source
  // that has observed nothing, so `next()` always returns `counter: 0` and `wallMs` is only ever
  // the current wall clock. Consequence: a score whose wallMs does not exceed an existing score's
  // for the same golfer+hole (a clock skewed behind, or two MCP calls in the same millisecond) is
  // silently dropped by the LWW fold (domain/round/state.ts's cells reducer) while this call
  // still returns 200. Not fixed here — observing would need an extra authenticated read of the
  // event log per write, on a differently-tiered route; escalated to the owner as a design call.
  if (tool.authored?.length) {
    if (tool.authored.includes("opId")) bodyFields.opId = opId(randomUUID());
    if (tool.authored.includes("hlc")) bodyFields.hlc = createHlcSource(deviceId("mcp")).next();
  }

  return { method: tool.method, path, headers: bearer(credential), query, body: JSON.stringify(bodyFields) };
};

// The one entry point Task 13's MCP request handler calls per tool invocation, dispatching
// through `deps.dispatch` (the SAME dispatcher buildApp constructs) exactly once for a
// "golfer"-tier tool, and twice — mint, then the named route — for a "participant"-tier one.
export const dispatchTool = async (
  deps: ToolDispatchDeps,
  tool: ToolDefinition,
  args: Record<string, unknown>,
  credential: string,
): Promise<HttpResponse> => {
  const tier = tierOf(deps.routes, tool.method, tool.path);

  switch (tier) {
    case "participant": {
      const roundId = String(args.roundId);
      const mintRequest: HttpRequest = {
        method: "POST",
        path: `/rounds/${encodeURIComponent(roundId)}/token`,
        headers: bearer(credential),
        query: {},
        body: undefined,
      };
      const mintResult = await deps.dispatch(mintRequest);
      // A failed mint short-circuits here: the route this tool actually names is never called,
      // and the mint's OWN status/body is what the caller sees — mintParticipantToken 409s
      // "round-final" for a finalized round, and that is the useful, specific answer, not a
      // confusing 401 from a route the call should never have reached.
      if (mintResult.statusCode >= 400) return mintResult;
      credential = mintedToken(mintResult.body);
      break;
    }
    case "golfer":
    case "none":
    case "round-read":
      // The caller's own credential rides straight through as-is. Review round 1 (task 12)
      // corrected this comment: three tools ARE "none"-tier today — get_course, search_courses,
      // peek_round (routes.ts: "reads are identity-free — a course card is public data anyone
      // may fetch," "search is identity-free too," and peek_round has no participant yet to hold
      // a token) — so "the caller's own credential" is sent even though the route itself needs
      // none; the dispatcher's own auth layer (dispatch.ts) is what actually ignores it for a
      // "none" route. No live TOOL_TABLE entry is "round-read" tier (every remaining tool is
      // "golfer" or "participant"). Each tier is still named explicitly here rather than folded
      // into a catch-all default so that adding one is a considered choice made at this call
      // site, not a silent no-op.
      break;
    case undefined:
      // No route in deps.routes names this tool's method+path at all. Nothing to authorize —
      // let deps.dispatch's own 404 surface the problem rather than guessing a credential.
      break;
    default: {
      // Exhaustiveness check: a new Route["auth"] value that reaches here without an explicit
      // case above is a COMPILE-TIME type error, not a silent runtime 401.
      const unhandledTier: never = tier;
      throw new Error(`dispatchTool: unhandled auth tier ${String(unhandledTier)}`);
    }
  }

  return deps.dispatch(buildRequest(tool, args, credential));
};
