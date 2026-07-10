import type { z } from "zod";
import { courseId, gameId, roundId } from "@swng/domain";
import type { CourseId, GameId, RoundId } from "@swng/domain";
import type { AccountClaims, ParticipantClaims } from "@swng/application";
import type {
  AddGameRequest,
  AddGameResponse,
  AddTeeSetRequest,
  AddTeeSetResponse,
  ClaimGolferRequest,
  CreateCourseRequest,
  CreateCourseResponse,
  EventsResponse,
  FinalizeRoundResponse,
  GetCourseResponse,
  GetMeResponse,
  GetMyRecordResponse,
  GolferResponse,
  JoinRoundRequest,
  JoinRoundResponse,
  PeekRoundResponse,
  RecordScoreRequest,
  RecordScoreResponse,
  SearchCoursesResponse,
  StartRoundRequest,
  StartRoundResponse,
  TerminateGameResponse,
  UpdateMeRequest,
  VerifyTeeSetRequest,
  VerifyTeeSetResponse,
} from "@swng/contracts";
import {
  ContractError,
  addGameRequestSchema,
  addTeeSetRequestSchema,
  claimGolferRequestSchema,
  createCourseRequestSchema,
  joinRoundRequestSchema,
  recordScoreRequestSchema,
  startRoundRequestSchema,
  updateMeRequestSchema,
  verifyTeeSetRequestSchema,
} from "@swng/contracts";

// The deps-applied use-case functions from Task 2/M6 Task 2 (application/src/rounds/*.ts,
// application/src/courses/*.ts), one per route — the dispatcher is generic over this shape
// so it never imports application's use cases directly; compositionRoot.ts is the only place
// that builds one.
export interface UseCases {
  startRound: (command: StartRoundRequest) => Promise<StartRoundResponse>;
  joinRound: (command: JoinRoundRequest) => Promise<JoinRoundResponse>;
  addGame: (claims: ParticipantClaims, command: AddGameRequest) => Promise<AddGameResponse>;
  recordScore: (claims: ParticipantClaims, command: RecordScoreRequest) => Promise<RecordScoreResponse>;
  finalizeRound: (claims: ParticipantClaims) => Promise<FinalizeRoundResponse>;
  readEvents: (id: RoundId, sinceSeq: number) => Promise<EventsResponse>;
  peekRound: (code: string) => Promise<PeekRoundResponse>;
  createCourse: (command: CreateCourseRequest) => Promise<CreateCourseResponse>;
  addTeeSet: (id: CourseId, command: AddTeeSetRequest) => Promise<AddTeeSetResponse>;
  verifyTeeSet: (id: CourseId, command: VerifyTeeSetRequest) => Promise<VerifyTeeSetResponse>;
  getCourse: (id: CourseId) => Promise<GetCourseResponse>;
  searchCourses: (query: string, limit?: number) => Promise<SearchCoursesResponse>;
  // M7 Task 5: game/round termination + the golfer identity surface. terminateGame stays
  // "participant"-gated (matches finalize — game management is a connected, online round act,
  // not identity-scoped); the four /me* + /golfers/claim routes are "golfer"-gated, taking
  // AccountClaims the same way the participant routes above take ParticipantClaims.
  terminateGame: (claims: ParticipantClaims, targetGameId: GameId) => Promise<TerminateGameResponse>;
  getMyGolfer: (claims: AccountClaims) => Promise<GetMeResponse>;
  updateMyGolfer: (claims: AccountClaims, command: UpdateMeRequest) => Promise<GolferResponse>;
  claimGolfer: (claims: AccountClaims, command: ClaimGolferRequest) => Promise<GolferResponse>;
  getMyRecord: (claims: AccountClaims) => Promise<GetMyRecordResponse>;
}

// What a route handler sees once the dispatcher has matched the path, verified auth, and
// parsed the body. `query` is additive to the brief's sketch — GET /rounds/{id}/events is
// the one route whose command shape isn't a JSON body, so its `since` cursor rides here
// instead (the dispatcher always populates it, `{}` when the request carried no query string).
// `account` is the "golfer" auth tier's counterpart to `claims` (M7 Task 4): a route
// declaring `auth: "golfer"` gets a verified Cognito identity here instead of a
// round-scoped participant token — the two tiers are mutually exclusive per route (routes.ts,
// by construction: no route declares both), so a handler only ever reads the one its own
// route's `auth` promises.
export interface RouteContext {
  readonly claims?: ParticipantClaims;
  readonly account?: AccountClaims;
  readonly pathParams: Record<string, string>;
  readonly query: Record<string, string>;
}

export interface Route {
  // "PUT" only backs PUT /me (M7 Task 5) — every other route in this table is GET or POST.
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string; // template with `{name}` segments, e.g. "/rounds/{roundId}/games"
  readonly schema?: z.ZodType;
  // "participant" = a round-scoped token minted off a join code (no account required);
  // "golfer" = a signed-in Cognito identity (M7 Task 4) — verified by the dispatcher's
  // injected AccountVerifier, never by a route handler itself.
  readonly auth: "none" | "participant" | "golfer";
  // 201 for routes that mint a new resource (round/participant/game); 200 for actions
  // that read or that may be an idempotent no-op (score, finalize, events).
  readonly successStatus: 200 | 201;
  readonly handler: (ctx: RouteContext, body: unknown) => Promise<unknown>;
}

// `since` defaults to "read from the start" and otherwise must be an integer seq — a
// non-integer (e.g. "abc", or Number's own parse of it: NaN) must be rejected here, as a
// ContractError, rather than reach adapters-dynamodb's evtSk(NaN + 1). Non-integer since
// feeds evtSk(NaN) = "EVT#0000000NaN"; under lexicographic BETWEEN, this drops seq ≤ 999
// but still returns seq ≥ 1000, silently amputating the head of the log a client folds
// over — strictly worse than an empty page. Reject with 400 instead.
const parseSinceSeq = (raw: string | undefined): number => {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ContractError("invalid-request", [`since: must be an integer, got "${raw}"`]);
  }
  return parsed;
};

// GET /courses?query=&limit= (M6 Task 4): searchCourses.ts's own doc comment anticipates
// this exact rejection ("empty-after-trim queries are rejected at the route layer... before
// this ever runs") — a missing or blank `query` is a 400 here, never an empty-string search
// silently reaching the store.
const parseSearchQuery = (raw: string | undefined): string => {
  if (raw === undefined || raw.trim().length === 0) {
    throw new ContractError("invalid-request", [`query: must be a non-empty string, got ${JSON.stringify(raw)}`]);
  }
  return raw;
};

// `limit` is optional (searchCourses.ts defaults and clamps it) — only its SHAPE is this
// layer's job, same split as `since` above: reject a non-integer here rather than let
// searchCourses' Math.trunc silently coerce "abc" into NaN and clamp that into MIN_LIMIT.
const parseLimit = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ContractError("invalid-request", [`limit: must be an integer, got "${raw}"`]);
  }
  return parsed;
};

// GET /rounds/peek?code= — same "missing/blank is a 400, not an empty-string lookup" shape
// as parseSearchQuery above.
const parseJoinCode = (raw: string | undefined): string => {
  if (raw === undefined || raw.trim().length === 0) {
    throw new ContractError("invalid-request", [`code: must be a non-empty string, got ${JSON.stringify(raw)}`]);
  }
  return raw;
};

export const buildRoutes = (useCases: UseCases): readonly Route[] => [
  {
    method: "POST",
    path: "/rounds",
    schema: startRoundRequestSchema,
    auth: "none",
    successStatus: 201,
    handler: async (_ctx, body) => useCases.startRound(body as StartRoundRequest),
  },
  {
    method: "POST",
    path: "/rounds/join",
    schema: joinRoundRequestSchema,
    auth: "none",
    successStatus: 201,
    handler: async (_ctx, body) => useCases.joinRound(body as JoinRoundRequest),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/games",
    schema: addGameRequestSchema,
    auth: "participant",
    successStatus: 201,
    // The dispatcher only calls a "participant" route's handler once auth has produced
    // claims (http/dispatch.ts) — the assertion documents that invariant rather than
    // re-deriving it with a runtime check every route would otherwise repeat.
    handler: async (ctx, body) => useCases.addGame(ctx.claims!, body as AddGameRequest),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/scores",
    schema: recordScoreRequestSchema,
    auth: "participant",
    successStatus: 200,
    handler: async (ctx, body) => useCases.recordScore(ctx.claims!, body as RecordScoreRequest),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/finalize",
    auth: "participant",
    successStatus: 200,
    handler: async (ctx) => useCases.finalizeRound(ctx.claims!),
  },
  // GET /rounds/peek must be matched BEFORE any /rounds/{roundId}/... template below it —
  // the dispatcher (http/dispatch.ts) walks this array in order and returns the first match,
  // so a 2-segment "/rounds/peek" and a 3-segment "/rounds/{roundId}/events" can never
  // actually collide (matchPath rejects on segment-count mismatch before comparing
  // literals/params — see dispatch.test.ts's "peek never binds {roundId}=\"peek\"" pin), but
  // this route still lives ahead of every rounds/{roundId}/* template here so the table
  // itself reads unambiguous, not just "happens to be safe by segment count today."
  {
    method: "GET",
    path: "/rounds/peek",
    auth: "none", // M6 Task 4: identity lands in M7, rate-limiting/abuse in M9 — no participant exists to hold a token before joining.
    successStatus: 200,
    handler: async (ctx) => useCases.peekRound(parseJoinCode(ctx.query.code)),
  },
  {
    method: "GET",
    path: "/rounds/{roundId}/events",
    auth: "participant",
    successStatus: 200,
    // Every "participant" route's path template declares {roundId} (this table, by
    // construction), so the dispatcher's path match always populates it.
    handler: async (ctx) => useCases.readEvents(roundId(ctx.pathParams.roundId!), parseSinceSeq(ctx.query.since)),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/games/{gameId}/terminate",
    auth: "participant",
    successStatus: 200, // idempotent no-op on a repeat terminate (terminateGame.ts), same status-code spirit as finalize.
    handler: async (ctx) => useCases.terminateGame(ctx.claims!, gameId(ctx.pathParams.gameId!)),
  },
  {
    method: "POST",
    path: "/courses",
    schema: createCourseRequestSchema,
    auth: "none", // M6 Task 4: identity lands in M7, rate-limiting/abuse in M9 — courses are a shared, unauthenticated CRUD store in v1.
    successStatus: 201,
    handler: async (_ctx, body) => useCases.createCourse(body as CreateCourseRequest),
  },
  {
    method: "POST",
    path: "/courses/{courseId}/tees",
    schema: addTeeSetRequestSchema,
    auth: "none", // M6 Task 4: identity lands in M7, rate-limiting/abuse in M9 — courses are a shared, unauthenticated CRUD store in v1.
    successStatus: 201,
    handler: async (ctx, body) => useCases.addTeeSet(courseId(ctx.pathParams.courseId!), body as AddTeeSetRequest),
  },
  {
    method: "POST",
    path: "/courses/{courseId}/verify",
    schema: verifyTeeSetRequestSchema,
    auth: "none", // M6 Task 4: identity lands in M7, rate-limiting/abuse in M9 — courses are a shared, unauthenticated CRUD store in v1.
    successStatus: 200,
    handler: async (ctx, body) => useCases.verifyTeeSet(courseId(ctx.pathParams.courseId!), body as VerifyTeeSetRequest),
  },
  {
    method: "GET",
    path: "/courses/{courseId}",
    auth: "none", // M6 Task 4: identity lands in M7, rate-limiting/abuse in M9 — courses are a shared, unauthenticated CRUD store in v1.
    successStatus: 200,
    handler: async (ctx) => useCases.getCourse(courseId(ctx.pathParams.courseId!)),
  },
  {
    method: "GET",
    path: "/courses",
    auth: "none", // M6 Task 4: identity lands in M7, rate-limiting/abuse in M9 — courses are a shared, unauthenticated CRUD store in v1.
    successStatus: 200,
    handler: async (ctx) => useCases.searchCourses(parseSearchQuery(ctx.query.query), parseLimit(ctx.query.limit)),
  },
  // M7 Task 5: the golfer identity surface — every route below is "golfer"-gated (a signed-in
  // Cognito identity, never a round-scoped participant token). GET /me NEVER creates (the
  // plan's amendment, see getMyGolfer.ts's own doc comment); PUT /me is the one get-or-create
  // path.
  {
    method: "GET",
    path: "/me",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getMyGolfer(ctx.account!),
  },
  {
    method: "PUT",
    path: "/me",
    schema: updateMeRequestSchema,
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx, body) => useCases.updateMyGolfer(ctx.account!, body as UpdateMeRequest),
  },
  {
    method: "POST",
    path: "/golfers/claim",
    schema: claimGolferRequestSchema,
    auth: "golfer",
    successStatus: 200, // an act on an existing (ghost) resource, not minting a new one — matches finalize/terminate's 200, not a 201.
    handler: async (ctx, body) => useCases.claimGolfer(ctx.account!, body as ClaimGolferRequest),
  },
  {
    method: "GET",
    path: "/me/record",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getMyRecord(ctx.account!),
  },
];
