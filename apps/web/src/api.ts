import {
  addGameResponseSchema,
  addParticipantResponseSchema,
  addTeeSetResponseSchema,
  createCourseResponseSchema,
  errorResponseSchema,
  finalizeRoundResponseSchema,
  getCourseResponseSchema,
  getCrewResponseSchema,
  getMeResponseSchema,
  getMyRecordResponseSchema,
  golferResponseSchema,
  joinRoundResponseSchema,
  parse,
  peekRoundResponseSchema,
  searchCoursesResponseSchema,
  startRoundResponseSchema,
  terminateGameResponseSchema,
  verifyTeeSetResponseSchema,
} from "@swng/contracts";
import type {
  AddGameRequest,
  AddGameResponse,
  AddParticipantRequest,
  AddParticipantResponse,
  AddTeeSetRequest,
  AddTeeSetResponse,
  ClaimGolferRequest,
  CreateCourseRequest,
  CreateCourseResponse,
  FinalizeRoundResponse,
  GetCourseResponse,
  GetCrewResponse,
  GetMeResponse,
  GetMyRecordResponse,
  GolferResponse,
  JoinRoundRequest,
  JoinRoundResponse,
  PeekRoundResponse,
  SearchCoursesResponse,
  StartRoundRequest,
  StartRoundResponse,
  TerminateGameResponse,
  UpdateMeRequest,
  VerifyTeeSetRequest,
  VerifyTeeSetResponse,
} from "@swng/contracts";
import type { CourseId, CrewId, GameId, RoundId } from "@swng/domain";
import { config } from "./config";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

// The four non-session commands share this: build the URL off config.httpUrl, attach the
// bearer token when one's given, and map a rejected fetch or a non-2xx response onto one
// ApiError shape — mirrors @swng/client's transport.ts requestJson (score/pull go through
// the session instead, never through here). A non-2xx body is parsed best-effort against
// errorResponseSchema: API Gateway's own edge errors (timeouts, throttles) are HTML/plain
// text, never JSON, so a SyntaxError there must not escape as some other error shape.
const requestJson = async (path: string, init: (RequestInit & { token?: string }) | undefined): Promise<unknown> => {
  // `token` is this function's own bespoke property, not part of RequestInit — it must be
  // destructured out and never spread into the real fetch() call below (fetch would just
  // ignore an unknown property, but silently leaking a bearer token into a generic init object
  // is the kind of thing that bites later, e.g. if `rest` is ever logged or forwarded).
  const { token, ...rest } = init ?? {};
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${config.httpUrl}${path}`, { ...rest, headers });
  } catch {
    throw new ApiError("network", undefined, "network error");
  }

  if (!response.ok) {
    let code = `http-${response.status}`;
    let message = `request failed with status ${response.status}`;
    try {
      const errorBody = errorResponseSchema.safeParse(await response.json());
      if (errorBody.success) {
        code = errorBody.data.code;
        message = errorBody.data.message;
      }
    } catch {
      // non-JSON error body (API Gateway's own edge page): fall back to the status-derived
      // code/message above.
    }
    throw new ApiError(code, response.status, message);
  }

  return response.json();
};

// `token` is optional (M8 Task 5): both routes are "optional-golfer" on the wire — an anonymous
// call behaves byte-identically to before (no token, no golferId in the body), while a signed-in
// "play as yourself" call attaches the caller's own Bearer alongside a `golferId` already present
// in `input`. A route that's "optional-golfer" still 401s a PRESENT-but-invalid token
// (dispatch.ts), so callers must only pass a token from an actually-valid auth session (e.g. via
// useAuth's withAuth, which owns the refresh-then-signout policy) — never a stale/expired one.
export const createRound = async (input: StartRoundRequest, token?: string): Promise<StartRoundResponse> => {
  const json = await requestJson("/rounds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(startRoundResponseSchema, json);
};

export const joinRound = async (input: JoinRoundRequest, token?: string): Promise<JoinRoundResponse> => {
  const json = await requestJson("/rounds/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(joinRoundResponseSchema, json);
};

export const addGame = async (roundId: RoundId, token: string, game: AddGameRequest["game"]): Promise<AddGameResponse> => {
  const body: AddGameRequest = { game };
  const json = await requestJson(`/rounds/${roundId}/games`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), token });
  return parse(addGameResponseSchema, json);
};

// POST /rounds/{roundId}/players (M8 Task 5): "participant"-gated, same tier/token as
// addGame/recordScore/finalizeRound above — the crew one-tap quick-add and the free-text ghost
// form (SetupPanel's own "Add player") both go through this one call.
export const addParticipant = async (roundId: RoundId, token: string, input: AddParticipantRequest): Promise<AddParticipantResponse> => {
  const json = await requestJson(`/rounds/${roundId}/players`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(addParticipantResponseSchema, json);
};

export const finalizeRound = async (roundId: RoundId, token: string): Promise<FinalizeRoundResponse> => {
  const json = await requestJson(`/rounds/${roundId}/finalize`, { method: "POST", token });
  return parse(finalizeRoundResponseSchema, json);
};

// M6 Task 5: the six course-surface calls, same requestJson + per-endpoint idiom as the five
// round calls above — all `auth: "none"` on the wire (lambda/http/routes.ts's own M6 Task 4
// comment: identity lands in M7), so none of these ever pass a token.
export const getCourse = async (courseId: CourseId): Promise<GetCourseResponse> => {
  const json = await requestJson(`/courses/${courseId}`, undefined);
  return parse(getCourseResponseSchema, json);
};

// `query` rides the URL, so it's percent-encoded — unlike every other call here, whose body
// is JSON and needs no such escaping.
export const searchCourses = async (query: string, limit?: number): Promise<SearchCoursesResponse> => {
  const params = new URLSearchParams({ query });
  if (limit !== undefined) params.set("limit", String(limit));
  const json = await requestJson(`/courses?${params.toString()}`, undefined);
  return parse(searchCoursesResponseSchema, json);
};

export const createCourse = async (input: CreateCourseRequest): Promise<CreateCourseResponse> => {
  const json = await requestJson("/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return parse(createCourseResponseSchema, json);
};

export const addTeeSet = async (courseId: CourseId, input: AddTeeSetRequest): Promise<AddTeeSetResponse> => {
  const json = await requestJson(`/courses/${courseId}/tees`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return parse(addTeeSetResponseSchema, json);
};

export const verifyTeeSet = async (courseId: CourseId, input: VerifyTeeSetRequest): Promise<VerifyTeeSetResponse> => {
  const json = await requestJson(`/courses/${courseId}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return parse(verifyTeeSetResponseSchema, json);
};

// Same "missing/blank is the route layer's own 400, not an empty-string lookup" contract as
// searchCourses' `query` (lambda/http/routes.ts's parseJoinCode) — `code` rides the URL.
export const peekRound = async (code: string): Promise<PeekRoundResponse> => {
  const params = new URLSearchParams({ code });
  const json = await requestJson(`/rounds/peek?${params.toString()}`, undefined);
  return parse(peekRoundResponseSchema, json);
};

// M7 Task 6: the golfer identity surface ("golfer"-gated on the wire — a signed-in Cognito
// identity's bearer token, never a round-scoped participant token) + game termination
// ("participant"-gated, same token as addGame/finalizeRound). Same requestJson + per-endpoint
// idiom as every call above.
export const getMe = async (token: string): Promise<GetMeResponse> => {
  const json = await requestJson("/me", { token });
  return parse(getMeResponseSchema, json);
};

export const updateMe = async (token: string, input: UpdateMeRequest): Promise<GolferResponse> => {
  const json = await requestJson("/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(golferResponseSchema, json);
};

export const claimGolfer = async (token: string, input: ClaimGolferRequest): Promise<GolferResponse> => {
  const json = await requestJson("/golfers/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(golferResponseSchema, json);
};

export const getMyRecord = async (token: string): Promise<GetMyRecordResponse> => {
  const json = await requestJson("/me/record", { token });
  return parse(getMyRecordResponseSchema, json);
};

export const terminateGame = async (roundId: RoundId, token: string, gameId: GameId): Promise<TerminateGameResponse> => {
  const json = await requestJson(`/rounds/${roundId}/games/${gameId}/terminate`, { method: "POST", token });
  return parse(terminateGameResponseSchema, json);
};

// GET /crews/{crewId} (M8 Task 5): "golfer"-gated, member-only (a non-member 403s "not-a-member",
// application-side). SetupPanel's own "Add player" quick-add is the only caller in this
// milestone — a failed fetch (non-member, signed-out device, network) is a nicety it degrades
// silently from, never a gate (JoinRoundPage's peek-fallback precedent).
export const getCrew = async (token: string, id: CrewId): Promise<GetCrewResponse> => {
  const json = await requestJson(`/crews/${id}`, { token });
  return parse(getCrewResponseSchema, json);
};
