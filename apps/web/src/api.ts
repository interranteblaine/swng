import {
  abandonRoundResponseSchema,
  addGameResponseSchema,
  appendCountedRoundResponseSchema,
  createCourseResponseSchema,
  createCrewResponseSchema,
  createSeasonResponseSchema,
  errorResponseSchema,
  finalizeRoundResponseSchema,
  getCourseResponseSchema,
  getCrewResponseSchema,
  getMeResponseSchema,
  getMyLiveRoundsResponseSchema,
  getMyRecordResponseSchema,
  getMyRoundsResponseSchema,
  getRoundArchiveResponseSchema,
  golferResponseSchema,
  joinCrewResponseSchema,
  joinRoundResponseSchema,
  leaveCrewResponseSchema,
  leaveRoundResponseSchema,
  listMyCrewsResponseSchema,
  listSeasonsResponseSchema,
  mintCrewInviteResponseSchema,
  parse,
  peekCrewInviteResponseSchema,
  peekRoundResponseSchema,
  removeCountedRoundResponseSchema,
  searchCoursesResponseSchema,
  seasonStandingsResponseSchema,
  shareLinkResponseSchema,
  startRoundResponseSchema,
  supersedeCardResponseSchema,
  terminateGameResponseSchema,
} from "@swng/contracts";
import type {
  AbandonRoundResponse,
  AddGameRequest,
  AddGameResponse,
  AppendCountedRoundRequest,
  AppendCountedRoundResponse,
  CreateCourseRequest,
  CreateCourseResponse,
  CreateCrewRequest,
  CreateCrewResponse,
  CreateSeasonRequest,
  CreateSeasonResponse,
  FinalizeRoundResponse,
  GetCourseResponse,
  GetCrewResponse,
  GetMeResponse,
  GetMyLiveRoundsResponse,
  GetMyRecordResponse,
  GetMyRoundsResponse,
  GetRoundArchiveResponse,
  GolferResponse,
  JoinCrewRequest,
  JoinCrewResponse,
  JoinRoundRequest,
  JoinRoundResponse,
  LeaveCrewResponse,
  LeaveRoundResponse,
  ListMyCrewsResponse,
  ListSeasonsResponse,
  MintCrewInviteResponse,
  PeekCrewInviteRequest,
  PeekCrewInviteResponse,
  PeekRoundResponse,
  RemoveCountedRoundResponse,
  SearchCoursesResponse,
  SeasonStandingsResponse,
  ShareLinkResponse,
  StartRoundRequest,
  StartRoundResponse,
  SupersedeCardRequest,
  SupersedeCardResponse,
  TerminateGameResponse,
  TransferOrganizerRequest,
  UpdateMeRequest,
} from "@swng/contracts";
import type { CourseId, CrewId, GameId, GolferId, RoundId } from "@swng/domain";
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

// Accounts-only identity (spec §3): both routes are "golfer"-gated on the wire — the caller is
// always a signed-in account playing as themselves (the server resolves the seat from the Bearer;
// the request carries no name/golferId). `token` stays typed optional here only so the ApiError
// path stays uniform, but a real call always passes one from a valid auth session (via useAuth's
// withAuth, which owns the refresh-then-signout policy) — an absent/invalid token 401s server-side.
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

export const finalizeRound = async (roundId: RoundId, token: string): Promise<FinalizeRoundResponse> => {
  const json = await requestJson(`/rounds/${roundId}/finalize`, { method: "POST", token });
  return parse(finalizeRoundResponseSchema, json);
};

// POST /rounds/{roundId}/abandon (task-15): scraps the round — a terminal event that produces NO
// snapshot, so the round counts nowhere. "participant"-gated, same token as finalize above;
// idempotent (abandoning an already-abandoned round succeeds).
export const abandonRound = async (roundId: RoundId, token: string): Promise<AbandonRoundResponse> => {
  const json = await requestJson(`/rounds/${roundId}/abandon`, { method: "POST", token });
  return parse(abandonRoundResponseSchema, json);
};

// POST /rounds/{roundId}/leave (accounts-only identity spec §4): the caller walks off the round —
// "participant"-gated, the SAME round-scoped token finalize/abandon/terminate attach, no request
// body (the leaver is the token's OWN golferId, by construction). Appends a participant-left event
// and returns exactly what it appended (LeaveRoundResponse.events), same append idiom as
// terminateGame; leaving twice appends twice (never deduped), so a repeat leave still returns a
// fresh event.
export const leaveRound = async (roundId: RoundId, token: string): Promise<LeaveRoundResponse> => {
  const json = await requestJson(`/rounds/${roundId}/leave`, { method: "POST", token });
  return parse(leaveRoundResponseSchema, json);
};

// M9 Task 3 (share): mints this round's own immortal spectator link. `url` is a path+fragment
// (the server has no web-origin config seam — getShareLink.ts's own doc comment) — ShareButton
// resolves it against this device's own window.location.origin before copying/displaying it.
export const shareRound = async (roundId: RoundId, token: string): Promise<ShareLinkResponse> => {
  const json = await requestJson(`/rounds/${roundId}/share`, { method: "POST", token });
  return parse(shareLinkResponseSchema, json);
};

// Course-cards spec §4: the course surface. The two READS (GET) are `auth: "none"` and pass
// no token; the two WRITES (POST /courses, PUT /courses/{courseId}) are "golfer"-gated —
// enteredBy derives from the account — so they take a Bearer, the same createRound/joinRound
// idiom above (a real call passes one from a valid auth session via useAuth's withAuth).
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

export const createCourse = async (input: CreateCourseRequest, token: string): Promise<CreateCourseResponse> => {
  const json = await requestJson("/courses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(createCourseResponseSchema, json);
};

// PUT /courses/{courseId} (course-cards spec §4): THE maintenance operation — add a tee, fix
// numbers, rename the course or a tee, all one whole-card supersession under the same lineage id.
export const supersedeCard = async (courseId: CourseId, input: SupersedeCardRequest, token: string): Promise<SupersedeCardResponse> => {
  const json = await requestJson(`/courses/${courseId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(supersedeCardResponseSchema, json);
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

export const getMyRecord = async (token: string): Promise<GetMyRecordResponse> => {
  const json = await requestJson("/me/record", { token });
  return parse(getMyRecordResponseSchema, json);
};

// Projection-realignment Task 6: "list my rounds" — same requestJson + per-endpoint idiom as
// getMyRecord above, "golfer"-gated the same way.
export const getMyRounds = async (token: string): Promise<GetMyRoundsResponse> => {
  const json = await requestJson("/me/rounds", { token });
  return parse(getMyRoundsResponseSchema, json);
};

// Projection-realignment Task 13: "your rounds, right now" — presence, not finalized history
// (getMyRounds above). Same requestJson + per-endpoint idiom, "golfer"-gated the same way.
// HomePage's signed-in "Your rounds" section reads this instead of the device credentialStore
// list.
export const getMyLiveRounds = async (token: string): Promise<GetMyLiveRoundsResponse> => {
  const json = await requestJson("/me/rounds/live", { token });
  return parse(getMyLiveRoundsResponseSchema, json);
};

// Projection-realignment Task 6: opens one finalized round's own event log — "golfer"-gated
// (a signed-in account's Bearer, never a round-scoped participant/spectator token; the archive
// outlives any one device's credential). ArchivedRoundPage folds the result via the domain
// `reduceRound`, mirroring WatchPage's own composition.
export const getRoundArchive = async (token: string, id: RoundId): Promise<GetRoundArchiveResponse> => {
  const json = await requestJson(`/rounds/${id}/archive`, { token });
  return parse(getRoundArchiveResponseSchema, json);
};

// Architecture-realignment Task 14: the participant-token re-mint — "golfer"-gated (a
// signed-in account's Bearer), no request body. HomePage calls this for a live round the
// caller's identity shows (GET /me/rounds/live) but this device holds no local scoring
// credential for (started/joined elsewhere) — the response is the SAME wire shape joinRound's
// own token mint returns, so it's parsed with the SAME schema rather than a parallel one.
export const mintParticipantToken = async (token: string, id: RoundId): Promise<JoinRoundResponse> => {
  const json = await requestJson(`/rounds/${id}/token`, { method: "POST", token });
  return parse(joinRoundResponseSchema, json);
};

export const terminateGame = async (roundId: RoundId, token: string, gameId: GameId): Promise<TerminateGameResponse> => {
  const json = await requestJson(`/rounds/${roundId}/games/${gameId}/terminate`, { method: "POST", token });
  return parse(terminateGameResponseSchema, json);
};

// GET /crews/{crewId} (M8 Task 5): "golfer"-gated, member-only (a non-member 403s "not-a-member",
// application-side). CrewPage is the sole caller — a failed fetch (non-member, signed-out device,
// network) is a nicety it degrades silently from, never a gate (JoinRoundPage's peek-fallback precedent).
export const getCrew = async (token: string, id: CrewId): Promise<GetCrewResponse> => {
  const json = await requestJson(`/crews/${id}`, { token });
  return parse(getCrewResponseSchema, json);
};

// M8 Task 6: the crew home surface — the remaining crew routes, same requestJson + per-endpoint
// idiom as every call above. Every one is "golfer"-gated (a Bearer token is never optional here,
// unlike createRound/joinRound's anonymous path).
export const createCrew = async (token: string, input: CreateCrewRequest): Promise<CreateCrewResponse> => {
  const json = await requestJson("/crews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(createCrewResponseSchema, json);
};

// Crew membership (invited in, accountable out — spec §2/§3): joins the CALLER's own account
// golfer off an expiring invite token — replaces the deleted permanent join-code path outright.
// `input.token` is the invite token (from the link's own URL fragment, CrewJoinPage), never
// confused with this function's own bearer `token` param — same two-tokens-in-one-call shape
// mintCrewInvite's response/consumption split already has on the wire.
export const joinCrewByInvite = async (token: string, input: JoinCrewRequest): Promise<JoinCrewResponse> => {
  const json = await requestJson("/crews/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(joinCrewResponseSchema, json);
};

export const listMyCrews = async (token: string): Promise<ListMyCrewsResponse> => {
  const json = await requestJson("/me/crews", { token });
  return parse(listMyCrewsResponseSchema, json);
};

// Crew membership (invited in, accountable out — spec §2): mints a fresh 7-day invite link —
// ANY member may call this (mirrors mintCrewInvite.ts's own "any member invites" doc comment).
// CrewPage composes `${location.origin}/crews/join#${token}` from the response, ShareButton's
// exact idiom for the round-share link.
export const mintCrewInvite = async (token: string, id: CrewId): Promise<MintCrewInviteResponse> => {
  const json = await requestJson(`/crews/${id}/invites`, { method: "POST", token });
  return parse(mintCrewInviteResponseSchema, json);
};

// Crew membership (invited in, accountable out — spec §2): the capability-scoped preview a
// would-be joiner sees BEFORE signing in — auth "none" (never a bearer token), same "none"-auth
// shape as peekRound above. CrewJoinPage's consent card is built from this alone.
export const peekCrewInvite = async (input: PeekCrewInviteRequest): Promise<PeekCrewInviteResponse> => {
  const json = await requestJson("/crews/peek", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return parse(peekCrewInviteResponseSchema, json);
};

// Crew membership (invited in, accountable out — spec §1): the organizer's authority. No request
// schema — the target golferId rides the path (removeCrewMember.ts's own doc comment) — and both
// return the crew's own updated GetCrewResponse, the same shape createCrew/getCrew/joinCrewByInvite
// already return.
export const removeCrewMember = async (token: string, id: CrewId, targetGolferId: GolferId): Promise<GetCrewResponse> => {
  const json = await requestJson(`/crews/${id}/members/${targetGolferId}`, { method: "DELETE", token });
  return parse(getCrewResponseSchema, json);
};

export const transferOrganizer = async (token: string, id: CrewId, input: TransferOrganizerRequest): Promise<GetCrewResponse> => {
  const json = await requestJson(`/crews/${id}/transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(getCrewResponseSchema, json);
};

// Architecture-realignment Task 11: crew seasons + counted rounds + standings-on-read + leave —
// the six routes Task 9 (application/contracts/lambda) wired but no web caller yet used. Same
// requestJson + per-endpoint idiom as every crew call above; every one is "golfer"-gated.
// `seasonId` rides as a bare string in the URL (never branded — same wire contract as the path
// param itself, routes.ts's own doc comment).
export const createSeason = async (token: string, id: CrewId, input: CreateSeasonRequest): Promise<CreateSeasonResponse> => {
  const json = await requestJson(`/crews/${id}/seasons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), token });
  return parse(createSeasonResponseSchema, json);
};

export const listSeasons = async (token: string, id: CrewId): Promise<ListSeasonsResponse> => {
  const json = await requestJson(`/crews/${id}/seasons`, { token });
  return parse(listSeasonsResponseSchema, json);
};

export const appendCountedRound = async (token: string, id: CrewId, seasonId: string, input: AppendCountedRoundRequest): Promise<AppendCountedRoundResponse> => {
  const json = await requestJson(`/crews/${id}/seasons/${seasonId}/rounds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    token,
  });
  return parse(appendCountedRoundResponseSchema, json);
};

export const removeCountedRound = async (token: string, id: CrewId, seasonId: string, roundId: RoundId): Promise<RemoveCountedRoundResponse> => {
  const json = await requestJson(`/crews/${id}/seasons/${seasonId}/rounds/${roundId}`, { method: "DELETE", token });
  return parse(removeCountedRoundResponseSchema, json);
};

export const getSeasonStandings = async (token: string, id: CrewId, seasonId: string): Promise<SeasonStandingsResponse> => {
  const json = await requestJson(`/crews/${id}/seasons/${seasonId}/standings`, { token });
  return parse(seasonStandingsResponseSchema, json);
};

export const leaveCrew = async (token: string, id: CrewId): Promise<LeaveCrewResponse> => {
  const json = await requestJson(`/crews/${id}/leave`, { method: "POST", token });
  return parse(leaveCrewResponseSchema, json);
};
