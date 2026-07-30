import type { z } from "zod";
import { courseId, crewId, gameId, golferId, roundId } from "@swng/domain";
import type { CourseId, CrewId, GameId, GolferId, RoundId } from "@swng/domain";
import type { AccountClaims, ParticipantClaims } from "@swng/application";
import type {
  AbandonRoundResponse,
  AddGameRequest,
  AddGameResponse,
  CreateCourseRequest,
  CreateCourseResponse,
  CreateCrewRequest,
  CreateCrewResponse,
  CreateSeasonRequest,
  CreateSeasonResponse,
  EventsResponse,
  FinalizeRoundResponse,
  GetCourseResponse,
  GetCrewResponse,
  GetGolferResponse,
  GetMeResponse,
  GetMyCourseRecordResponse,
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
  RecordScoreRequest,
  RecordScoreResponse,
  SearchCoursesResponse,
  SeasonStandingsResponse,
  SetStrokesRequest,
  SetStrokesResponse,
  ShareLinkResponse,
  StartRoundRequest,
  StartRoundResponse,
  SupersedeCardRequest,
  SupersedeCardResponse,
  TerminateGameResponse,
  TransferOrganizerRequest,
  UpdateCrewRequest,
  UpdateMeRequest,
  UpdateSeasonRequest,
} from "@swng/contracts";
import {
  ContractError,
  addGameRequestSchema,
  createCourseRequestSchema,
  createCrewRequestSchema,
  createSeasonRequestSchema,
  joinCrewRequestSchema,
  joinRoundRequestSchema,
  peekCrewInviteRequestSchema,
  recordScoreRequestSchema,
  setStrokesRequestSchema,
  startRoundRequestSchema,
  supersedeCardRequestSchema,
  transferOrganizerRequestSchema,
  updateCrewRequestSchema,
  updateMeRequestSchema,
  updateSeasonRequestSchema,
} from "@swng/contracts";

// The deps-applied use-case functions from Task 2/M6 Task 2 (application/src/rounds/*.ts,
// application/src/courses/*.ts), one per route — the dispatcher is generic over this shape
// so it never imports application's use cases directly; compositionRoot.ts is the only place
// that builds one.
export interface UseCases {
  // Accounts-only identity (spec §3): StartRound/JoinRound are the "golfer" auth tier now — every
  // person on a card is a signed-in account, so claims is REQUIRED (there is no anonymous start or
  // join). The seat is always the caller's own account golfer, resolved via ensureGolfer.
  startRound: (command: StartRoundRequest, claims: AccountClaims) => Promise<StartRoundResponse>;
  joinRound: (command: JoinRoundRequest, claims: AccountClaims) => Promise<JoinRoundResponse>;
  addGame: (claims: ParticipantClaims, command: AddGameRequest) => Promise<AddGameResponse>;
  recordScore: (claims: ParticipantClaims, command: RecordScoreRequest) => Promise<RecordScoreResponse>;
  finalizeRound: (claims: ParticipantClaims) => Promise<FinalizeRoundResponse>;
  // task-15: scrap a round — a terminal event that produces NO snapshot, so the round counts
  // nowhere. "participant"-gated, same tier as addGame/recordScore/finalizeRound above.
  abandonRound: (claims: ParticipantClaims) => Promise<AbandonRoundResponse>;
  // accounts-only identity spec §4: a participant walks off — appends participant-left for the
  // token's OWN golferId (self-only, no body). "participant"-gated, same tier as the acts above.
  leaveRound: (claims: ParticipantClaims) => Promise<LeaveRoundResponse>;
  // spec 2026-07-20 (re-shaped by 2026-07-29): mid-round correction of what a player stated about
  // themselves — any participant corrects any participant (score-for-anyone), the SUBJECT golferId
  // rides the body. "participant"-gated, same tier as the acts above.
  setStrokes: (claims: ParticipantClaims, request: SetStrokesRequest) => Promise<SetStrokesResponse>;
  readEvents: (id: RoundId, sinceSeq: number) => Promise<EventsResponse>;
  peekRound: (code: string) => Promise<PeekRoundResponse>;
  // M9 Task 3 (share): mints (deterministically) this round's own spectator link — participant-
  // gated, same claims shape addGame/recordScore/finalizeRound already take.
  getShareLink: (claims: ParticipantClaims) => Promise<ShareLinkResponse>;
  // Projection-realignment Task 6: the snapshot's own event log, "golfer"-gated (a signed-in
  // account, never a round-scoped participant token — the archive outlives any one device's
  // credential). Navigation spec §6b relaxed this to any signed-in golfer, not just a
  // participant/counting-crew-member — getRoundArchive.ts's own doc comment covers why.
  getRoundArchive: (claims: AccountClaims, id: RoundId) => Promise<GetRoundArchiveResponse>;
  // Architecture-realignment Task 14: the participant-token re-mint — "golfer"-gated (the SAME
  // signed-in account tier getRoundArchive above uses, not a round-scoped participant token,
  // since the whole point is minting one for a device that has none yet). Reuses
  // JoinRoundResponse verbatim (mintParticipantToken.ts's own doc comment: the two shapes are
  // byte-identical, and the brief prefers reuse over a parallel type).
  mintParticipantToken: (claims: AccountClaims, id: RoundId) => Promise<JoinRoundResponse>;
  // Course-cards spec §4: writes are "golfer"-gated and enteredBy derives from the account, so
  // createCourse/supersedeCard take AccountClaims; the two reads stay identity-free.
  createCourse: (claims: AccountClaims, command: CreateCourseRequest) => Promise<CreateCourseResponse>;
  supersedeCard: (claims: AccountClaims, id: CourseId, command: SupersedeCardRequest) => Promise<SupersedeCardResponse>;
  getCourse: (id: CourseId) => Promise<GetCourseResponse>;
  searchCourses: (query: string, limit?: number) => Promise<SearchCoursesResponse>;
  // M7 Task 5: game/round termination + the golfer identity surface. terminateGame stays
  // "participant"-gated (matches finalize — game management is a connected, online round act,
  // not identity-scoped); the /me* routes are "golfer"-gated, taking AccountClaims the same way
  // the participant routes above take ParticipantClaims.
  terminateGame: (claims: ParticipantClaims, targetGameId: GameId) => Promise<TerminateGameResponse>;
  getMyGolfer: (claims: AccountClaims) => Promise<GetMeResponse>;
  updateMyGolfer: (claims: AccountClaims, command: UpdateMeRequest) => Promise<GolferResponse>;
  getMyRecord: (claims: AccountClaims) => Promise<GetMyRecordResponse>;
  // Analytics spec 2026-07-21 §4: "your record here" — the SAME get-or-nothing shape as
  // getMyRecord above, filtered to one course. The target courseId rides the path.
  getMyCourseRecord: (claims: AccountClaims, id: CourseId) => Promise<GetMyCourseRecordResponse>;
  // Projection-realignment Task 6: "list my rounds" — same golfer-tier auth as getMyRecord.
  getMyRounds: (claims: AccountClaims) => Promise<GetMyRoundsResponse>;
  // Projection-realignment Task 13: "your rounds, right now" — presence pointers, not
  // finalized history (getMyRounds just above). Same golfer-tier auth.
  getMyLiveRounds: (claims: AccountClaims) => Promise<GetMyLiveRoundsResponse>;
  // Navigation spec §6a: GET /golfers/{golferId} — the golfer page's read. "golfer"-gated
  // (any signed-in caller), but NOT self-scoped like getMyRecord/getMyRounds/getMyLiveRounds
  // above — the target golferId rides the request, resolved from the path (routes.ts's own
  // path-param extraction below), so this takes no claims at all.
  getGolfer: (request: { golferId: GolferId }) => Promise<GetGolferResponse>;
  // M8 Task 4: crews — every route below is "golfer"-gated (routes.ts's table), EXCEPT
  // peekCrewInvite ("none" — the consent-screen preview a would-be joiner sees before signing
  // in). Crew membership (invited in, accountable out — spec §2/§3): mintCrewInvite/
  // peekCrewInvite/joinCrewByInvite replace addCrewMember/joinCrewByCode and the permanent join
  // code they rode — there is no add-by-id path left, and getting in is by expiring HMAC
  // invite link, minted by ANY member (not organizer-only — spec §1).
  createCrew: (claims: AccountClaims, command: CreateCrewRequest) => Promise<CreateCrewResponse>;
  getCrew: (claims: AccountClaims, id: CrewId) => Promise<GetCrewResponse>;
  listMyCrews: (claims: AccountClaims) => Promise<ListMyCrewsResponse>;
  mintCrewInvite: (claims: AccountClaims, id: CrewId) => Promise<MintCrewInviteResponse>;
  peekCrewInvite: (command: PeekCrewInviteRequest) => Promise<PeekCrewInviteResponse>;
  joinCrewByInvite: (claims: AccountClaims, command: JoinCrewRequest) => Promise<JoinCrewResponse>;
  // Architecture-realignment Task 9: crew seasons + standings-on-read, plus leave. Every one is
  // "golfer"-gated with member-only authorization inside application (crews/membership.ts).
  // `seasonId` rides in the path as an opaque string (a server-minted UUID — never branded,
  // never parsed), unlike roundId which keeps its brand.
  createSeason: (claims: AccountClaims, id: CrewId, command: CreateSeasonRequest) => Promise<CreateSeasonResponse>;
  listSeasons: (claims: AccountClaims, id: CrewId) => Promise<ListSeasonsResponse>;
  // Spec 2026-07-22 "the season is the record" §2: editing the end date IS the whole
  // lifecycle — updateSeason replaces the deleted close/reopen verbs outright. Same golfer
  // tier + seasonId-as-plain-string shape as createSeason/listSeasons; organizer-only
  // authorization lives in application (crews/membership.ts + updateSeason.ts's own guard),
  // never re-checked here.
  updateSeason: (claims: AccountClaims, id: CrewId, seasonId: string, command: UpdateSeasonRequest) => Promise<CreateSeasonResponse>;
  // The crew name is editable too (spec §2), organizer-only, no season lookup.
  updateCrew: (claims: AccountClaims, id: CrewId, command: UpdateCrewRequest) => Promise<GetCrewResponse>;
  getSeasonStandings: (claims: AccountClaims, id: CrewId, seasonId: string) => Promise<SeasonStandingsResponse>;
  leaveCrew: (claims: AccountClaims, id: CrewId) => Promise<LeaveCrewResponse>;
  // Crew membership (invited in, accountable out — spec §1): the organizer's authority.
  // Organizer-gated inside application (crews/membership.ts's requireCrewMember, then a role
  // check) — never re-checked here. Both mutate the roster and return the crew's own updated
  // view (GetCrewResponse), same "produces the crew" shape as createCrew/getCrew/
  // joinCrewByInvite, since the organizer stays authorized to see what they just changed.
  removeCrewMember: (claims: AccountClaims, id: CrewId, targetGolferId: GolferId) => Promise<GetCrewResponse>;
  transferOrganizer: (claims: AccountClaims, id: CrewId, command: TransferOrganizerRequest) => Promise<GetCrewResponse>;
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
  // "PUT" backs PUT /me (M7 Task 5); "DELETE" backs DELETE /crews/{crewId}/seasons/{seasonId}/
  // rounds/{roundId} (architecture-realignment Task 9, un-count a round) — every other route is
  // GET or POST.
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string; // template with `{name}` segments, e.g. "/rounds/{roundId}/games"
  readonly schema?: z.ZodType;
  // "participant" = a round-scoped token minted off a join code; "golfer" = a signed-in Cognito
  // identity (M7 Task 4), REQUIRED — no Bearer token 401s. Accounts-only identity (spec §3):
  // StartRound/JoinRound are "golfer" too now (there is no anonymous start or join — the third,
  // anonymous-tolerant tier that used to back them is gone). "golfer" is verified by the
  // dispatcher's injected AccountVerifier, never by a route handler itself. "round-read" (M9 Task 3, share): a
  // read-only route that accepts EITHER a participant OR a spectator token, both still
  // round-scoped (dispatch.ts's own token-round-mismatch check applies to both) — the tier a
  // share link's GET requests use.
  readonly auth: "none" | "participant" | "golfer" | "round-read";
  // 201 for routes that mint a new resource (round/participant/game); 200 for actions
  // that read or that may be an idempotent no-op (score, finalize, events).
  readonly successStatus: 200 | 201;
  readonly handler: (ctx: RouteContext, body: unknown) => Promise<unknown>;
}

// M9 hardening (papercut 2): the shared idiom behind parseSinceSeq/parseLimit/parseSeason
// below — an ABSENT query param (never sent) and an EMPTY one (a client-built URL with
// `?since=` — e.g. a template that stringifies an unset value as "") both mean "the caller
// supplied nothing," not an explicit "0". `Number("")` is 0 (a JS quirk, not NaN), so without
// this the empty-string form silently passed each parser's own integer check and coerced into
// a real value — wrong for all three call sites (parseSinceSeq: "" became 0, which happened to
// be harmless only because 0 is ALSO the absent-default; parseLimit: "" became 0, an invalid
// limit searchCourses was never meant to see; parseSeason: "" became 0, a nonsense year that
// bypassed the current-UTC-year default entirely). Fixed in this ONE place so all three parsers
// share the identical "absent-or-empty -> undefined" rule rather than three copies of it.
const parseOptionalInt = (raw: string | undefined, fieldName: string): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ContractError("invalid-request", [`${fieldName}: must be an integer, got "${raw}"`]);
  }
  return parsed;
};

// `since` defaults to "read from the start" and otherwise must be an integer seq — a
// non-integer (e.g. "abc", or Number's own parse of it: NaN) must be rejected here, as a
// ContractError, rather than reach adapters-dynamodb's evtSk(NaN + 1). Non-integer since
// feeds evtSk(NaN) = "EVT#0000000NaN"; under lexicographic BETWEEN, this drops seq ≤ 999
// but still returns seq ≥ 1000, silently amputating the head of the log a client folds
// over — strictly worse than an empty page. Reject with 400 instead.
const parseSinceSeq = (raw: string | undefined): number => parseOptionalInt(raw, "since") ?? 0;

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
const parseLimit = (raw: string | undefined): number | undefined => parseOptionalInt(raw, "limit");

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
    // Accounts-only identity (spec §3): "golfer"-gated — the creator seat is always the caller's
    // own account golfer (no anonymous start). The dispatcher guarantees ctx.account here.
    auth: "golfer",
    successStatus: 201,
    handler: async (ctx, body) => useCases.startRound(body as StartRoundRequest, ctx.account!),
  },
  {
    method: "POST",
    path: "/rounds/join",
    schema: joinRoundRequestSchema,
    auth: "golfer", // accounts-only identity spec §3: as-self only, same "golfer"-gated story as POST /rounds above.
    successStatus: 201,
    handler: async (ctx, body) => useCases.joinRound(body as JoinRoundRequest, ctx.account!),
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
  {
    method: "POST",
    path: "/rounds/{roundId}/abandon",
    auth: "participant", // task-15: any participant may scrap the round, same tier as finalize/terminate.
    successStatus: 200, // idempotent (abandoning an abandoned round is a no-op success) + an act on an existing round, not a mint — same 200 spirit as finalize/terminate.
    handler: async (ctx) => useCases.abandonRound(ctx.claims!),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/leave",
    auth: "participant", // accounts-only identity spec §4: the leaver is the token's own golferId — self-only by construction.
    successStatus: 200, // an act on an existing round (appends participant-left), not a mint — same 200 spirit as finalize/abandon.
    handler: async (ctx) => useCases.leaveRound(ctx.claims!),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/strokes",
    schema: setStrokesRequestSchema,
    auth: "participant", // spec 2026-07-30 §2: any participant sets any participant's strokes (score-for-anyone).
    successStatus: 200, // an act on an existing round (appends participant-strokes-set), not a mint — same 200 spirit as leave/finalize.
    handler: async (ctx, body) => useCases.setStrokes(ctx.claims!, body as SetStrokesRequest),
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
    // M9 Task 3 (share): the one read a spectator's share link needs — a participant OR
    // spectator token both authorize this route now (was "participant"-only pre-M9). Every
    // "round-read" route's path template declares {roundId} (this table, by construction), so
    // the dispatcher's path match always populates it.
    auth: "round-read",
    successStatus: 200,
    handler: async (ctx) => useCases.readEvents(roundId(ctx.pathParams.roundId!), parseSinceSeq(ctx.query.since)),
  },
  {
    method: "POST",
    path: "/rounds/{roundId}/share",
    // Minting a share link is itself participant-gated (a spectator can't mint a NEW link —
    // there's nothing more capable to escalate to anyway, but this keeps the surface simple:
    // only someone already in the round can hand out its read-only link).
    auth: "participant",
    successStatus: 200, // deterministic + idempotent (same round -> same link) — an act on an existing resource, not a mint, same status-code spirit as finalize/terminate.
    handler: async (ctx) => useCases.getShareLink(ctx.claims!),
  },
  // Projection-realignment Task 6: the settled snapshot's own event log — "golfer"-gated
  // (unlike GET /rounds/{roundId}/events' "round-read" tier, which trusts a round-scoped
  // token): an archive outlives any one device's participant/spectator credential, so this
  // route authorizes by the caller's ACCOUNT instead (getRoundArchive.ts's own participant/
  // stranger split).
  {
    method: "GET",
    path: "/rounds/{roundId}/archive",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getRoundArchive(ctx.account!, roundId(ctx.pathParams.roundId!)),
  },
  // Architecture-realignment Task 14: the participant-token re-mint. "golfer"-gated (same tier
  // as the archive route just above) — no request body, path param only, same shape as
  // POST /rounds/{roundId}/games/{gameId}/terminate below. 200, not 201: this re-issues
  // credentials for an ALREADY-existing participation, never mints a new participant or round
  // (same "act on an existing resource" status-code spirit as getShareLink/terminate above).
  {
    method: "POST",
    path: "/rounds/{roundId}/token",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.mintParticipantToken(ctx.account!, roundId(ctx.pathParams.roundId!)),
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
    // Course-cards spec §4: writes are "golfer"-gated; enteredBy derives from the account.
    auth: "golfer",
    successStatus: 201,
    handler: async (ctx, body) => useCases.createCourse(ctx.account!, body as CreateCourseRequest),
  },
  {
    method: "PUT",
    path: "/courses/{courseId}",
    schema: supersedeCardRequestSchema,
    auth: "golfer", // THE maintenance operation — add tee / fix numbers / rename are all this (spec §4)
    successStatus: 200,
    handler: async (ctx, body) => useCases.supersedeCard(ctx.account!, courseId(ctx.pathParams.courseId!), body as SupersedeCardRequest),
  },
  {
    method: "GET",
    path: "/courses/{courseId}",
    auth: "none", // Course-cards spec §4: reads are identity-free — a course card is public data anyone may fetch to pick a tee.
    successStatus: 200,
    handler: async (ctx) => useCases.getCourse(courseId(ctx.pathParams.courseId!)),
  },
  {
    method: "GET",
    path: "/courses",
    auth: "none", // Course-cards spec §4: search is identity-free too — the same public read surface as GET /courses/{courseId} above.
    successStatus: 200,
    handler: async (ctx) => useCases.searchCourses(parseSearchQuery(ctx.query.query), parseLimit(ctx.query.limit)),
  },
  // M7 Task 5: the golfer identity surface — every route below is "golfer"-gated (a signed-in
  // Cognito identity, never a round-scoped participant token). Accounts-only identity (spec §2):
  // GET /me ENSURES (get-or-create on first touch); PUT /me updates.
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
    method: "GET",
    path: "/me/record",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getMyRecord(ctx.account!),
  },
  // Analytics spec 2026-07-21 §4: "your record here" — same golfer tier, same shape of call as
  // GET /me/record just above, filtered to one course (the target courseId rides the path).
  {
    method: "GET",
    path: "/me/courses/{courseId}/record",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getMyCourseRecord(ctx.account!, courseId(ctx.pathParams.courseId!)),
  },
  // Projection-realignment Task 6: "list my rounds" — same golfer tier, same shape of call as
  // GET /me/record just above.
  {
    method: "GET",
    path: "/me/rounds",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getMyRounds(ctx.account!),
  },
  // Projection-realignment Task 13: "your rounds, right now" — presence, not finalized
  // history (GET /me/rounds just above). Same golfer tier.
  {
    method: "GET",
    path: "/me/rounds/live",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getMyLiveRounds(ctx.account!),
  },
  // Navigation spec §6a: the golfer page's read. "golfer"-gated (any signed-in caller may
  // view any golfer — spec §6a's own visibility decision) but NOT self-scoped: the target
  // golferId rides the path, same extraction shape as GET /courses/{courseId}. Deliberately
  // NOT in ANON_THROTTLED_ROUTES (apps/infra-cdk/lib/swngStack.ts) — unlike the "none"-auth
  // course reads, this route always requires a signed-in caller.
  {
    method: "GET",
    path: "/golfers/{golferId}",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getGolfer({ golferId: golferId(ctx.pathParams.golferId!) }),
  },
  // M8 Task 4: crews — every route below is "golfer"-gated (a signed-in Cognito identity,
  // same tier as the /me* surface above), EXCEPT POST /crews/peek ("none" — see its own entry
  // below). Member-only authorization (not-a-member 403) lives in application
  // (crews/membership.ts's requireCrewMember), never re-checked here.
  {
    method: "POST",
    path: "/crews",
    schema: createCrewRequestSchema,
    auth: "golfer",
    successStatus: 201,
    handler: async (ctx, body) => useCases.createCrew(ctx.account!, body as CreateCrewRequest),
  },
  {
    method: "POST",
    path: "/crews/join",
    schema: joinCrewRequestSchema,
    auth: "golfer",
    successStatus: 200, // joining is idempotent for an already-a-member caller (joinCrewByInvite.ts) — an act, not always a fresh mint, so 200 not 201.
    handler: async (ctx, body) => useCases.joinCrewByInvite(ctx.account!, body as JoinCrewRequest),
  },
  // Crew membership (invited in, accountable out — spec §2): the capability-scoped preview a
  // would-be joiner sees BEFORE signing in, mirroring GET /rounds/peek's own "none"-auth,
  // pre-join preview story — POST here (not GET) because the body carries a bearer-shaped
  // `token`, not a short human-typed code. Joins the anonymous-route throttle set
  // (apps/infra-cdk/lib/swngStack.ts's ANON_THROTTLED_ROUTES).
  {
    method: "POST",
    path: "/crews/peek",
    schema: peekCrewInviteRequestSchema,
    auth: "none",
    successStatus: 200,
    handler: async (_ctx, body) => useCases.peekCrewInvite(body as PeekCrewInviteRequest),
  },
  {
    method: "GET",
    path: "/me/crews",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.listMyCrews(ctx.account!),
  },
  {
    method: "GET",
    path: "/crews/{crewId}",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getCrew(ctx.account!, crewId(ctx.pathParams.crewId!)),
  },
  // Spec 2026-07-22 "the season is the record" §2: the crew name is editable — organizer-only
  // authorization lives in application (crews/updateCrew.ts's own guard), never re-checked
  // here. An act on an existing resource, not a mint (200, not 201).
  {
    method: "PUT",
    path: "/crews/{crewId}",
    schema: updateCrewRequestSchema,
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx, body) => useCases.updateCrew(ctx.account!, crewId(ctx.pathParams.crewId!), body as UpdateCrewRequest),
  },
  // Crew membership (invited in, accountable out — spec §2): mints a fresh 7-day invite link —
  // ANY member (not organizer-only, spec §1), same status-code spirit as getShareLink/
  // mintParticipantToken above (an act on an existing resource, not a top-level mint, even
  // though the token itself is fresh every call).
  {
    method: "POST",
    path: "/crews/{crewId}/invites",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.mintCrewInvite(ctx.account!, crewId(ctx.pathParams.crewId!)),
  },
  // Architecture-realignment Task 9: crew seasons + counted rounds + standings-on-read + leave.
  // Every route is "golfer"-gated; member-only authorization lives in application
  // (crews/membership.ts), never re-checked here. `seasonId` is an opaque path string (a
  // server-minted UUID) — passed through verbatim, never branded/parsed the way roundId is.
  {
    method: "POST",
    path: "/crews/{crewId}/seasons",
    schema: createSeasonRequestSchema,
    auth: "golfer",
    successStatus: 201,
    handler: async (ctx, body) => useCases.createSeason(ctx.account!, crewId(ctx.pathParams.crewId!), body as CreateSeasonRequest),
  },
  {
    method: "GET",
    path: "/crews/{crewId}/seasons",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.listSeasons(ctx.account!, crewId(ctx.pathParams.crewId!)),
  },
  // Spec 2026-07-22 "the season is the record" §2: PUT — editing the end date IS the whole
  // lifecycle, replacing the deleted close/reopen verbs; seasonId rides the path as a plain
  // string same as every other season route below. An act on an existing resource, not a mint
  // (200, same status-code spirit as transferOrganizer).
  {
    method: "PUT",
    path: "/crews/{crewId}/seasons/{seasonId}",
    schema: updateSeasonRequestSchema,
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx, body) => useCases.updateSeason(ctx.account!, crewId(ctx.pathParams.crewId!), ctx.pathParams.seasonId!, body as UpdateSeasonRequest),
  },
  {
    method: "GET",
    path: "/crews/{crewId}/seasons/{seasonId}/standings",
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx) => useCases.getSeasonStandings(ctx.account!, crewId(ctx.pathParams.crewId!), ctx.pathParams.seasonId!),
  },
  {
    method: "POST",
    path: "/crews/{crewId}/leave",
    auth: "golfer",
    successStatus: 200, // removes the caller's member item — an act on an existing resource, not a mint.
    handler: async (ctx) => useCases.leaveCrew(ctx.account!, crewId(ctx.pathParams.crewId!)),
  },
  // Crew membership (invited in, accountable out — spec §1): the organizer's authority. Both
  // "golfer"-gated (organizer-only authorization lives in application, never re-checked here,
  // same split as every other crew route above); both an act on an existing resource, not a
  // mint (200, not 201).
  {
    method: "DELETE",
    path: "/crews/{crewId}/members/{golferId}",
    auth: "golfer", // no request schema — the target golferId rides the path.
    successStatus: 200,
    handler: async (ctx) => useCases.removeCrewMember(ctx.account!, crewId(ctx.pathParams.crewId!), golferId(ctx.pathParams.golferId!)),
  },
  {
    method: "POST",
    path: "/crews/{crewId}/transfer",
    schema: transferOrganizerRequestSchema,
    auth: "golfer",
    successStatus: 200,
    handler: async (ctx, body) => useCases.transferOrganizer(ctx.account!, crewId(ctx.pathParams.crewId!), body as TransferOrganizerRequest),
  },
];
