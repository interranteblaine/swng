// Shared plumbing for fieldTest.spec.ts AND courseEntry.spec.ts: reading the live endpoint the
// built app itself was compiled against, out-of-browser joins, course seeding via the public
// course API, the deck-derived expected UI strings, the SetupPanel join-code lookup, and the
// two-tap grid interaction every score entry in either spec goes through. Split out of the spec
// files for the same reason e2e/support/client.ts is split from the root workspace's own specs:
// one place for the plumbing, one file per scenario for the story.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CloudFormationClient, ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { AdminCreateUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import {
  addGameRequestSchema,
  addGameResponseSchema,
  createCourseRequestSchema,
  createCourseResponseSchema,
  createCrewRequestSchema,
  createCrewResponseSchema,
  createSeasonRequestSchema,
  createSeasonResponseSchema,
  finalizeRoundResponseSchema,
  getCourseResponseSchema,
  getCrewResponseSchema,
  getMyRecordResponseSchema,
  golferResponseSchema,
  joinCrewRequestSchema,
  joinCrewResponseSchema,
  joinRoundRequestSchema,
  joinRoundResponseSchema,
  listSeasonsResponseSchema,
  mintCrewInviteResponseSchema,
  parse,
  recordScoreRequestSchema,
  recordScoreResponseSchema,
  searchCoursesResponseSchema,
  seasonStandingsResponseSchema,
  shareLinkResponseSchema,
  startRoundRequestSchema,
  startRoundResponseSchema,
  updateCrewRequestSchema,
  updateMeRequestSchema,
} from "@swng/contracts";
import type {
  AddGameResponse,
  CreateCrewResponse,
  CreateSeasonResponse,
  FinalizeRoundResponse,
  GameConfigInput,
  GetCrewResponse,
  GetMyRecordResponse,
  GolferResponse,
  GolferView,
  JoinCrewResponse,
  JoinRoundResponse,
  ListSeasonsResponse,
  MintCrewInviteResponse,
  SeasonStandingsResponse,
  ShareLinkResponse,
  StartRoundResponse,
  UpdateMeRequest,
} from "@swng/contracts";
import { deviceId as toDeviceId, fieldDeck18, fixtureLinks18, opId as toOpId, playGoldenRoundLog, reduceRound, scoreGame } from "@swng/domain";
import type { CourseCard, CourseId, CrewId, DeviceId, FixtureScores, GolferId, Hlc, OpId, RoundId, RoundState, StrokeBasis } from "@swng/domain";
import type { AuthTokens } from "../src/auth/tokenStore.js";
import { describeGame } from "../src/games/describeGame.js";

// --- Legibility-walk screenshots (M7 Task 8; papercuts.md §4) -----------------------------

const SCREENSHOT_DIR = fileURLToPath(new URL("../../../.superpowers/sdd/screenshots/", import.meta.url));

// Controller-review scratch folder, gitignored wholesale (`.superpowers/`) — never part of a
// diff, so these screenshots are a byproduct of running the gate, not a committed artifact.
// mkdirSync defensively (a fresh checkout won't have this directory yet).
export const screenshotPath = (name: string): string => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return `${SCREENSHOT_DIR}${name}`;
};

// M9 Task 5 (ops) fix: a run-scoped, cross-process record of every Cognito user THIS run has
// minted (see mintThrowawayUser/trackMintedUser below for why this can't just be an in-memory
// array — same gitignored-scratch directory as SCREENSHOT_DIR above, never a committed
// artifact). globalSetup.ts clears it at the start of every run (so an interrupted prior run's
// leftover file can never bleed into this run's own delete list); globalTeardown.ts is the
// ONLY reader, once, after every worker has finished.
const MINTED_USERS_DIR = fileURLToPath(new URL("../../../.superpowers/sdd/", import.meta.url));
export const MINTED_USERS_FILE = `${MINTED_USERS_DIR}e2e-minted-users.ndjson`;

// --- Endpoints ---------------------------------------------------------------------------

export interface WebEnv {
  readonly httpUrl: string;
  readonly wsUrl: string;
  // M7 Task 8: the Cognito pool identifiers scripts/webEnv.mjs already writes alongside the
  // two endpoints above (from the SAME cdk-outputs.json read) — mintThrowawayUser below reads
  // them from here rather than a second independent parse of cdk-outputs.json, same "one
  // source, no drift" rationale as this function's own doc comment already gives httpUrl/wsUrl.
  readonly userPoolId: string;
  readonly userPoolClientId: string;
}

// Reads the SAME apps/web/.env.local playwright.config.ts's webServer.command generates
// (via scripts/webEnv.mjs) before `vite build` runs — the spec's own direct joinRound calls
// for Cal/Dee (brief: score-for-anyone makes their browsers unnecessary) must hit the
// identical, already-trailing-slash-stripped origin the built app was compiled against, not a
// second independently-loaded copy of apps/infra-cdk/cdk-outputs.json that could drift from
// it. By the time a test body runs, webServer has already succeeded, so this file is
// guaranteed to exist.
export const loadWebEnv = (): WebEnv => {
  const envPath = fileURLToPath(new URL("../.env.local", import.meta.url));
  const contents = readFileSync(envPath, "utf8");
  const read = (key: string): string => {
    const line = contents.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
    if (!line) throw new Error(`${key} not found in ${envPath} — did scripts/webEnv.mjs run (playwright.config.ts's webServer.command)?`);
    return line.slice(key.length + 1).trim();
  };
  return { httpUrl: read("VITE_HTTP_URL"), wsUrl: read("VITE_WS_URL"), userPoolId: read("VITE_USER_POOL_ID"), userPoolClientId: read("VITE_USER_POOL_CLIENT_ID") };
};

// --- Course seeding: search-first, create-if-absent, via the PUBLIC course API ---------------

// Course-cards spec §4: the web app's create flow needs a REAL course record for a deck to
// search for and pick. Search-first, create-if-absent: searches by the exact name first
// (courseNameKey's prefix-match GSI — createDynamoCardStore.ts's own normalization, the same
// one the card store's pointer write uses), and only creates when no exact match comes back, so
// the gate's three consecutive `pnpm e2e:field` runs (brief) seed the course once, not three
// times. Writes are "golfer"-gated now (enteredBy derives from the account), so the caller passes
// an already-minted account whose Bearer authorizes the POST. Returns both ids: the courseId a
// UI search resolves to, plus the CURRENT cardId (fetched from GET /courses/{id} on a hit, or
// read straight off the create response).
export const ensureCourse = async (name: string, card: CourseCard, account: AccountGolfer): Promise<{ courseId: CourseId; cardId: string }> => {
  const { httpUrl } = loadWebEnv();
  if (card.teeSets.length === 0) throw new Error(`course card "${name}" has no tee sets to seed with`);

  const searchParams = new URLSearchParams({ query: name });
  const searchResponse = await fetch(`${httpUrl}/courses?${searchParams.toString()}`);
  const searchJson: unknown = await searchResponse.json();
  if (!searchResponse.ok) throw new Error(`GET /courses -> ${searchResponse.status}: ${JSON.stringify(searchJson)}`);
  const { courses } = parse(searchCoursesResponseSchema, searchJson);
  const existing = courses.find((c) => c.name === name);
  if (existing) {
    // Already seeded by a prior run — read the CURRENT card for its cardId (the reads are auth-none).
    const getResponse = await fetch(`${httpUrl}/courses/${existing.courseId}`);
    const getJson: unknown = await getResponse.json();
    if (!getResponse.ok) throw new Error(`GET /courses/${existing.courseId} -> ${getResponse.status}: ${JSON.stringify(getJson)}`);
    const { course } = parse(getCourseResponseSchema, getJson);
    return { courseId: course.courseId, cardId: course.cardId };
  }

  // Miss → create with ALL tees, stripped to plain input tees ({name, rating, slope, holes} —
  // POST mints every id, and .strict() rejects a submitted teeId/source; fixture cards carry
  // neither anyway). The account's Bearer authorizes the golfer-gated write.
  const body = parse(createCourseRequestSchema, {
    name,
    teeSets: card.teeSets.map((tee) => ({ name: tee.name, rating: tee.rating, slope: tee.slope, holes: tee.holes })),
  });
  const createResponse = await fetch(`${httpUrl}/courses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${account.tokens.idToken}` },
    body: JSON.stringify(body),
  });
  const createJson: unknown = await createResponse.json();
  if (!createResponse.ok) throw new Error(`POST /courses -> ${createResponse.status}: ${JSON.stringify(createJson)}`);
  const { course } = parse(createCourseResponseSchema, createJson);
  return { courseId: course.courseId, cardId: course.cardId };
};

// Reads a course lineage's CURRENT reference ({courseId, cardId}) off the public GET
// /courses/{id} (auth-none, same read ensureCourse uses on a search hit). unratedCourse.spec.ts
// enters its course through the BROWSER (AddCoursePage — the "unrated" render is the thing under
// test there, so it can't be back-door-seeded), then needs the cardId out-of-browser to drive
// its record-building rounds via startRoundDirect — StartRound is a reference command
// ({courseId, cardId}), and the browser never surfaces the cardId. Returns the exact shape
// startRoundDirect's `course` param takes, so it threads straight through. `id` is a raw string
// (the URL segment the spec captured), branded server-side into the response's own CourseId.
export const getCourseDirect = async (httpUrl: string, id: string): Promise<{ courseId: CourseId; cardId: string }> => {
  const response = await fetch(`${httpUrl}/courses/${id}`);
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`GET /courses/${id} -> ${response.status}: ${JSON.stringify(json)}`);
  const { course } = parse(getCourseResponseSchema, json);
  return { courseId: course.courseId, cardId: course.cardId };
};

// --- Out-of-browser joins (always as an account, always as yourself) -----------------------

// Joins the round the same way JoinRoundPage's own submit handler does, but via a direct
// fetch instead of a browser (fieldTest's Cal/Dee: joining them through context A would
// overwrite Ann's localStorage credential for the round — `swng:credential:<roundId>` is one
// key per round per browser, not per golfer). Accounts-only (the wall): the caller IS an
// account and joins as themselves — the Bearer rides along and the seat is resolved
// server-side (ensureGolfer), so the body carries no name/golferId.
export const joinRoundDirect = async (
  httpUrl: string,
  account: AccountGolfer,
  input: { readonly code: string; readonly tee: string; readonly basis: StrokeBasis },
): Promise<JoinRoundResponse> => {
  const body = parse(joinRoundRequestSchema, {
    code: input.code,
    tee: input.tee,
    basis: input.basis,
  });
  const response = await fetch(`${httpUrl}/rounds/join`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${account.tokens.idToken}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /rounds/join -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(joinRoundResponseSchema, json);
};

// --- API-driven rounds, entirely out-of-browser (M7 Task 8) --------------------------------

// api.ts's own createRound/finalizeRound/getMyRecord can't be imported here even for their
// typed shapes: api.ts pulls in ./config.ts, whose `config` constant reads import.meta.env at
// MODULE-LOAD time — a Vite-only global that doesn't exist under Playwright's own (non-Vite)
// Node test runner, so the import crashes before a single test even collects (confirmed
// against a real e2e:field run: "Cannot read properties of undefined (reading
// 'VITE_HTTP_URL')" at src/config.ts:16, from api.ts's own top-level `config.httpUrl` read).
// This is exactly why joinRoundDirect above already hand-rolls its own fetch instead of
// calling api.ts's joinRound — these three follow the identical *Direct idiom for the same
// reason, not out of not knowing api.ts exists.
// Accounts-only (the wall): the creator IS an account and the round seats them alone — nobody
// puts anyone on a card, so extra participants join as themselves (joinRoundDirect above). The
// Bearer rides along and the seat is resolved server-side (ensureGolfer), so the body carries no
// name/golferId. No crewId here: round-is-a-sealed-leaf — a crew's own season standings are
// derived on read from shared golfer projection lines, never a round-side back-reference.
export const startRoundDirect = async (
  httpUrl: string,
  account: AccountGolfer,
  input: { readonly course: { readonly courseId: CourseId; readonly cardId: string }; readonly tee: string; readonly basis: StrokeBasis },
): Promise<StartRoundResponse> => {
  const body = parse(startRoundRequestSchema, {
    course: input.course,
    host: { tee: input.tee, basis: input.basis },
  });
  const response = await fetch(`${httpUrl}/rounds`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${account.tokens.idToken}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /rounds -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(startRoundResponseSchema, json);
};

// POST /rounds/{roundId}/games, out-of-browser — same *Direct idiom as every other helper in
// this section (api.ts's addGame can't be imported here either, same config.ts module-load
// crash this file's own header comment already explains for createRound/finalizeRound/etc.).
export const addGameDirect = async (httpUrl: string, id: RoundId, token: string, game: GameConfigInput): Promise<AddGameResponse> => {
  const body = parse(addGameRequestSchema, { game });
  const response = await fetch(`${httpUrl}/rounds/${id}/games`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /rounds/${id}/games -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(addGameResponseSchema, json);
};

export const finalizeRoundDirect = async (httpUrl: string, id: RoundId, token: string): Promise<FinalizeRoundResponse> => {
  const response = await fetch(`${httpUrl}/rounds/${id}/finalize`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /rounds/${id}/finalize -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(finalizeRoundResponseSchema, json);
};

export const getMyRecordDirect = async (httpUrl: string, token: string): Promise<GetMyRecordResponse> => {
  const response = await fetch(`${httpUrl}/me/record`, { headers: { authorization: `Bearer ${token}` } });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`GET /me/record -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(getMyRecordResponseSchema, json);
};

// M9 Task 3 (share), out-of-browser: mints the round's own immortal spectator link. Same
// *Direct idiom as every other helper in this section — api.ts's own shareRound can't be
// imported here either (this file's header comment's config.ts module-load crash). Returns
// the raw `{ url }` (a path+fragment, e.g. "/watch/<roundId>#<token>") — shareLink.spec.ts
// hands it straight to page.goto(), which resolves it against playwright.config.ts's own
// baseURL, the same "the web supplies the origin" seam getShareLink.ts's own doc comment
// anticipates.
export const shareRoundDirect = async (httpUrl: string, id: RoundId, token: string): Promise<ShareLinkResponse> => {
  const response = await fetch(`${httpUrl}/rounds/${id}/share`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /rounds/${id}/share -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(shareLinkResponseSchema, json);
};

// --- Crews + as-self identity, entirely out-of-browser (M8 Task 7 — the golden season gate) -

// PUT /me — the one get-or-create path (getMeResponse.ts's own doc comment); crewSeason.spec.ts
// uses this to mint host U's own "Al" golfer BEFORE creating a crew (createCrew.ts's own
// requireAccountGolfer: "the web PUTs /me first").
export const updateMeDirect = async (httpUrl: string, token: string, input: UpdateMeRequest): Promise<GolferResponse> => {
  const body = parse(updateMeRequestSchema, input);
  const response = await fetch(`${httpUrl}/me`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`PUT /me -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(golferResponseSchema, json);
};

export const createCrewDirect = async (httpUrl: string, token: string, name: string): Promise<CreateCrewResponse> => {
  const body = parse(createCrewRequestSchema, { name });
  const response = await fetch(`${httpUrl}/crews`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /crews -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(createCrewResponseSchema, json);
};

// GET /crews/{crewId} — the plain crew read, "golfer"-gated (member-only authorization inside
// application). Used after updateCrewDirect below to prove a rename landed on the wire itself,
// not merely echoed by the mutation's own response.
export const getCrewDirect = async (httpUrl: string, token: string, id: CrewId): Promise<GetCrewResponse> => {
  const response = await fetch(`${httpUrl}/crews/${id}`, { headers: { authorization: `Bearer ${token}` } });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`GET /crews/${id} -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(getCrewResponseSchema, json);
};

// PUT /crews/{crewId} (spec 2026-07-22 "the season is the record" §2): the crew name is
// editable — organizer-only authorization lives in application (updateCrew.ts's own guard),
// never re-checked here. Reuses getCrewResponseSchema's `{ crew }` shape (the SAME "produces
// the crew" reuse precedent createCrewDirect/joinCrewDirect/removeCrewMemberDirect already
// follow), never a parallel type.
export const updateCrewDirect = async (httpUrl: string, token: string, id: CrewId, name: string): Promise<GetCrewResponse> => {
  const body = parse(updateCrewRequestSchema, { name });
  const response = await fetch(`${httpUrl}/crews/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`PUT /crews/${id} -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(getCrewResponseSchema, json);
};

// POST /crews/{crewId}/invites (crew membership, invited in, accountable out — spec §2): ANY
// member mints a fresh 7-day HMAC invite token — the self-service counterpart to the deleted
// permanent join code. crewSeason.spec.ts's step 8 (the late crew join) mints one as Al (the
// crew's sole member through steps 5-7) and hands the token to joinCrewDirect below.
export const mintCrewInviteDirect = async (httpUrl: string, token: string, id: CrewId): Promise<MintCrewInviteResponse> => {
  const response = await fetch(`${httpUrl}/crews/${id}/invites`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /crews/${id}/invites -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(mintCrewInviteResponseSchema, json);
};

// POST /crews/join — the self-service counterpart to the deleted add-a-ghost-by-name path
// (joinCrewByInvite.ts's own doc comment): adds the CALLER's own account golfer as a member
// (role "member") off an invite TOKEN (mintCrewInviteDirect above) — the permanent join code
// this call used to carry is gone (crew membership, invited in, accountable out — spec §3).
// crewSeason.spec.ts's step 8 (the late crew join) uses this to prove membership is pure
// aggregation scope: Bo, a season-long non-member whose rounds were all counted anyway, joins
// the crew by invite and his standings rows materialize on the very next read — nothing about
// them was lost while he was a non-member.
export const joinCrewDirect = async (httpUrl: string, token: string, inviteToken: string): Promise<JoinCrewResponse> => {
  const body = parse(joinCrewRequestSchema, { token: inviteToken });
  const response = await fetch(`${httpUrl}/crews/join`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /crews/join -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(joinCrewResponseSchema, json);
};

// DELETE /crews/{crewId}/members/{golferId} (crew membership, invited in, accountable out —
// spec §1): the ORGANIZER's authority to remove a member — no body, the target rides the path
// (crews.ts's own doc comment on the route). Returns the crew's own updated view
// (getCrewResponseSchema), same "produces the crew" shape as createCrew/joinCrewDirect above.
// crewSeason.spec.ts's step 8 uses this to pin the aggregation-scope law one hop further than
// join alone reaches: a removed member's standings rows vanish on the very next read (nothing
// about the counted rounds themselves changes — only the roster a season's standings filter
// against), and a fresh invite + re-join (joinCrewDirect) restores them byte-identical.
export const removeCrewMemberDirect = async (httpUrl: string, token: string, id: CrewId, target: GolferId): Promise<GetCrewResponse> => {
  const response = await fetch(`${httpUrl}/crews/${id}/members/${target}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`DELETE /crews/${id}/members/${target} -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(getCrewResponseSchema, json);
};

// Architecture-realignment Task 12: crew seasons + standings-on-read replace the deleted GET
// /crews/{id}/records projection surface (Task 9). Every helper below is "golfer"-gated on the
// wire (routes.ts) — the Bearer must be a crew MEMBER's ID token. The whole append/remove
// mutation surface this comment used to also describe (plus its did-not-play/not-the-appender
// guards) is deleted (crew-scoreboard spec §2b) — standings are a derived window over shared
// rounds now, nothing left to mutate.

// Spec 2026-07-22 "the season is the record" §1/§2: createSeasonRequestSchema now REQUIRES
// both dates (chosen, visible, never derived) — every caller passes its own startsAt/endsAt.
export const createSeasonDirect = async (
  httpUrl: string,
  token: string,
  id: CrewId,
  name: string,
  startsAt: string,
  endsAt: string,
): Promise<CreateSeasonResponse> => {
  const body = parse(createSeasonRequestSchema, { name, startsAt, endsAt });
  const response = await fetch(`${httpUrl}/crews/${id}/seasons`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /crews/${id}/seasons -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(createSeasonResponseSchema, json);
};

// GET /crews/{crewId}/seasons (spec 2026-07-22 "the season is the record" §2): every season on
// the crew, newest-first (listSeasons.ts's own sort). Used to find the auto-minted season
// createCrew seeds every crew with (task-4-brief.md item 1) — the only season on a
// just-created crew.
export const listSeasonsDirect = async (httpUrl: string, token: string, id: CrewId): Promise<ListSeasonsResponse> => {
  const response = await fetch(`${httpUrl}/crews/${id}/seasons`, { headers: { authorization: `Bearer ${token}` } });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`GET /crews/${id}/seasons -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(listSeasonsResponseSchema, json);
};

export const getSeasonStandingsDirect = async (httpUrl: string, token: string, id: CrewId, seasonId: string): Promise<SeasonStandingsResponse> => {
  const response = await fetch(`${httpUrl}/crews/${id}/seasons/${seasonId}/standings`, { headers: { authorization: `Bearer ${token}` } });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`GET /crews/${id}/seasons/${seasonId}/standings -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(seasonStandingsResponseSchema, json);
};

// Spec 2026-07-22 "the season is the record" §2: editing the end date IS the whole lifecycle —
// PUT /crews/{crewId}/seasons/{seasonId} replaces the deleted close/reopen verb pair outright.
// Organizer-gated on the wire (routes.ts + updateSeason.ts's own guard), so the Bearer must be
// the organizer's ID token. Reuses createSeasonResponseSchema's `{ season }` shape (byte-
// identical — createSeasonDirect's own reuse precedent), never a parallel type.
export const updateSeasonDirect = async (
  httpUrl: string,
  token: string,
  id: CrewId,
  seasonId: string,
  body: { readonly name?: string; readonly startsAt?: string; readonly endsAt?: string },
): Promise<CreateSeasonResponse> => {
  const response = await fetch(`${httpUrl}/crews/${id}/seasons/${seasonId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`PUT /crews/${id}/seasons/${seasonId} -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(createSeasonResponseSchema, json);
};

// Generic "keep reading until an asynchronous projector catches up" poller — identityRecord.
// spec.ts's own pollRecord (M7 Task 8) hand-rolled exactly this shape for GET /me/record;
// crewSeason.spec.ts needs the identical shape for its own GET /me/record reads, so this is
// the one implementation both specs' polling can share instead of a second hand-rolled copy.
// (Season standings need no polling at all — they're computed on read.)
export const pollUntil = async <T>(fetchOnce: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 60_000, label = "poll"): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fetchOnce();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${label}: condition not met after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

// --- Direct score recording (M7 Task 8) ----------------------------------------------------

// A per-device opId/hlc generator — the same idiom as the root e2e workspace's own
// e2e/support/client.ts createClientOps (that file lives in a SIBLING pnpm package apps/web
// can't import without a new cross-workspace dependency, so this is a deliberately small,
// self-contained duplicate rather than a structural change this task's scope doesn't call
// for). wallMs strictly increases per device (clamped to real elapsed time or +1, whichever is
// greater) so a batch of same-tick scores still gets a total hlc order.
export interface ScoreOps {
  readonly deviceId: DeviceId;
  next(): { readonly opId: OpId; readonly hlc: Hlc };
}

export const createScoreOps = (device: string): ScoreOps => {
  const id = toDeviceId(device);
  let counter = 0;
  let lastWallMs = 0;
  return {
    deviceId: id,
    next: () => {
      counter += 1;
      lastWallMs = Math.max(Date.now(), lastWallMs + 1);
      return { opId: toOpId(`${device}-op-${counter}`), hlc: { wallMs: lastWallMs, counter: 0, deviceId: id } };
    },
  };
};

// identityRecord.spec.ts's own three API-played rounds need real "strokes" scores posted
// with no browser at all — score/pull is deliberately absent from api.ts ("score/pull go
// through the session instead, never through here"), so this is the direct-fetch
// counterpart, matching every other *Direct helper in this file (joinRoundDirect above).
export const recordScoreDirect = async (
  httpUrl: string,
  id: RoundId,
  token: string,
  input: { readonly golferId: GolferId; readonly hole: number; readonly strokes: number },
  ops: ScoreOps,
): Promise<void> => {
  const { opId, hlc } = ops.next();
  const body = parse(recordScoreRequestSchema, { golferId: input.golferId, hole: input.hole, result: { kind: "strokes", strokes: input.strokes }, opId, hlc });
  const response = await fetch(`${httpUrl}/rounds/${id}/scores`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /rounds/${id}/scores -> ${response.status}: ${JSON.stringify(json)}`);
  parse(recordScoreResponseSchema, json);
};

// --- Identity: throwaway Cognito users, auth injection, the rebuild lambda (M7 Task 8) -----

// Fixed per docs/implementation-plan.md's own "AWS profile swng, region us-east-1" constant —
// every AWS-touching spot in this repo (CDK, adapters-dynamodb contract tests) hardcodes the
// same region rather than reading it from an env var; the PROFILE, by the same repo-wide
// convention (root package.json's own cdk:guard script), is never named in source — the
// caller's shell must already have credentials active (AWS_PROFILE=swng or equivalent) before
// running `pnpm e2e:field`. Exported: globalTeardown.ts's own AdminDeleteUser calls need the
// SAME region, not a second hardcoded copy.
export const AWS_REGION = "us-east-1";

// M9 Task 5 fix: a PREVIOUS version of this cleanup kept `mintedUsers` as a plain in-memory
// array and registered a top-level `test.afterAll` right here to flush it. That looked correct
// in review and did NOT work — verified against a real `pnpm e2e:field` run against beta: the
// pool still held every user minted during the run's window, and the run log had ZERO
// "[e2e cleanup] ... failed" warnings, meaning AdminDeleteUser was never even attempted.
//
// Root cause, confirmed by reading how Playwright actually loads test files (not assumed):
// `workers: 1` + `fullyParallel: false` (playwright.config.ts) means every spec file in a
// `pnpm e2e:field` run shares ONE Node worker process, and Node's ES module cache is per
// PROCESS, not per file — importing "./support.js" from a SECOND spec file returns the
// already-evaluated module without re-running its top-level code. A `test.afterAll(...)` call
// sitting at this file's top level only ever executes ONCE, attributed to whichever spec file
// happens to import support.ts FIRST in the run (alphabetically, courseEntry.spec.ts — which
// never calls mintThrowawayUser itself). That file's afterAll fires early, sees an empty
// `mintedUsers` (nothing to warn about — matches the zero-warning evidence), and every LATER
// file's minted users (crewSeason/identityRecord/primaryPath) land in the same shared array
// but NO afterAll ever fires again to flush it — they leak silently. The doc comment this
// replaced ("Playwright resets the module cache between test files") was simply wrong.
//
// Fix: cross-worker, cross-file state that doesn't depend on a hook firing inside any specific
// spec file at all. Every mint appends a `{userPoolId, username}` line to MINTED_USERS_FILE (a
// plain file on disk — survives across every file/worker in the run, unlike a JS module
// binding). A Playwright `globalSetup` (globalSetup.ts) clears that file once at the very start
// of the run; a `globalTeardown` (globalTeardown.ts) reads it ONCE, after every worker has
// finished — not attributed to any single spec file — and best-effort AdminDeleteUsers every
// line, then removes the file. See those two files for the actual delete logic.
const trackMintedUser = (userPoolId: string, username: string): void => {
  mkdirSync(MINTED_USERS_DIR, { recursive: true });
  appendFileSync(MINTED_USERS_FILE, `${JSON.stringify({ userPoolId, username })}\n`);
};

// Mints a per-run throwaway Cognito user via the admin APIs (AdminCreateUser +
// AdminSetUserPassword, MessageAction SUPPRESS so no real email ever sends) and exchanges it
// for real tokens via InitiateAuth USER_PASSWORD_AUTH — the same beta-grade flow
// authConfig.ts's own doc comment names this exact purpose for (never drives the Hosted UI).
// Returns the SAME shape tokenStore.ts persists, ready to inject verbatim.
export const mintThrowawayUser = async (label: string): Promise<AuthTokens> => {
  const { userPoolId, userPoolClientId } = loadWebEnv();
  const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });
  const username = `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}@example.com`;
  const password = `Sw!ng-${Math.random().toString(36).slice(2)}-Aa1`; // meets the pool's default complexity policy

  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS",
      TemporaryPassword: password,
    }),
  );
  // Tracked for cleanup only once the user actually exists — a failed AdminCreateUser above
  // throws before this line runs, so globalTeardown.ts never attempts to delete a user that
  // was never actually minted.
  trackMintedUser(userPoolId, username);
  // FORCE_CHANGE_PASSWORD -> CONFIRMED, Permanent: true — InitiateAuth's own USER_PASSWORD_AUTH
  // flow below rejects a still-temporary password with a NEW_PASSWORD_REQUIRED challenge this
  // helper has no interactive way to answer.
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }));

  const auth = await cognito.send(
    new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: userPoolClientId, AuthParameters: { USERNAME: username, PASSWORD: password } }),
  );
  const result = auth.AuthenticationResult;
  if (!result?.IdToken || !result.RefreshToken || result.ExpiresIn === undefined) {
    throw new Error(`InitiateAuth for ${username} did not return a complete AuthenticationResult: ${JSON.stringify(auth)}`);
  }
  return { idToken: result.IdToken, refreshToken: result.RefreshToken, expiresAt: Date.now() + result.ExpiresIn * 1000 };
};

// A signed-in account bound to its own golfer record — the ONE identity shape every *Direct
// round call above takes (accounts-only identity spec §1-2: every person on a card is an
// account; there are no ghosts, no claims, no anonymous rounds). `golfer` is the record
// PUT /me returned, so the identity fields StartRound/JoinRound still carry on the wire
// until N-T6 drops them (host.name / name / golferId) are sourced from the RECORD, never
// from story-local free text — N-T6's shape change is a mechanical field-drop at the two
// body-construction sites above.
export interface AccountGolfer {
  readonly tokens: AuthTokens;
  readonly golfer: GolferView;
}

// mintThrowawayUser + one PUT /me — the account signs up and names itself, the same two acts
// a real golfer performs (Hosted-UI sign-up, then the funnel's name prompt), collapsed to
// their API shape for stories where the naming itself isn't the thing under test. Specs that
// DO cover the funnel prompt (fieldTest's browser B, primaryPath) call mintThrowawayUser
// alone and leave the placeholder name in place for the browser to replace.
export const mintAccountGolfer = async (label: string, name: string): Promise<AccountGolfer> => {
  const tokens = await mintThrowawayUser(label);
  const { httpUrl } = loadWebEnv();
  const { golfer } = await updateMeDirect(httpUrl, tokens.idToken, { name });
  return { tokens, golfer };
};

// Injects tokenStore.ts's own AUTH_KEY ("swng:auth") — duplicated here as a literal because
// this runs in Node, outside the page, and can't import a browser-only module's runtime
// constant; the key string must match tokenStore.ts EXACTLY (the context brief's own
// instruction) or AuthProvider silently never finds it. addInitScript (not page.evaluate) so
// this is present BEFORE the page's own first script runs, on every navigation this
// page/context makes from here on — the pre-navigation injection the brief asks for.
export const injectAuthTokens = async (page: Page, tokens: AuthTokens): Promise<void> => {
  await page.addInitScript((t) => {
    localStorage.setItem("swng:auth", JSON.stringify(t));
  }, tokens);
};

// Resolves the RebuildFunction's physical name via the deployed stack's own CloudFormation
// resources (brief: "find its physical name via the CloudFormation stack resources... or a
// stack output if one exists" — cdk-outputs.json carries no RebuildFunction output, so this is
// the CloudFormation path) — CDK's auto-generated physical name carries a hash suffix on the
// logical id (`RebuildFunction08BA4749` at last check) that would make a literal name brittle
// across any redeploy that touches this construct, so the lookup is by logical-id PREFIX
// instead of a hardcoded physical name.
const resolveRebuildFunctionName = async (): Promise<string> => {
  const cfn = new CloudFormationClient({ region: AWS_REGION });
  let nextToken: string | undefined;
  let totalScanned = 0;

  for (;;) {
    const resources = await cfn.send(new ListStackResourcesCommand({ StackName: "swng-beta", NextToken: nextToken }));
    const rebuildResource = resources.StackResourceSummaries?.find((r) => r.LogicalResourceId?.startsWith("RebuildFunction"));
    if (rebuildResource?.PhysicalResourceId) {
      return rebuildResource.PhysicalResourceId;
    }

    totalScanned += resources.StackResourceSummaries?.length ?? 0;
    nextToken = resources.NextToken;

    if (!nextToken) break; // no more pages
  }

  throw new Error(`no RebuildFunction* resource found in the swng-beta stack (${totalScanned} resources scanned)`);
};

// Invokes the manual-only rebuild entry (packages/lambda/src/entries/rebuild.ts) — paged
// backfill over the snapshots table with idempotent upserts and cursor-resume. Loops until
// the response carries no cursor (all snapshots processed). No client-side timeout is
// configured — the function's own 5-minute CDK timeout (apps/infra-cdk/lib/swngStack.ts)
// is the real bound, and the AWS SDK v3's NodeHttpHandler default (no request timeout)
// simply waits for it; the caller sets its OWN Playwright test.setTimeout generously instead.
export const invokeRebuild = async (): Promise<{ readonly processed: number }> => {
  const functionName = await resolveRebuildFunctionName();
  const lambda = new LambdaClient({ region: AWS_REGION });

  let cursor: string | undefined;
  let totalProcessed = 0;

  for (;;) {
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: JSON.stringify({ cursor, maxSnapshots: undefined }),
      }),
    );
    const payloadText = response.Payload ? Buffer.from(response.Payload).toString("utf8") : "";
    if (response.FunctionError) throw new Error(`rebuild lambda failed (${response.FunctionError}): ${payloadText}`);
    const payload = payloadText ? (JSON.parse(payloadText) as { processed?: unknown; cursor?: unknown }) : {};
    if (typeof payload.processed !== "number") {
      throw new Error(`rebuild lambda returned an unexpected payload: ${payloadText}`);
    }
    totalProcessed += payload.processed;
    cursor = typeof payload.cursor === "string" ? payload.cursor : undefined;
    if (!cursor) break;
  }

  return { processed: totalProcessed };
};

// --- The deck as the oracle: expected UI strings, derived, not hand-copied -----------------

const { players, fourball, skins, scores, corrections } = fieldDeck18;

// Same truncation idiom as fieldDeck18.test.ts/describeGame.test.ts's own `thru`/thru16
// helpers — a mid-round snapshot is the same deck cut off after hole n.
const truncate = (n: number): FixtureScores => Object.fromEntries(Object.entries(scores).map(([golfer, holes]) => [golfer, holes.slice(0, n)]));

// Rebuilds the RoundState the deck's own scores (thru n, with or without the h9 correction)
// fold to — mirrors describeGame.test.ts's own `playRound` helper. This is what lets the
// spec assert against text derived from the SAME domain engines the real app's session runs,
// rather than a hand-typed expectation that could silently drift from either.
const roundThru = (n: number, withCorrection: boolean): RoundState => {
  const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], truncate(n), withCorrection ? corrections : [], false);
  return reduceRound(events);
};

// The fourball-match chip line at hole n (with or without the h9 correction folded in).
export const describeFourballAt = (n: number, withCorrection: boolean): string => {
  const round = roundThru(n, withCorrection);
  return describeGame(scoreGame(fourball, round), round).line;
};

// The skins chip line at hole n (with or without the h9 correction folded in) — this is
// what lets the spec assert B's stale offline view (thru 12, correction withheld, since B
// never received it) and A's/B's post-reconnect refold (thru 12, correction applied) without
// either being a hand-typed string.
export const describeSkinsAt = (n: number, withCorrection: boolean): string => {
  const round = roundThru(n, withCorrection);
  return describeGame(scoreGame(skins, round), round).line;
};

// name -> the deck's own golferId key ("ann"/"bo"/"cal"/"dee") for indexing into
// fieldDeck18.scores — derived from fieldDeck18.players rather than a second hand-authored
// name map, so a deck edit can't silently desync this from the actual roster.
export const golferKeyFor = (name: string): GolferId => {
  const found = players.find((p) => p.name === name);
  if (!found) throw new Error(`no fieldDeck18 player named "${name}"`);
  return found.golferId;
};

// "conceded" dropped from this signature (task-2 fix round 1, fold-in): fieldDeck18 has no
// conceded cell and no e2e spec anywhere calls enterScore/scoreFor with one — the branch was
// unreachable and, after task-2, stale (conceded's button no longer posts on one tap, and its
// glyph is no longer "CN"). Dropped rather than reworked to the new two-tap-disclosure protocol
// since nothing exercises it; a future task adding e2e coverage of a conceded score builds that
// path fresh against the real ScorePad disclosure rather than resurrecting this one.
export const scoreFor = (name: string, hole: number): number | "picked-up" => {
  const value = fieldDeck18.scores[golferKeyFor(name)]?.[hole - 1];
  if (value === undefined || value === null) throw new Error(`fieldDeck18 has no hole ${hole} score for ${name}`);
  return value;
};

export const correctedScore = (golferName: string, hole: number): number | "picked-up" => {
  const found = corrections.find((c) => c.golfer === golferKeyFor(golferName) && c.hole === hole);
  if (!found) throw new Error(`no fieldDeck18 correction for ${golferName} hole ${hole}`);
  return found.score;
};

export const PLAYER_NAMES = ["Ann", "Bo", "Cal", "Dee"] as const;

// --- UI interaction: the two-tap contract, everywhere -------------------------------------

const scoreButtonText = (score: number | "picked-up"): string => (score === "picked-up" ? "Picked up" : String(score));

// The two-tap contract (product.md §9), literally: exactly two `.click()` calls take the grid
// from idle to a posted score, and the pad closes on the second one — no separate confirm
// step. Every score entry in the spec goes through this one function, so the M5 Task 7 brief's
// "assert exactly two click() calls on one representative entry" holds for every entry, not
// just the one the spec calls out explicitly. (The between-holes digest overlay this helper
// once had to dismiss before every entry is deleted outright — accounts-only identity spec §6
// — so nothing can sit above the grid between taps anymore.)
export const enterScore = async (page: Page, golferName: string, hole: number, score: number | "picked-up"): Promise<void> => {
  // exact: true throughout — "hole 1" is a substring of "hole 10".."hole 18" (and the dialog's
  // "hole 1" likewise), so a non-exact name match would resolve to every one of them at once.
  const cell = page.getByRole("button", { name: `${golferName} hole ${hole}`, exact: true });
  await cell.click(); // tap 1

  const dialog = page.getByRole("dialog", { name: `Score for ${golferName}, hole ${hole}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: scoreButtonText(score), exact: true }).click(); // tap 2

  await expect(dialog).toBeHidden(); // no confirm step: the pad closes on the posting tap itself

  // The cell's rendered text is dots (●, non-digit) + the score glyph + an optional net digit,
  // concatenated with no separators (e.g. "●65" — 1 dot, gross 6, net 5) — for a numeric score
  // (always exactly one digit; ScorePad only ever offers 1-12), matching on "the first digit in
  // the text" is what keeps this from a false-positive match against the net span's own digit
  // (e.g. posting 7 with 2 dots renders net 5, so a bare `toContainText("5")` would wrongly
  // pass even though 5 was never the posted score — but net can never be the FIRST digit).
  if (score === "picked-up") await expect(cell).toContainText("PU");
  else await expect(cell).toHaveText(new RegExp(`^\\D*${score}`));
};

// Clears an already-scored cell via the pad's own "Clear score" button (ScorePad.tsx: rendered
// ONLY when the tapped cell already holds a result) — the same two-tap shape as enterScore
// above, backing a score OUT instead of posting one. Afterward the cell reads unscored
// everywhere (cellAt hides a `cleared` result from every reader, round/state.ts), so the caller
// asserts whatever "unscored" means for its own surface (an idle cell, a refolded game line).
export const clearScore = async (page: Page, golferName: string, hole: number): Promise<void> => {
  const cell = page.getByRole("button", { name: `${golferName} hole ${hole}`, exact: true });
  await cell.click(); // tap 1

  const dialog = page.getByRole("dialog", { name: `Score for ${golferName}, hole ${hole}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^clear score$/i }).click(); // tap 2

  await expect(dialog).toBeHidden(); // no confirm step, same as a posting tap
};

// --- Setup: reading the join code, waiting on cross-context participant/game propagation ----

// SetupPanel's own layout: "Join code" label, then the code itself, as adjacent <p>s — no ARIA
// name/testid on either, so a structural (following-sibling) lookup is the reliable way to grab
// it, same convention as ../src/round/SetupPanel.tsx. fieldTest.spec.ts's own step 1 keeps its
// established inline version of this same xpath (untouched, per this milestone's field-test-
// upkeep scope) — this export exists for courseEntry.spec.ts's own single-context flow, so any
// NEW caller has one place to get it from rather than a third copy.
// Works on EVERY entry path now (spec 2026-07-20 §2): JoinRoundResponse carries the round's own
// join code on both a real join AND the /rounds/:roundId re-mint (openLiveRound.ts saves
// `joinCode: response.joinCode`, no longer a blank), so the panel's "Join code" <p> always holds
// a real code — the former re-mint blank-panel caveat is gone. Still layout-coupled to
// SetupPanel's own DOM shape, per the xpath above.
export const readJoinCode = async (page: Page): Promise<string> => {
  const joinCodeCell = page.locator("xpath=//p[normalize-space(text())='Join code']/following-sibling::p[1]");
  await expect(joinCodeCell).toBeVisible();
  const code = ((await joinCodeCell.textContent()) ?? "").trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
};

// --- Setup: waiting on cross-context participant/game propagation --------------------------

// Waits until `name` has propagated into this page's own folded round state (via WS/pull) —
// needed before driving a <select> whose <option>s come from state.participants (e.g.
// AddGameForm's side pickers), since Cal/Dee joined out-of-browser and their
// participant-joined events reach context A asynchronously.
export const waitForParticipant = async (page: Page, name: string): Promise<void> => {
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
};

// --- WS proxy: routes traffic through Playwright so a socket can be force-closed on demand ---

// context.setOffline(true) alone does NOT close an already-open WebSocket in Chromium (CDP's
// offline emulation blocks NEW network activity — including new WebSocket upgrades — but
// doesn't tear down a connection that's already established, verified against the real beta WS
// endpoint before wiring this in). It DOES reliably block fetch/XHR, so it's still what makes a
// dark context's push/pull fail. To also get the client-visible "disconnected" state (offline
// banner, the reconnect affordance) — which real network loss WOULD produce, by actually
// severing the TCP connection — WS traffic is routed through routeWebSocket so the socket can be
// closed on demand, exactly like a dropped connection: the client's own onclose fires for real,
// flipping connected() false.
//
// An earlier design (task-6-report.md's "Fix wave: harness zombie-socket watchdog") tried to
// INFER a dead socket from receive silence — a debounced inactivity timer that force-closed a
// connection after N seconds without an upstream message. That turned out to be a design flaw,
// not a tuning problem: a receive-only socket has LEGITIMATE multi-second silence between
// scoring bursts, and especially during a recovery wait itself (a long assertion wait carries
// zero traffic by design), so the watchdog could force-close a perfectly healthy socket mid-recovery —
// racing a fresh reconnect against an in-flight pull and burning the bounded retry on a false
// positive (m6-gate-field-3.log: step 7's recovery fired and passed; step 8's fired but the
// re-assert still failed; total run 47.6s vs ~19s baseline — two 10s recovery waits, the
// signature of exactly this race). Inactivity cannot distinguish dead from quiet without an
// application heartbeat, and there is none, so the watchdog has been removed entirely.
//
// What remains is event-driven, not inferred: `server.onClose` below mirrors an OBSERVED upstream
// close onto the client-visible socket (no false positives — it only fires on a real close), and
// `expectOrRecover` (below) is the sole place recovery gets triggered — deterministically, from
// the assertion itself timing out, by directly force-closing the page's OWN proxied socket via
// `WsRouteHandle` rather than waiting to see whether the client "notices" on its own.
export interface WsRouteHandle {
  current: WebSocketRoute | undefined;
}

// Wires `context`'s WebSocket traffic through a routeWebSocket proxy. `handle.current` is kept
// pointed at the LATEST connection for this context — Playwright re-invokes this handler fresh
// per connection (including reconnects), so a caller holding `handle` can always force-close
// whatever socket is live right now, never a stale reference to a connection that already closed.
export const installWsProxy = async (context: BrowserContext, handle: WsRouteHandle): Promise<void> => {
  await context.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => ws.send(message));
    // Event-driven, not inferred: if the upstream leg itself closes, mirror that onto the
    // client-visible socket. No false positives — this only fires on an observed close.
    server.onClose(() => void ws.close().catch(() => {}));
    handle.current = ws;
  });
};

// --- Deterministic announced-recovery wrapper for cross-context WS-dependent assertions ----

// Any assertion that depends on ONE context receiving events pushed by the OTHER over WS is
// exposed to a WS push silently never arriving (delivery loss, not a product bug — see the WS
// proxy note above). Recovery here is deterministic, not inferred: on an assertion timeout, this
// FORCES the page's own proxied socket closed via `routeHandle` — no banner-gating, no guessing
// whether the client has "noticed" yet — which reliably flips connected() false and renders the
// Offline banner + Sync-now button (StatusChrome.tsx renders that button only inside its
// `!connected` block), then clicks Sync-now (the same recovery a real golfer has: a full HTTP
// pull, the sole cursor authority) and re-asserts the SAME `expect(...)` the caller built — same
// locator, same expected value; nothing about assertion strength changes.
//
// Bounded retry: up to two announced force-close+Sync-now cycles. A Sync-now pull is idempotent
// and authoritative, so repeated pulls converge on server truth — a genuine product mismatch
// still fails truthfully after both cycles (nothing here can paper over a real defect), while a
// transient race (e.g. a pull landing before the other page's own in-flight POST) gets a second
// chance to resolve. The announcement (console.log + a "ws-fallback" annotation) is pushed BEFORE
// each force-close, matching this suite's existing precedent. After the final cycle, a failure is
// rethrown as a labeled error (with the original assertion failure preserved via `cause`) instead
// of a bare, unrelated-looking locator timeout.
const MAX_RECOVERY_ATTEMPTS = 2;

export const expectOrRecover = async (page: Page, label: string, assert: () => Promise<void>, routeHandle: WsRouteHandle): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    try {
      await assert();
      return;
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RECOVERY_ATTEMPTS) break; // recovery cycles exhausted

      console.log(
        `[fieldTest] ${label}: assertion did not arrive — force-closing the socket and recovering via Sync now (cycle ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`,
      );
      test.info().annotations.push({
        type: "ws-fallback",
        description: `${label}: recovery cycle ${attempt + 1} — forced socket close + Sync-now`,
      });

      await routeHandle.current?.close().catch(() => {}); // deterministically flips connected() false
      const syncNow = page.getByRole("button", { name: "Sync now" });
      await expect(syncNow).toBeVisible({ timeout: 15_000 });
      await syncNow.click();
    }
  }

  throw new Error(`${label}: assertion still failing after ${MAX_RECOVERY_ATTEMPTS} force-close+Sync-now recovery cycles`, { cause: lastError });
};

// WS is delivery sugar, not the correctness path (architecture.md §3) — this session has no
// periodic pull, so if a push is ever silently lost, the ONLY thing that recovers a live tab is
// the same user-visible "Sync now" affordance StatusChrome ships (session/useRoundSession.ts's
// own connect()+sync()). Used for the round's finalize — the one WS-arrival wait in this spec
// with enough elapsed real time and backend work (settleRound + the archive write) for a rare
// delivery hiccup to matter.
export const waitForFinalOrRecover = async (page: Page, routeHandle: WsRouteHandle): Promise<void> => {
  const finalHeading = page.getByRole("heading", { name: "Final results" });
  await expectOrRecover(page, "Final results", () => expect(finalHeading).toBeVisible({ timeout: 45_000 }), routeHandle);
};

// <select>s only, never getByLabel for the player pickers below — Playwright's getByLabel
// match text for a <label> wrapping a <select> includes the currently-DISPLAYED option's own
// text (e.g. a "Player 1" label reading "Player 1Ann" once Ann is picked), not just the
// label's literal text, so a later exact match against just "Player 1" would find nothing.
// getByRole's accessible-name computation for the CONTROL itself doesn't have this
// contamination — the combobox's own name stays cleanly "Player 1", excluding its own
// displayed option text.

// Games legibility arc (Tasks 1-6): AddGameForm's old "Kind" <select> is gone, replaced by a
// radio-card picker — each kind's radio carries its OWN accessible name via `aria-label`
// (domain's gameKindLabel: "Stroke play"/"Match play"/"Stableford"/"Four-ball"/"Skins"), not
// the surrounding label's visible text, so a plain role("radio", { name }).check() finds it
// directly. Not exported — every caller below is one of this file's own add-game helpers.
const pickGameKind = async (page: Page, label: string): Promise<void> => {
  await page.getByRole("radio", { name: label, exact: true }).check();
};

// singles-match's group renamed "Who's playing?", its players "Player 1"/"Player 2" (was
// "Player A"/"Player B") — no prior helper existed for singles (every spec drove it inline
// against the old select-based form); this is the one place that flow now lives.
export const addSinglesGame = async (page: Page, a: string, b: string): Promise<void> => {
  await pickGameKind(page, "Match play");
  await page.getByRole("combobox", { name: "Player 1", exact: true }).selectOption({ label: a });
  await page.getByRole("combobox", { name: "Player 2", exact: true }).selectOption({ label: b });
  await page.getByRole("button", { name: "Add game" }).click();
};

// Fourball's two sides are now "Team 1"/"Team 2" fieldsets (was "Side A"/"Side B" baked into
// the select's own name), each with its own "First player"/"Second player" selects — the SAME
// names in both groups, so each pair is scoped by its enclosing role("group", { name }) rather
// than a side-qualified select name.
export const addFourballGame = async (
  page: Page,
  sides: { readonly a1: string; readonly a2: string; readonly b1: string; readonly b2: string },
): Promise<void> => {
  await pickGameKind(page, "Four-ball");
  const team1 = page.getByRole("group", { name: "Team 1" });
  await team1.getByRole("combobox", { name: "First player", exact: true }).selectOption({ label: sides.a1 });
  await team1.getByRole("combobox", { name: "Second player", exact: true }).selectOption({ label: sides.a2 });
  const team2 = page.getByRole("group", { name: "Team 2" });
  await team2.getByRole("combobox", { name: "First player", exact: true }).selectOption({ label: sides.b1 });
  await team2.getByRole("combobox", { name: "Second player", exact: true }).selectOption({ label: sides.b2 });
  await page.getByRole("button", { name: "Add game" }).click();
};

// The checkbox group these two share was renamed "Who's in?" (was "Players").
export const addSkinsGame = async (page: Page, names: readonly string[]): Promise<void> => {
  await pickGameKind(page, "Skins");
  const group = page.getByRole("group", { name: "Who's in?" });
  for (const name of names) {
    await group.getByLabel(name, { exact: true }).check();
  }
  await page.getByRole("button", { name: "Add game" }).click();
};

// Same "Who's in?" checkbox-group shape as addSkinsGame above, stableford's own kind selected
// instead — M7 Task 8's termination-coverage addendum (fieldTest.spec.ts) is the one caller
// that needs a game requiring EVERY configured player's EVERY hole to resolve (unlike singles
// match's early-closeout path), so a partial card leaves it deliberately unresolved.
export const addStablefordGame = async (page: Page, names: readonly string[]): Promise<void> => {
  await pickGameKind(page, "Stableford");
  const group = page.getByRole("group", { name: "Who's in?" });
  for (const name of names) {
    await group.getByLabel(name, { exact: true }).check();
  }
  await page.getByRole("button", { name: "Add game" }).click();
};

// spec 2026-07-19 §2a/§2b: StandingsHeader's chips are plain disclosure buttons now (a tap
// toggles that game's own inline panel; no single chip is ever "the" active one), not tabs — so
// this reads role="button", not "tab". The chip text is still the CONCATENATION of two adjacent
// <span>s (title, line) with no separating whitespace in the DOM — using the computed
// accessible NAME (which may insert its own separator depending on the browser's accname
// algorithm) would be a fragile way to assert on it. `.filter({ hasText })` + raw
// textContent-based matchers sidestep that.
export const chip = (page: Page, titlePrefix: string) => page.getByRole("button").filter({ hasText: titlePrefix });

// The one number a player states about themselves (spec 2026-07-29 §2/§9), on BOTH doors onto a
// card: CreateRoundPage and JoinRoundPage render the identical label, because starting a round is
// joining it as the host. Shared rather than inlined at each of its call sites for a reason this
// arc learned the hard way: the label this replaced ("Strokes you get here") was hard-coded at
// eight sites across four specs, and renaming it is invisible to `tsc` — every one of those
// `getByLabel(...)` calls kept compiling and would have resolved NOTHING at the live gate. One
// copy, checked against the JSX once.
export const normallyShootsField = (page: Page): Locator => page.getByLabel("What do you normally shoot, relative to par?", { exact: true });

// Every game chip (StandingsHeader.tsx) carries `aria-expanded` — the ONE attribute that
// distinguishes it from every other button on a round page (Add game/Sync now/Finalize
// round/etc. carry none), the same discriminator apps/web/src/watch/WatchPage.test.tsx's own
// component test already uses (`button.hasAttribute("aria-expanded")`) to tell "a game chip"
// apart from any other button structurally. Used where a spec needs to count chips rather than
// name one — a bare `getByRole("button")` would also match every other button on the page.
export const gameChips = (page: Page): Locator => page.locator("button[aria-expanded]");

// Opens a game's own inline panel via ONE chip tap (StandingsHeader: a tap toggles the panel —
// no dialog, no tabs, no second tap) and returns its region locator (GamePanel.tsx:
// role="region", aria-label={`${title} standings`}). The one-tap-panel access pattern every
// reconciled strokes-line assertion goes through.
export const openGamePanel = async (page: Page, titlePrefix: string): Promise<Locator> => {
  await chip(page, titlePrefix).click();
  const panel = page.getByRole("region", { name: /standings$/ }).filter({ hasText: titlePrefix });
  await expect(panel).toBeVisible();
  return panel;
};
