import { describe, expect, it } from "vitest";
import { buildRoutes } from "../http/routes.js";
import type { UseCases } from "../http/routes.js";
import { TOOL_TABLE } from "./toolTable.js";

// buildRoutes only needs a UseCases-shaped value to read the route TABLE off — none of its
// methods are ever called by these tests, so a Proxy that hands back a no-op async function for
// any property access is a faithful, zero-maintenance stand-in for the real (40-method)
// interface.
const stubUseCases = new Proxy(
  {},
  {
    get: () => async () => undefined,
  },
) as UseCases;

describe("TOOL_TABLE", () => {
  it("covers all 23 tools", () => {
    expect(TOOL_TABLE).toHaveLength(23);
  });

  it("is sorted by name, so tools/list is deterministic", () => {
    const names = TOOL_TABLE.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it("declares every path param its template names", () => {
    for (const t of TOOL_TABLE) {
      const named = [...t.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect([...t.pathParams].sort(), t.name).toEqual([...named].sort());
    }
  });

  it("names every path and query param in its input schema", () => {
    for (const t of TOOL_TABLE) {
      const shapeKeys = new Set(Object.keys(t.inputSchema.shape));
      for (const p of [...t.pathParams, ...(t.queryParams ?? [])]) {
        expect(shapeKeys.has(p), `${t.name} is missing "${p}" in its inputSchema`).toBe(true);
      }
    }
  });

  it("sends nothing in a GET body", () => {
    // A GET body is dropped on the wire, so an unrouted argument vanishes silently — the failure
    // that made search_courses 400 in an earlier draft.
    for (const t of TOOL_TABLE.filter((t) => t.method === "GET")) {
      const routed = new Set([...t.pathParams, ...(t.queryParams ?? [])]);
      expect(
        Object.keys(t.inputSchema.shape).filter((k) => !routed.has(k)),
        t.name,
      ).toEqual([]);
    }
  });

  it("every tool names a live route", () => {
    const keys = new Set(buildRoutes(stubUseCases).map((r) => `${r.method} ${r.path}`));
    expect(TOOL_TABLE.filter((t) => !keys.has(`${t.method} ${t.path}`)).map((t) => t.name)).toEqual([]);
  });

  it("declares the record_score carve-out, and it alone", () => {
    const authored = TOOL_TABLE.filter((t) => t.authored !== undefined).map((t) => t.name);
    expect(authored).toEqual(["record_score"]);
    const recordScore = TOOL_TABLE.find((t) => t.name === "record_score")!;
    expect(recordScore.authored).toEqual(["opId", "hlc"]);
    expect(Object.keys(recordScore.inputSchema.shape)).not.toContain("opId");
    expect(Object.keys(recordScore.inputSchema.shape)).not.toContain("hlc");
  });

  it("matches the brief's read/write split", () => {
    const reads = TOOL_TABLE.filter((t) => t.scope === "read")
      .map((t) => t.name)
      .sort();
    const writes = TOOL_TABLE.filter((t) => t.scope === "write")
      .map((t) => t.name)
      .sort();
    expect(reads).toEqual(
      [
        "crew_season_standings",
        "get_course",
        "get_crew",
        "get_round",
        "list_live_rounds",
        "list_my_crews",
        "list_my_rounds",
        "my_course_record",
        "peek_round",
        "search_courses",
        "whoami",
      ].sort(),
    );
    expect(writes).toEqual(
      [
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
      ].sort(),
    );
  });
});
