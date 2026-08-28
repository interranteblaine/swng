import { z } from "zod";
import {
  addGameRequestSchema,
  courseIdSchema,
  crewIdSchema,
  gameIdSchema,
  joinRoundRequestSchema,
  recordScoreRequestSchema,
  roundIdSchema,
  setHolesRequestSchema,
  setPlayedAtRequestSchema,
  setStrokesRequestSchema,
  startRoundRequestSchema,
} from "@swng/contracts";

// The declared shape of one MCP tool. Composed almost entirely from `@swng/contracts` and read
// off `routes.ts` — this file is deliberately thin: it restates no golf rule, no enum, no id
// shape (spec §5, §5.2). `path`/`pathParams`/`queryParams` mirror the ROUTE this tool dispatches
// to, one to one, so `dispatchTool` (task 11) never has to re-derive the wire shape from the
// tool name.
export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly scope: "read" | "write";
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string; // the routes.ts template, e.g. "/rounds/{roundId}/games"
  readonly pathParams: readonly string[];
  readonly queryParams?: readonly string[];
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  // Fields the TRANSPORT authors, never the model — subtracted from `inputSchema` (via
  // `.omit(...)`) and filled in by the dispatcher. The one live case is `record_score`:
  // `recordScoreRequestSchema` requires `opId` and `hlc` (the last-writer-wins key
  // `reduceRound`/`compareHlc` order scores by), and asking a model to author a hybrid logical
  // clock risks a fabricated `wallMs` silently beating or losing to a real score off a phone.
  // The MCP layer *is* a client, so it mints these exactly as the browser session does
  // (`createHlcSource`, `@swng/domain`). Declared per tool, not inferred, so a new
  // caller-authored field on a request schema has to surface here.
  readonly authored?: readonly ("opId" | "hlc")[];
}

// GET routes with no query and no body — /me, /me/rounds, /me/rounds/live, /me/crews — parse
// nothing, so their schema is the empty object, not paging or filters that do nothing.
const emptySchema = z.object({});

export const TOOL_TABLE: readonly ToolDefinition[] = [
  {
    name: "abandon_round",
    title: "Abandon round",
    description:
      "Scrap the round. Terminal and irreversible; the round produces no archive and counts nowhere — every participant loses it permanently.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/abandon",
    pathParams: ["roundId"],
    inputSchema: z.object({ roundId: roundIdSchema }),
  },
  {
    name: "add_game",
    title: "Add game",
    description: "Add a game (stroke play, match play, stableford, skins, or fourball match) to a round.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/games",
    pathParams: ["roundId"],
    inputSchema: addGameRequestSchema.extend({ roundId: roundIdSchema }),
  },
  {
    name: "crew_season_standings",
    title: "Crew season standings",
    description: "Get a crew season's standings.",
    scope: "read",
    method: "GET",
    path: "/crews/{crewId}/seasons/{seasonId}/standings",
    pathParams: ["crewId", "seasonId"],
    // seasonId is never branded (routes.ts's own comment: "an opaque string — never branded,
    // never parsed"), matching crewSeasonViewSchema's own `seasonId: z.string()` field — no bound
    // invented here that the contract doesn't already carry.
    inputSchema: z.object({ crewId: crewIdSchema, seasonId: z.string() }),
  },
  {
    name: "finalize_round",
    title: "Finalize round",
    description: "Settle the round and produce its final results. Acts on a live round only — a finalized round can't be finalized again.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/finalize",
    pathParams: ["roundId"],
    inputSchema: z.object({ roundId: roundIdSchema }),
  },
  {
    name: "get_course",
    title: "Get course",
    description: "Get a course card by id.",
    scope: "read",
    method: "GET",
    path: "/courses/{courseId}",
    pathParams: ["courseId"],
    inputSchema: z.object({ courseId: courseIdSchema }),
  },
  {
    name: "get_crew",
    title: "Get crew",
    description: "Get a crew by id.",
    scope: "read",
    method: "GET",
    path: "/crews/{crewId}",
    pathParams: ["crewId"],
    inputSchema: z.object({ crewId: crewIdSchema }),
  },
  {
    name: "get_round",
    title: "Get round",
    description: "Get a round's folded card, participants, games and results — from the live journal for a round in progress, from the snapshot once it's finalized.",
    scope: "read",
    method: "GET",
    path: "/rounds/{roundId}/view",
    pathParams: ["roundId"],
    inputSchema: z.object({ roundId: roundIdSchema }),
  },
  {
    name: "join_round",
    title: "Join round",
    description: "Join a round by its join code, choosing a tee.",
    scope: "write",
    method: "POST",
    path: "/rounds/join",
    pathParams: [],
    inputSchema: joinRoundRequestSchema,
  },
  {
    name: "leave_round",
    title: "Leave round",
    description: "Leave a round you're a participant in.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/leave",
    pathParams: ["roundId"],
    inputSchema: z.object({ roundId: roundIdSchema }),
  },
  {
    name: "list_live_rounds",
    title: "List live rounds",
    description: "List the caller's rounds currently in progress.",
    scope: "read",
    method: "GET",
    path: "/me/rounds/live",
    pathParams: [],
    inputSchema: emptySchema,
  },
  {
    name: "list_my_crews",
    title: "List my crews",
    description: "List the crews the caller belongs to.",
    scope: "read",
    method: "GET",
    path: "/me/crews",
    pathParams: [],
    inputSchema: emptySchema,
  },
  {
    name: "list_my_rounds",
    title: "List my rounds",
    description: "List the caller's finalized round history.",
    scope: "read",
    method: "GET",
    path: "/me/rounds",
    pathParams: [],
    inputSchema: emptySchema,
  },
  {
    name: "my_course_record",
    title: "My course record",
    description: "Get the caller's personal record at a course.",
    scope: "read",
    method: "GET",
    path: "/me/courses/{courseId}/record",
    pathParams: ["courseId"],
    inputSchema: z.object({ courseId: courseIdSchema }),
  },
  {
    name: "peek_round",
    title: "Peek round",
    description: "Preview a round by its join code before joining — course, tees, and played date only.",
    scope: "read",
    method: "GET",
    path: "/rounds/peek",
    pathParams: [],
    queryParams: ["code"],
    // parseJoinCode (routes.ts) rejects empty/blank at dispatch time; no bound invented here —
    // required-ness alone (no `.optional()`) is this schema's job.
    inputSchema: z.object({ code: z.string() }),
  },
  {
    name: "record_score",
    title: "Record score",
    description: "Record a hole's result for a golfer in a round — strokes, picked-up, or cleared.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/scores",
    pathParams: ["roundId"],
    inputSchema: recordScoreRequestSchema.omit({ opId: true, hlc: true }).extend({ roundId: roundIdSchema }),
    authored: ["opId", "hlc"],
  },
  {
    name: "search_courses",
    title: "Search courses",
    description: "Search course cards by name.",
    scope: "read",
    method: "GET",
    path: "/courses",
    pathParams: [],
    queryParams: ["query", "limit"],
    // parseSearchQuery rejects empty/blank and parseLimit rejects a non-integer at dispatch time
    // (routes.ts) — no bound invented here beyond `limit`'s integer type, which mirrors what
    // parseOptionalInt actually enforces rather than adding a new ceiling.
    inputSchema: z.object({ query: z.string(), limit: z.number().int().optional() }),
  },
  {
    name: "set_participant_strokes",
    title: "Set participant strokes",
    description: "Set a participant's strokes for the round.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/strokes",
    pathParams: ["roundId"],
    inputSchema: setStrokesRequestSchema.extend({ roundId: roundIdSchema }),
  },
  {
    name: "set_round_holes",
    title: "Set round holes",
    description: "Correct which holes the round set out to play — all, front, or back nine.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/holes",
    pathParams: ["roundId"],
    inputSchema: setHolesRequestSchema.extend({ roundId: roundIdSchema }),
  },
  {
    name: "set_round_played_at",
    title: "Set round played-at",
    description: "Correct the date the round was played.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/played-at",
    pathParams: ["roundId"],
    inputSchema: setPlayedAtRequestSchema.extend({ roundId: roundIdSchema }),
  },
  {
    name: "share_round",
    title: "Share round",
    description:
      "Mint a public spectator link for the round. Mints a permanent public link anyone can watch with — acts on a live round only, since the mint refuses a finalized one.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/share",
    pathParams: ["roundId"],
    inputSchema: z.object({ roundId: roundIdSchema }),
  },
  {
    name: "start_round",
    title: "Start round",
    description: "Start a new round at a course, choosing a tee.",
    scope: "write",
    method: "POST",
    path: "/rounds",
    pathParams: [],
    inputSchema: startRoundRequestSchema,
  },
  {
    name: "terminate_game",
    title: "Terminate game",
    description: "End a game in a round before the round itself finalizes.",
    scope: "write",
    method: "POST",
    path: "/rounds/{roundId}/games/{gameId}/terminate",
    pathParams: ["roundId", "gameId"],
    inputSchema: z.object({ roundId: roundIdSchema, gameId: gameIdSchema }),
  },
  {
    name: "whoami",
    title: "Whoami",
    description: "Get the caller's own golfer profile.",
    scope: "read",
    method: "GET",
    path: "/me",
    pathParams: [],
    inputSchema: emptySchema,
  },
];
