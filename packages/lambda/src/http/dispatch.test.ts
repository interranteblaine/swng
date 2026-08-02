import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { cardId, courseId, crewId, deviceId, fixtureLinks, fixtureWhite, golferId, opId, placeholderName } from "@swng/domain";
import type { AccountClaims, AccountVerifier, Logger } from "@swng/application";
import {
  abandonRound,
  addGame,
  createCapturingBroadcast,
  createCourse,
  createCrew,
  createFixedClock,
  createInMemoryCardStore,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
  createSeason,
  createSequentialIds,
  finalizeRound,
  getCourse,
  getCrew,
  getGolfer,
  getMyCourseRecord,
  getMyGolfer,
  getMyLiveRounds,
  getMyRecord,
  getMyRounds,
  getRoundArchive,
  getSeasonStandings,
  getShareLink,
  joinCrewByInvite,
  joinRound,
  leaveCrew,
  leaveRound,
  listMyCrews,
  listSeasons,
  mintCrewInvite,
  mintParticipantToken,
  peekCrewInvite,
  peekRound,
  readEvents,
  recordScore,
  removeCrewMember,
  searchCourses,
  seedCard,
  setHoles,
  setPlayedAt,
  setStrokes,
  startRound,
  supersedeCard,
  terminateGame,
  transferOrganizer,
  updateCrew,
  updateMyGolfer,
  updateSeason,
} from "@swng/application";
import {
  addGameResponseSchema,
  createCourseResponseSchema,
  createCrewResponseSchema,
  createSeasonResponseSchema,
  errorResponseSchema,
  eventsResponseSchema,
  finalizeRoundResponseSchema,
  getCourseResponseSchema,
  getCrewResponseSchema,
  getGolferResponseSchema,
  getMeResponseSchema,
  getMyCourseRecordResponseSchema,
  getMyLiveRoundsResponseSchema,
  getMyRecordResponseSchema,
  getMyRoundsResponseSchema,
  getRoundArchiveResponseSchema,
  golferResponseSchema,
  joinCrewResponseSchema,
  joinRoundResponseSchema,
  leaveCrewResponseSchema,
  listMyCrewsResponseSchema,
  listSeasonsResponseSchema,
  mintCrewInviteResponseSchema,
  peekCrewInviteResponseSchema,
  peekRoundResponseSchema,
  recordScoreResponseSchema,
  searchCoursesResponseSchema,
  seasonStandingsResponseSchema,
  setHolesResponseSchema,
  setPlayedAtResponseSchema,
  setStrokesResponseSchema,
  shareLinkResponseSchema,
  startRoundResponseSchema,
  supersedeCardResponseSchema,
  terminateGameResponseSchema,
} from "@swng/contracts";
import { createHmacTokenIssuer } from "../auth/hmacTokenIssuer.js";
import { buildRoutes } from "./routes.js";
import type { UseCases } from "./routes.js";
import { createDispatcher } from "./dispatch.js";

// Builds just enough of an APIGatewayProxyEventV2 (HTTP API payload format 2.0) for the
// dispatcher to route/authorize/parse against — every field the dispatcher actually reads.
// `rawBody` bypasses the JSON.stringify(body) convenience for the one test that needs to
// send bytes that aren't valid JSON at all.
const makeEvent = (opts: {
  method: string;
  path: string;
  body?: unknown;
  rawBody?: string;
  token?: string;
  query?: Record<string, string>;
}): APIGatewayProxyEventV2 => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: opts.path,
  rawQueryString: "",
  headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  queryStringParameters: opts.query,
  requestContext: {
    accountId: "test-account",
    apiId: "test-api",
    domainName: "test.execute-api.us-east-1.amazonaws.com",
    domainPrefix: "test",
    http: { method: opts.method, path: opts.path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    requestId: "req-1",
    routeKey: "$default",
    stage: "$default",
    time: "07/Jul/2026:00:00:00 +0000",
    timeEpoch: 0,
  },
  body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  isBase64Encoded: false,
});

// The dispatcher always returns a structured result (dispatch.ts never returns a bare
// string) — this helper spares every assertion below a repeated cast.
const asStructured = (result: Awaited<ReturnType<ReturnType<typeof createDispatcher>>>): APIGatewayProxyStructuredResultV2 =>
  result as APIGatewayProxyStructuredResultV2;

// Accounts-only identity (spec §3): POST /rounds and POST /rounds/join are "golfer"-gated now, so
// even the golden-path/course-routes/share suites must present a Bearer to start or join a round.
// This default verifier maps any bearer string to a sub of the same value — ensureGolfer then mints
// or returns the caller's golfer on first touch — so a test that just needs SOME signed-in caller
// passes `token: "sub-ann"` and asserts against the RESPONSE golferId (never a hardcoded id). The
// golfer/terminate/crew/snapshot/token suites below pass their own stubVerifier instead (mapping
// golferBearer(account) = "golfer-token-<sub>"), sharing every other fake.
const subVerifier: AccountVerifier = {
  verify: async (bearer: string): Promise<AccountClaims> => ({ sub: bearer }),
};

// `verifier` defaults to subVerifier (this file's golden-path/course-routes/share suites present a
// plain "sub-<x>" bearer); the golfer/terminate describe blocks below pass their own stubVerifier
// instead, sharing every other fake.
// Course-cards spec §4: StartRound resolves a card by REFERENCE now — setup seeds one lineage
// (fixtureLinks, under DEFAULT_COURSE) into a fresh CardStore per test and hands the reference
// back so every `/rounds` POST body below just passes it through instead of authoring a card.
const DEFAULT_COURSE = { courseId: courseId("default-course"), cardId: cardId("default-card") };

const setup = async (verifier: AccountVerifier = subVerifier, logger: Logger = createNullLogger()) => {
  const snapshots = createInMemorySnapshotStore();
  const journal = createInMemoryJournal(snapshots);
  const store = createInMemoryRoundStore();
  const cardStore = createInMemoryCardStore();
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();
  const projectionStore = createInMemoryProjectionStore();
  const broadcast = createCapturingBroadcast();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("id");
  const tokens = createHmacTokenIssuer({ secret: "dispatch-test-secret", clock });
  const cardRecord = await seedCard(cardStore, DEFAULT_COURSE.courseId, DEFAULT_COURSE.cardId, fixtureLinks);
  const course = { courseId: cardRecord.courseId, cardId: cardRecord.cardId };

  const useCases: UseCases = {
    startRound: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    joinRound: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    addGame: addGame({ journal, broadcast, clock, ids }),
    recordScore: recordScore({ journal, broadcast }),
    finalizeRound: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    abandonRound: abandonRound({ journal, broadcast, clock, ids, projectionStore, logger }),
    leaveRound: leaveRound({ journal, broadcast, clock, ids }),
    setStrokes: setStrokes({ journal, broadcast, clock, ids }),
    setPlayedAt: setPlayedAt({ journal, broadcast, clock, ids }),
    setHoles: setHoles({ journal, broadcast, clock, ids }),
    readEvents: readEvents({ journal }),
    peekRound: peekRound({ journal, store }),
    getShareLink: getShareLink({ tokens }),
    getRoundArchive: getRoundArchive({ snapshots }),
    mintParticipantToken: mintParticipantToken({ journal, golferStore, tokens, store }),
    createCourse: createCourse({ cardStore, golferStore, idGenerator: ids, clock, logger }),
    supersedeCard: supersedeCard({ cardStore, golferStore, idGenerator: ids, clock, logger }),
    getCourse: getCourse({ cardStore }),
    searchCourses: searchCourses({ cardStore }),
    terminateGame: terminateGame({ journal, broadcast, clock, ids }),
    getMyGolfer: getMyGolfer({ golferStore, idGenerator: ids }),
    updateMyGolfer: updateMyGolfer({ golferStore, idGenerator: ids }),
    getMyRecord: getMyRecord({ golferStore, projectionStore }),
    getMyCourseRecord: getMyCourseRecord({ golferStore, projectionStore }),
    getMyRounds: getMyRounds({ golferStore, projectionStore }),
    getMyLiveRounds: getMyLiveRounds({ golferStore, projectionStore, journal }),
    getGolfer: getGolfer({ golferStore, projectionStore }),
    createCrew: createCrew({ crewStore, golferStore, ids, clock }),
    getCrew: getCrew({ crewStore, golferStore }),
    listMyCrews: listMyCrews({ crewStore, golferStore }),
    mintCrewInvite: mintCrewInvite({ crewStore, golferStore, tokenIssuer: tokens, clock }),
    peekCrewInvite: peekCrewInvite({ crewStore, tokenIssuer: tokens, clock }),
    joinCrewByInvite: joinCrewByInvite({ crewStore, golferStore, tokenIssuer: tokens, clock }),
    createSeason: createSeason({ crewStore, golferStore, ids, clock }),
    listSeasons: listSeasons({ crewStore, golferStore }),
    updateSeason: updateSeason({ crewStore, golferStore }),
    updateCrew: updateCrew({ crewStore, golferStore }),
    getSeasonStandings: getSeasonStandings({ crewStore, golferStore, snapshots, projectionStore }),
    leaveCrew: leaveCrew({ crewStore, golferStore }),
    removeCrewMember: removeCrewMember({ crewStore, golferStore }),
    transferOrganizer: transferOrganizer({ crewStore, golferStore }),
  };

  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, verifier, logger);
  return { dispatcher, tokens, course, cardStore };
};

describe("createDispatcher — HTTP-shaped golden path", () => {
  it("drives create -> join -> add game -> score -> duplicate re-send -> finalize", async () => {
    const { dispatcher } = await setup();

    const startResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: "/rounds",
          token: "sub-ann",
          body: { course: DEFAULT_COURSE, host: { tee: "white" } },
        }),
      ),
    );
    expect(startResp.statusCode).toBe(201);
    const started = startRoundResponseSchema.parse(JSON.parse(startResp.body!));

    const joinResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: "/rounds/join", token: "sub-bo", body: { code: started.joinCode, tee: "white" } }),
      ),
    );
    expect(joinResp.statusCode).toBe(201);
    const joined = joinRoundResponseSchema.parse(JSON.parse(joinResp.body!));

    // The golden deck's own strokes, typed onto the roster over the wire (spec 2026-07-30 §2):
    // Ann 3, Bo 0 — the numbers stableford.test.ts's 10/17 lines are built on. Bo joins on 0.
    const setStrokesResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/rounds/${started.roundId}/strokes`,
          token: started.token,
          body: { golferId: started.golferId, strokes: 3 },
        }),
      ),
    );
    expect(setStrokesResp.statusCode).toBe(200);

    const addGameResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/rounds/${started.roundId}/games`,
          token: started.token,
          body: { game: { kind: "stableford", players: [started.golferId, joined.golferId] } },
        }),
      ),
    );
    expect(addGameResp.statusCode).toBe(201);
    addGameResponseSchema.parse(JSON.parse(addGameResp.body!));

    // M2's golden stableford deck (domain/src/scoring/stableford.test.ts): Ann's h4 is a
    // pickup. A game only resolves once every player's card is complete (else finalize
    // throws game-unresolved), so the golden path scores the full 9 holes for both golfers
    // — not just enough to exercise one recordScore call.
    const record = (opts: { token: string; golferId: string; hole: number; result: unknown; opIdSuffix: string; wallMs: number }) =>
      dispatcher(
        makeEvent({
          method: "POST",
          path: `/rounds/${started.roundId}/scores`,
          token: opts.token,
          body: {
            golferId: opts.golferId,
            hole: opts.hole,
            result: opts.result,
            opId: opId(`op-${opts.opIdSuffix}`),
            hlc: { wallMs: opts.wallMs, counter: 0, deviceId: deviceId("test-phone") },
          },
        }),
      );

    const annScores: readonly (number | "picked-up")[] = [5, 6, 3, "picked-up", 5, 4, 5, 6, 5];
    const boScores: readonly number[] = [4, 4, 3, 5, 5, 3, 4, 5, 4];
    const toResult = (score: number | "picked-up") => (score === "picked-up" ? { kind: "picked-up" } : { kind: "strokes", strokes: score });

    let wallMs = 5_000;
    let firstScoreResp: APIGatewayProxyStructuredResultV2 | undefined;
    for (let hole = 1; hole <= 9; hole += 1) {
      const resp = asStructured(
        await record({
          token: started.token,
          golferId: started.golferId,
          hole,
          result: toResult(annScores[hole - 1]!),
          opIdSuffix: `ann-h${hole}`,
          wallMs: wallMs++,
        }),
      );
      if (hole === 1) firstScoreResp = resp;
      else expect(resp.statusCode).toBe(200);
    }
    expect(firstScoreResp!.statusCode).toBe(200);
    const scored = recordScoreResponseSchema.parse(JSON.parse(firstScoreResp!.body!));
    expect(scored).toEqual({ seq: expect.any(Number), duplicate: false });

    for (let hole = 1; hole <= 9; hole += 1) {
      const resp = asStructured(
        await record({
          token: joined.token,
          golferId: joined.golferId,
          hole,
          result: toResult(boScores[hole - 1]!),
          opIdSuffix: `bo-h${hole}`,
          wallMs: wallMs++,
        }),
      );
      expect(resp.statusCode).toBe(200);
    }

    // Exact re-send of Ann's hole-1 opId is a no-op success, not an error.
    const dupResp = asStructured(
      await record({ token: started.token, golferId: started.golferId, hole: 1, result: toResult(annScores[0]!), opIdSuffix: "ann-h1", wallMs: 1 }),
    );
    expect(dupResp.statusCode).toBe(200);
    expect(recordScoreResponseSchema.parse(JSON.parse(dupResp.body!))).toEqual({ duplicate: true });

    const eventsResp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "0" } })),
    );
    expect(eventsResp.statusCode).toBe(200);
    const events = JSON.parse(eventsResp.body!) as { events: readonly unknown[]; nextSeq: number };
    expect(events.events.length).toBeGreaterThan(0);

    const finalizeResp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: started.token })),
    );
    expect(finalizeResp.statusCode).toBe(200);
    const finalized = finalizeRoundResponseSchema.parse(JSON.parse(finalizeResp.body!));
    // The M2 golden numbers (stableford.test.ts / roundSlice.test.ts), reproduced over the
    // full HTTP-shaped dispatcher.
    expect(finalized.results).toEqual([
      expect.objectContaining({
        kind: "stableford",
        points: [
          { golferId: started.golferId, points: 10 },
          { golferId: joined.golferId, points: 17 },
        ],
      }),
    ]);
  });

  // spec 2026-07-30 §2: any participant sets any participant's strokes (score-for-anyone), so the
  // FIRST participant's own token authors a set whose SUBJECT is the SECOND participant.
  it("POST /rounds/{roundId}/strokes: participant auth, 200, appends the set", async () => {
    const { dispatcher } = await setup();

    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
          ),
        ).body!,
      ),
    );
    const joined = joinRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds/join", token: "sub-bo", body: { code: started.joinCode, tee: "white" } }),
          ),
        ).body!,
      ),
    );

    const resp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/rounds/${started.roundId}/strokes`,
          token: started.token,
          body: { golferId: joined.golferId, strokes: 13 },
        }),
      ),
    );
    expect(resp.statusCode).toBe(200);
    const parsed = setStrokesResponseSchema.parse(JSON.parse(resp.body!));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({ kind: "participant-strokes-set", golferId: joined.golferId, strokes: 13 });

    const eventsResp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "0" } })),
    );
    expect(eventsResp.statusCode).toBe(200);
    const events = eventsResponseSchema.parse(JSON.parse(eventsResp.body!));
    expect(events.events.some((event) => event.kind === "participant-strokes-set")).toBe(true);
  });

  // spec 2026-08-01 §3b/§4: a round's played date, corrected — a round-level fact (no SUBJECT,
  // unlike setStrokes above), so any participant's own token is enough.
  it("POST /rounds/{roundId}/played-at: participant auth, 200, appends the set", async () => {
    const { dispatcher } = await setup();

    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
          ),
        ).body!,
      ),
    );

    const resp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/rounds/${started.roundId}/played-at`,
          token: started.token,
          body: { playedAtMs: 1_700_000_000_000 },
        }),
      ),
    );
    expect(resp.statusCode).toBe(200);
    const parsed = setPlayedAtResponseSchema.parse(JSON.parse(resp.body!));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({ kind: "round-played-at-set", playedAtMs: 1_700_000_000_000 });

    const eventsResp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "0" } })),
    );
    expect(eventsResp.statusCode).toBe(200);
    const events = eventsResponseSchema.parse(JSON.parse(eventsResp.body!));
    expect(events.events.some((event) => event.kind === "round-played-at-set")).toBe(true);
  });

  // spec 2026-08-02 §3b: the holes a round set out to play, corrected — same round-level-fact
  // shape as played-at above (no SUBJECT), so any participant's own token is enough.
  it("POST /rounds/{roundId}/holes: participant auth, 200, appends the set", async () => {
    const { dispatcher } = await setup();

    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
          ),
        ).body!,
      ),
    );

    const resp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/rounds/${started.roundId}/holes`,
          token: started.token,
          body: { holes: "front" },
        }),
      ),
    );
    expect(resp.statusCode).toBe(200);
    const parsed = setHolesResponseSchema.parse(JSON.parse(resp.body!));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({ kind: "round-holes-set", holes: "front" });

    const eventsResp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "0" } })),
    );
    expect(eventsResp.statusCode).toBe(200);
    const events = eventsResponseSchema.parse(JSON.parse(eventsResp.body!));
    expect(events.events.some((event) => event.kind === "round-holes-set")).toBe(true);
  });

  it("rejects a request with no bearer token on a participant route — 401", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/rounds/some-round/finalize" })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("rejects a request with a garbage bearer token on a participant route — 401", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/rounds/some-round/finalize", token: "not-a-real-token" })),
    );
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("rejects a token minted for round X used on round Y's path — 403 token-round-mismatch", async () => {
    const { dispatcher } = await setup();

    const roundX = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
        ).body!,
      ),
    );
    const roundY = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
        ).body!,
      ),
    );

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/rounds/${roundY.roundId}/finalize`, token: roundX.token })),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "token-round-mismatch" });
  });

  it("rejects a zod-invalid body — 400 with errorResponseSchema shape", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE } })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("rejects a body that isn't valid JSON at all — 400 with errorResponseSchema shape", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", rawBody: "{not valid json" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("404s an unmatched path, shaped through the same error envelope as every other error", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/not-a-real-route" })));
    expect(resp.statusCode).toBe(404);
    // The not-found body is hand-built in dispatch.ts, but it must still round-trip through
    // errorResponseSchema — one error-shaping site (errorMapping.ts), not a second one that
    // only the 404 path uses.
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-found" });
  });

  it("404s a matched path with the wrong method", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "DELETE", path: "/rounds" })));
    expect(resp.statusCode).toBe(404);
  });

  it("maps a malformed percent-escape in the path to a structured 400, not a raw throw", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/%zz/scores" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("rejects GET events with a non-integer ?since= — 400 invalid-request, not a silently-empty page", async () => {
    const { dispatcher } = await setup();
    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
          ),
        ).body!,
      ),
    );

    const resp = asStructured(
      await dispatcher(
        makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "abc" } }),
      ),
    );
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  // Papercut 2 (M9 hardening): an EMPTY ?since= (a client-built URL that stringifies an unset
  // value as "") must parse as absent (read from the start), not as an explicit "0" that a
  // stricter check might reject or mishandle differently from a truly-absent param.
  it("treats an empty ?since= the same as an absent one — reads from the start, not a 400", async () => {
    const { dispatcher } = await setup();
    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
          ),
        ).body!,
      ),
    );

    const emptyResp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "" } })),
    );
    const absentResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token })));
    expect(emptyResp.statusCode).toBe(200);
    expect(JSON.parse(emptyResp.body!)).toEqual(JSON.parse(absentResp.body!));
  });
});

// Course-cards spec §4: writes (POST /courses, PUT /courses/{courseId}) are "golfer"-gated —
// enteredBy derives from the account — while the two reads (GET) stay identity-free. The write
// tests present a plain "sub-<x>" bearer (subVerifier maps it to a sub; ensureGolfer mints the
// author on first touch).
const courseInputTee = { name: fixtureWhite.name, rating: fixtureWhite.rating, slope: fixtureWhite.slope, holes: fixtureWhite.holes };
describe("createDispatcher — course routes + peek (course-cards spec)", () => {
  it("drives create -> supersede (add a second tee) -> get -> search over HTTP", async () => {
    const { dispatcher } = await setup();

    const createResp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/courses", token: "sub-ann", body: { name: "Casa Verde GC", teeSets: [courseInputTee] } })),
    );
    expect(createResp.statusCode).toBe(201);
    const created = createCourseResponseSchema.parse(JSON.parse(createResp.body!));
    expect(created.course.card.courseName).toBe("Casa Verde GC");
    const keptTeeId = created.course.card.teeSets[0]!.teeId!;

    const blueTee = { ...courseInputTee, name: "blue", rating: 73.1, slope: 132 };
    const supersedeResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "PUT",
          path: `/courses/${created.course.courseId}`,
          token: "sub-ann",
          body: { name: "Casa Verde GC", teeSets: [{ ...courseInputTee, teeId: keptTeeId }, blueTee], supersedes: created.course.cardId },
        }),
      ),
    );
    expect(supersedeResp.statusCode).toBe(200);
    const superseded = supersedeCardResponseSchema.parse(JSON.parse(supersedeResp.body!));
    expect(superseded.course.card.teeSets.map((tee) => tee.name).sort()).toEqual(["blue", "white"]);
    // The kept tee kept its id; the new tee got a fresh one; the card itself is new.
    expect(superseded.course.card.teeSets.find((tee) => tee.name === "white")?.teeId).toBe(keptTeeId);
    expect(superseded.course.cardId).not.toBe(created.course.cardId);

    const getResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/courses/${created.course.courseId}` })));
    expect(getResp.statusCode).toBe(200);
    const fetched = getCourseResponseSchema.parse(JSON.parse(getResp.body!));
    expect(fetched.course.cardId).toBe(superseded.course.cardId); // GET serves the CURRENT (superseded) card

    const searchResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/courses", query: { query: "Casa" } })));
    expect(searchResp.statusCode).toBe(200);
    const searched = searchCoursesResponseSchema.parse(JSON.parse(searchResp.body!));
    expect(searched.courses.map((c) => c.name)).toEqual(["Casa Verde GC"]);
    expect(searched.courses[0]?.holeCount).toBe(9);
  });

  it("409s a PUT /courses/{courseId} whose supersedes is stale — card-superseded", async () => {
    const { dispatcher } = await setup();
    const createResp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/courses", token: "sub-ann", body: { name: "Casa Verde GC", teeSets: [courseInputTee] } })),
    );
    const created = createCourseResponseSchema.parse(JSON.parse(createResp.body!));

    const resp = asStructured(
      await dispatcher(
        makeEvent({ method: "PUT", path: `/courses/${created.course.courseId}`, token: "sub-ann", body: { name: "Casa Verde GC", teeSets: [courseInputTee], supersedes: "stale-card" } }),
      ),
    );
    expect(resp.statusCode).toBe(409);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "card-superseded" });
  });

  it("401s a POST /courses with no bearer — the write tier is golfer-gated now", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/courses", body: { name: "Casa Verde GC", teeSets: [courseInputTee] } })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("404s GET /courses/{courseId} for an unknown id — course-not-found", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/courses/does-not-exist" })));
    expect(resp.statusCode).toBe(404);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "course-not-found" });
  });

  it("400s GET /courses with no ?query= — invalid-request, never an empty-string search", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/courses" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  // Papercut 2 (M9 hardening): an EMPTY ?limit= must parse as absent (searchCourses' own
  // DEFAULT_LIMIT of 10), not as an explicit "0" — which Number("") coerces to, clamping down
  // to MIN_LIMIT (1) and silently truncating the result set before this fix.
  it("treats an empty ?limit= as absent — the default limit, not a clamped-to-1 result set", async () => {
    const { dispatcher } = await setup();
    // "Zeta" (not "Fixture"): setup() now also seeds DEFAULT_COURSE ("Fixture Links", the
    // course-cards reference StartRound resolves) into the SAME cardStore this search hits — a
    // "Fixture"-prefixed name here would pick that up as an unwanted 4th result.
    for (const name of ["Zeta Alpha", "Zeta Beta", "Zeta Gamma"]) {
      const created = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/courses", token: "sub-ann", body: { name, teeSets: [courseInputTee] } })));
      expect(created.statusCode).toBe(201);
    }

    const emptyLimitResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/courses", query: { query: "Zeta", limit: "" } })));
    expect(emptyLimitResp.statusCode).toBe(200);
    const searched = searchCoursesResponseSchema.parse(JSON.parse(emptyLimitResp.body!));
    // Before the fix, limit="" parsed as 0 -> clamped to MIN_LIMIT (1) — only one of the three
    // fixtures would come back.
    expect(searched.courses).toHaveLength(3);
  });

  it("400s a zod-invalid POST /courses body — invalid-request", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/courses", token: "sub-ann", body: { name: "Casa Verde GC" } })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("peeks a live round by join code — courseName + tee summaries, over HTTP", async () => {
    const { dispatcher } = await setup();
    const startResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
      ),
    );
    const started = startRoundResponseSchema.parse(JSON.parse(startResp.body!));

    const peekResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/peek", query: { code: started.joinCode } })));
    expect(peekResp.statusCode).toBe(200);
    const peeked = peekRoundResponseSchema.parse(JSON.parse(peekResp.body!));
    expect(peeked.courseName).toBe(fixtureLinks.courseName);
  });

  it("400s GET /rounds/peek with no ?code= — invalid-request", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/peek" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("404s GET /rounds/peek with an unknown join code — bad-join-code, not a 401", async () => {
    const { dispatcher } = await setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/peek", query: { code: "ZZZZZZ" } })));
    expect(resp.statusCode).toBe(404);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "bad-join-code" });
  });

  // The invariant routes.ts's own comment documents: GET /rounds/peek (2 path segments) must
  // never be dispatched as GET /rounds/{roundId}/events (3 segments) with roundId bound to
  // the literal string "peek". Proven here by calling peek with NO bearer token: the events
  // route is `auth: "participant"` and would 401 without one (dispatch.ts's auth gate runs
  // BEFORE any handler, so a wrong match would surface as 401, never reaching peekRound at
  // all) — peek succeeding with 200 and the peekRound response shape is the proof it took
  // the unauthenticated 2-segment route, not the participant-gated 3-segment one.
  it("GET /rounds/peek never binds {roundId}=\"peek\" against the /rounds/{roundId}/events template", async () => {
    const { dispatcher } = await setup();
    const startResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
      ),
    );
    const started = startRoundResponseSchema.parse(JSON.parse(startResp.body!));

    // No `token` — if this were (mis)matched to the participant-gated events route it would
    // 401 (invalid-token), never reach peekRound.
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/peek", query: { code: started.joinCode } })));
    expect(resp.statusCode).toBe(200);
    const peeked = peekRoundResponseSchema.parse(JSON.parse(resp.body!));
    expect(Object.keys(peeked).sort()).toEqual(["courseName", "playedAt", "teeSets"]); // playedAt: spec 2026-08-01 §4b, replacing the old createdAt
  });
});

// M7 Task 4: the "golfer" auth tier's own mechanics (missing/garbage/valid token), exercised
// against a tiny hand-built route table rather than buildRoutes' real one — the same way
// TokenIssuer's own behavior is tested in isolation from any specific route. The REAL golfer
// routes buildRoutes now declares (M7 Task 5) get their own suite further down
// (`describe("createDispatcher — golfer + terminate routes (M7 Task 5)")`).
describe("createDispatcher — golfer auth tier (M7 Task 4)", () => {
  const VALID_TOKEN = "valid-golfer-token";
  const account: AccountClaims = { sub: "cognito-sub-123" };

  const stubVerifier: AccountVerifier = {
    verify: async (bearer: string) => {
      if (bearer !== VALID_TOKEN) throw new Error("stubVerifier: unknown token");
      return account;
    },
  };

  const golferRoute = {
    method: "GET" as const,
    path: "/me",
    auth: "golfer" as const,
    successStatus: 200 as const,
    handler: async (ctx: { account?: AccountClaims }) => ({ sub: ctx.account?.sub }),
  };

  const setupGolferTier = () => {
    const tokens = createHmacTokenIssuer({ secret: "unused-for-golfer-tier", clock: createFixedClock(1_000) });
    return createDispatcher([golferRoute], tokens, stubVerifier, createNullLogger());
  };

  it("401s a golfer-tier route with no bearer token at all", async () => {
    const dispatcher = setupGolferTier();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me" })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("401s a golfer-tier route with a garbage bearer token the verifier rejects", async () => {
    const dispatcher = setupGolferTier();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: "not-a-real-token" })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("hands {sub} to the handler for a token the verifier accepts — sub only, no email", async () => {
    const dispatcher = setupGolferTier();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: VALID_TOKEN })));
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body!)).toEqual({ sub: account.sub });
  });
});

// M7 Task 5: the real routes — POST .../terminate (participant-gated) and the four "golfer"
// routes buildRoutes now declares. `golferBearer` stands in for a real Cognito ID token: any
// string the caller chose to mint one of the three fixed accounts below; an unrecognized
// bearer is what a participant round token (or plain garbage) looks like to this verifier,
// driving the SAME 401 a real CognitoVerifier rejection would (dispatch.ts's catch collapses
// every verifier failure to invalid-token) — the REAL error code, not an invented one (M6
// lesson).
describe("createDispatcher — golfer + terminate routes (M7 Task 5)", () => {
  const ann: AccountClaims = { sub: "cognito-sub-ann" };
  const bo: AccountClaims = { sub: "cognito-sub-bo" };
  const cal: AccountClaims = { sub: "cognito-sub-cal" };
  const golferBearer = (account: AccountClaims): string => `golfer-token-${account.sub}`;

  const stubVerifier: AccountVerifier = {
    verify: async (bearer: string) => {
      const account = [ann, bo, cal].find((candidate) => golferBearer(candidate) === bearer);
      if (!account) throw new Error("stubVerifier: unknown token");
      return account;
    },
  };

  const setupGolfer = () => setup(stubVerifier);

  describe("terminate", () => {
    it("terminates the sole unresolved game under participant auth, then finalize succeeds over HTTP", async () => {
      const { dispatcher } = await setupGolfer();

      const started = startRoundResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({ method: "POST", path: "/rounds", token: golferBearer(ann), body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
            ),
          ).body!,
        ),
      );

      const addGameResp = asStructured(
        await dispatcher(
          makeEvent({
            method: "POST",
            path: `/rounds/${started.roundId}/games`,
            token: started.token,
            body: { game: { kind: "stableford", players: [started.golferId] } },
          }),
        ),
      );
      const added = addGameResponseSchema.parse(JSON.parse(addGameResp.body!));

      // Nobody scores — finalize must fail until the game is terminated.
      const blockedResp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: started.token })),
      );
      expect(blockedResp.statusCode).toBe(409);
      expect(errorResponseSchema.parse(JSON.parse(blockedResp.body!))).toMatchObject({ code: "game-unresolved" });

      const terminateResp = asStructured(
        await dispatcher(
          makeEvent({ method: "POST", path: `/rounds/${started.roundId}/games/${added.gameId}/terminate`, token: started.token }),
        ),
      );
      expect(terminateResp.statusCode).toBe(200);
      terminateGameResponseSchema.parse(JSON.parse(terminateResp.body!));

      const finalizeResp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: started.token })),
      );
      expect(finalizeResp.statusCode).toBe(200);
      const finalized = finalizeRoundResponseSchema.parse(JSON.parse(finalizeResp.body!));
      expect(finalized.results).toHaveLength(0); // the terminated game never produced a result
    });

    it("404s terminate for a gameId never added to this round — unknown-game, the REAL error code", async () => {
      const { dispatcher } = await setupGolfer();

      const started = startRoundResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({ method: "POST", path: "/rounds", token: golferBearer(ann), body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
            ),
          ).body!,
        ),
      );

      const resp = asStructured(
        await dispatcher(
          makeEvent({ method: "POST", path: `/rounds/${started.roundId}/games/never-added/terminate`, token: started.token }),
        ),
      );
      expect(resp.statusCode).toBe(404);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "unknown-game" });
    });
  });

  it("401s GET /me — a golfer-tier route — given a round-scoped participant token as the bearer", async () => {
    const { dispatcher } = await setupGolfer();

    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds", token: golferBearer(ann), body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
          ),
        ).body!,
      ),
    );

    // started.token is a real, valid PARTICIPANT token — but the stub verifier (standing in
    // for CognitoVerifier) doesn't recognize it as any of its own golfer bearers.
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: started.token })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("401s GET /me — a golfer-tier route — given a garbage bearer token", async () => {
    const { dispatcher } = await setupGolfer();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: "totally-not-a-real-token" })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  // Accounts-only identity spec §2 (controller ruling — DELIBERATELY reverses the M7 "GET /me never
  // creates" this test used to pin): GET /me now MINTS on first touch (placeholderName(sub) +
  // namePlaceholder true), and a second GET returns the SAME minted golfer. PUT /me with a real
  // name renames it in place and drops the flag. (Claiming is gone — there are no ghosts to claim.)
  it("GET /me (mints, same on re-get) -> PUT /me (renames, drops the placeholder flag)", async () => {
    const { dispatcher } = await setupGolfer();

    const firstGet = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: golferBearer(ann) })));
    expect(firstGet.statusCode).toBe(200);
    const firstGolfer = getMeResponseSchema.parse(JSON.parse(firstGet.body!)).golfer;
    expect(firstGolfer?.name).toBe(placeholderName(ann.sub));
    expect(firstGolfer?.namePlaceholder).toBe(true);

    const secondGet = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: golferBearer(ann) })));
    expect(secondGet.statusCode).toBe(200);
    expect(getMeResponseSchema.parse(JSON.parse(secondGet.body!)).golfer?.golferId).toBe(firstGolfer?.golferId); // same minted golfer, not a second row

    const putResp = asStructured(
      await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(ann), body: { name: "Ann Golfer" } })),
    );
    expect(putResp.statusCode).toBe(200);
    const created = golferResponseSchema.parse(JSON.parse(putResp.body!));
    expect(created.golfer.name).toBe("Ann Golfer");
    expect(created.golfer.golferId).toBe(firstGolfer?.golferId); // renamed in place — the mint's own id
    expect(created.golfer).not.toHaveProperty("namePlaceholder"); // real name dropped the flag

    const thirdGet = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: golferBearer(ann) })));
    expect(thirdGet.statusCode).toBe(200);
    const fetched = getMeResponseSchema.parse(JSON.parse(thirdGet.body!));
    expect(fetched.golfer?.golferId).toBe(created.golfer.golferId);
    expect(fetched.golfer).not.toHaveProperty("namePlaceholder");
  });

  it("GET /me/record returns empty metrics and an empty history for a golfer who has never played a finalized round", async () => {
    const { dispatcher } = await setupGolfer();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me/record", token: golferBearer(ann) })));
    expect(resp.statusCode).toBe(200);
    expect(getMyRecordResponseSchema.parse(JSON.parse(resp.body!))).toEqual({
      metrics: { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, averageHistory: [], bests: {}, milestones: [] },
      history: [],
    });
  });

  // Analytics spec 2026-07-21 §4: GET /me/courses/{courseId}/record — the SAME get-or-nothing
  // idiom as GET /me/record just above, filtered to one course.
  describe("GET /me/courses/{courseId}/record", () => {
    it("returns rounds: 0 for a golfer who has never played a finalized round at this course — call-through to getMyCourseRecord", async () => {
      const { dispatcher } = await setupGolfer();
      const resp = asStructured(
        await dispatcher(makeEvent({ method: "GET", path: `/me/courses/${DEFAULT_COURSE.courseId}/record`, token: golferBearer(ann) })),
      );
      expect(resp.statusCode).toBe(200);
      expect(getMyCourseRecordResponseSchema.parse(JSON.parse(resp.body!))).toEqual({ courseId: DEFAULT_COURSE.courseId, rounds: 0 });
    });

    it("401s with no bearer token at all — golfer-tier auth", async () => {
      const { dispatcher } = await setupGolfer();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/me/courses/${DEFAULT_COURSE.courseId}/record` })));
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });
  });
});

// Accounts-only identity (spec §3): StartRound/JoinRound are the "golfer" auth tier now (there is
// no anonymous start or join). The three arms, over the REAL routes: no token 401s, an INVALID
// token 401s, and a VALID token seats the caller's OWN account golfer (as-self, resolved via
// ensureGolfer) — asserted against the RESPONSE golferId.
describe("createDispatcher — golfer-tier StartRound/JoinRound (accounts-only identity spec §3)", () => {
  const ann: AccountClaims = { sub: "cognito-sub-ann-og" };
  const bo: AccountClaims = { sub: "cognito-sub-bo-og" };
  const golferBearer = (account: AccountClaims): string => `golfer-token-${account.sub}`;
  const stubVerifier: AccountVerifier = {
    verify: async (bearer: string) => {
      const account = [ann, bo].find((candidate) => golferBearer(candidate) === bearer);
      if (!account) throw new Error("stubVerifier: unknown token");
      return account;
    },
  };
  const setupGolferTier = () => setup(stubVerifier);

  describe("POST /rounds", () => {
    it("arm 1 — no bearer token: 401 invalid-token (no anonymous start)", async () => {
      const { dispatcher } = await setupGolferTier();
      const resp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: "/rounds", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
      );
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });

    it("arm 2 — an INVALID bearer token: 401 invalid-token", async () => {
      const { dispatcher } = await setupGolferTier();
      const resp = asStructured(
        await dispatcher(
          makeEvent({ method: "POST", path: "/rounds", token: "garbage-token", body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
        ),
      );
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });

    it("arm 3 — a VALID bearer token: 201, seated as the caller's OWN account golfer (as-self)", async () => {
      const { dispatcher } = await setupGolferTier();
      // PUT /me first so ann has a named account golfer; the round's creator seat must resolve to it.
      const putResp = asStructured(await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(ann), body: { name: "Ann" } })));
      const annGolfer = golferResponseSchema.parse(JSON.parse(putResp.body!));

      const resp = asStructured(
        await dispatcher(
          makeEvent({ method: "POST", path: "/rounds", token: golferBearer(ann), body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
        ),
      );
      expect(resp.statusCode).toBe(201);
      const started = startRoundResponseSchema.parse(JSON.parse(resp.body!));
      expect(started.golferId).toBe(annGolfer.golfer.golferId); // as-self, not a fresh id
    });
  });

  describe("POST /rounds/join", () => {
    const startRoundAs = async (dispatcher: ReturnType<typeof createDispatcher>) =>
      startRoundResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({ method: "POST", path: "/rounds", token: golferBearer(ann), body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
            ),
          ).body!,
        ),
      );

    it("arm 1 — no bearer token: 401 invalid-token (no anonymous join)", async () => {
      const { dispatcher } = await setupGolferTier();
      const started = await startRoundAs(dispatcher);
      const resp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: "/rounds/join", body: { code: started.joinCode, tee: "white" } })),
      );
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });

    it("arm 2 — an INVALID bearer token: 401 invalid-token", async () => {
      const { dispatcher } = await setupGolferTier();
      const started = await startRoundAs(dispatcher);
      const resp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: "/rounds/join", token: "garbage-token", body: { code: started.joinCode, tee: "white" } })),
      );
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });

    it("arm 3 — a VALID bearer token: 201, joiner seated as their OWN account golfer (as-self)", async () => {
      const { dispatcher } = await setupGolferTier();
      // bo has a named account golfer; ann creates the round, bo joins as himself.
      const putResp = asStructured(await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(bo), body: { name: "Bo" } })));
      const boGolfer = golferResponseSchema.parse(JSON.parse(putResp.body!));

      const started = await startRoundAs(dispatcher); // created by ann
      const resp = asStructured(
        await dispatcher(
          makeEvent({ method: "POST", path: "/rounds/join", token: golferBearer(bo), body: { code: started.joinCode, tee: "white" } }),
        ),
      );
      expect(resp.statusCode).toBe(201);
      const joined = joinRoundResponseSchema.parse(JSON.parse(resp.body!));
      expect(joined.golferId).toBe(boGolfer.golfer.golferId); // as-self, resolved from bo's own Bearer
    });
  });
});

// M8 Task 4: the "golfer"-gated crew routes buildRoutes declares. Mirrors the M7 golfer-routes
// suite above (its own ann/bo/cal + golferBearer/stubVerifier idiom), kept as its own describe
// block per this file's existing "one block per milestone's route additions" convention (M6
// courses, M7 golfer/terminate).
describe("createDispatcher — crew routes (M8 Task 4)", () => {
  const ann: AccountClaims = { sub: "cognito-sub-ann-crew" };
  const bo: AccountClaims = { sub: "cognito-sub-bo-crew" };
  const cal: AccountClaims = { sub: "cognito-sub-cal-crew" };
  const golferBearer = (account: AccountClaims): string => `golfer-token-${account.sub}`;

  const stubVerifier: AccountVerifier = {
    verify: async (bearer: string) => {
      const account = [ann, bo, cal].find((candidate) => golferBearer(candidate) === bearer);
      if (!account) throw new Error("stubVerifier: unknown token");
      return account;
    },
  };

  const setupCrews = () => setup(stubVerifier);

  // PUT /me creates an account golfer for `account` and returns its GolferId — every crew
  // route needs a real account golfer seated first (golfer-required otherwise).
  const putMe = async (dispatcher: ReturnType<typeof createDispatcher>, account: AccountClaims, name: string) => {
    const resp = asStructured(await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(account), body: { name } })));
    return golferResponseSchema.parse(JSON.parse(resp.body!)).golfer;
  };

  it("POST /crews with no account golfer yet is rejected — golfer-required (the REAL error code, driven end-to-end)", async () => {
    const { dispatcher } = await setupCrews();
    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } })),
    );
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "golfer-required" });
  });

  it("GET /crews/{crewId} for a non-member is rejected — 403 not-a-member (the REAL error code)", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const createResp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } })),
    );
    const created = createCrewResponseSchema.parse(JSON.parse(createResp.body!));

    await putMe(dispatcher, cal, "Cal"); // has an account golfer, but never joined this crew
    const resp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/crews/${created.crew.crewId}`, token: golferBearer(cal) })),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-a-member" });
  });

  it("GET /crews/{crewId} for a fellow member succeeds with the full crew view", async () => {
    const { dispatcher } = await setupCrews();
    const annGolfer = await putMe(dispatcher, ann, "Ann");
    const createResp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } })),
    );
    const created = createCrewResponseSchema.parse(JSON.parse(createResp.body!));

    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/crews/${created.crew.crewId}`, token: golferBearer(ann) })));
    expect(resp.statusCode).toBe(200);
    const fetched = getCrewResponseSchema.parse(JSON.parse(resp.body!));
    expect(fetched.crew.members).toEqual([{ golferId: annGolfer.golferId, name: "Ann", role: "organizer" }]);
  });

  it("GET /crews/{crewId} for an unknown crewId is rejected — 404 unknown-crew", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/crews/does-not-exist", token: golferBearer(ann) })));
    expect(resp.statusCode).toBe(404);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "unknown-crew" });
  });

  it("POST /crews/join with a bad token is rejected — 403 crew-invite-invalid", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(ann), body: { token: "not-a-real-token" } })),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "crew-invite-invalid" });
  });

  // Crew membership (invited in, accountable out — spec §2): POST /crews/{crewId}/invites
  // (mint, ANY member) -> POST /crews/peek ("none"-auth consent-screen preview, BEFORE sign-in)
  // -> POST /crews/join ({token}). Replaces the old permanent-join-code + add-by-id flow.
  it(
    "drives create -> mint invite -> peek (pre-sign-in preview) -> join by token -> GET /me/crews -> " +
      "StartRound as-self (creator seat only) -> create season -> list seasons",
    async () => {
      const { dispatcher } = await setupCrews();
      const annGolfer = await putMe(dispatcher, ann, "Ann");
      await putMe(dispatcher, bo, "Bo");

      const createResp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } })),
      );
      expect(createResp.statusCode).toBe(201);
      const created = createCrewResponseSchema.parse(JSON.parse(createResp.body!));
      expect(created.crew.members).toEqual([{ golferId: annGolfer.golferId, name: "Ann", role: "organizer" }]);
      expect(created.crew).not.toHaveProperty("joinCode"); // the permanent join code is gone (crew membership, invited in)

      const inviteResp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) })),
      );
      expect(inviteResp.statusCode).toBe(200); // an act on an existing resource, not a top-level mint — see routes.ts's own comment
      const invite = mintCrewInviteResponseSchema.parse(JSON.parse(inviteResp.body!));
      expect(invite.expiresAtMs).toBeGreaterThan(0);

      // The consent-screen preview — no Bearer token at all (auth: "none"), proving the
      // "Join The Saturday Boys? · N members · invited by Al" screen renders BEFORE sign-in.
      const peekResp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews/peek", body: { token: invite.token } })));
      expect(peekResp.statusCode).toBe(200);
      expect(peekCrewInviteResponseSchema.parse(JSON.parse(peekResp.body!))).toEqual({
        crewName: "Sunday Skins",
        memberCount: 1,
        inviterName: "Ann",
      });

      const joinResp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(bo), body: { token: invite.token } })),
      );
      expect(joinResp.statusCode).toBe(200); // an act on an existing resource, not a mint — see routes.ts's own comment
      joinCrewResponseSchema.parse(JSON.parse(joinResp.body!));

      const myCrewsResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me/crews", token: golferBearer(bo) })));
      expect(myCrewsResp.statusCode).toBe(200);
      const myCrews = listMyCrewsResponseSchema.parse(JSON.parse(myCrewsResp.body!));
      expect(myCrews.crews).toEqual(expect.arrayContaining([{ crewId: created.crew.crewId, name: "Sunday Skins", memberCount: 2 }]));

      // Accounts-only identity (spec §3): StartRound seats its CREATOR ONLY, always as-self — no
      // players[] roster, no crewId (sealed leaf). ann's crew membership is irrelevant to the round.
      const startResp = asStructured(
        await dispatcher(
          makeEvent({ method: "POST", path: "/rounds", token: golferBearer(ann), body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
        ),
      );
      expect(startResp.statusCode).toBe(201);
      const started = startRoundResponseSchema.parse(JSON.parse(startResp.body!));
      expect(started.golferId).toBe(annGolfer.golferId); // the creator resolved to ann's OWN golfer (as-self)

      const eventsResp = asStructured(
        await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "0" } })),
      );
      const events = JSON.parse(eventsResp.body!) as { events: readonly { kind: string; participant?: { golferId: string; name: string } }[] };
      const joins = events.events.filter((e) => e.kind === "participant-joined");
      expect(joins).toHaveLength(1); // Ann only — nobody else is seeded onto a card
      expect(joins[0]?.participant?.golferId).toBe(annGolfer.golferId);
      expect(joins[0]?.participant?.name).toBe("Ann");

      // Task 9: a member creates a season, then lists the crew's seasons — the standings-on-read
      // routes are wired (this round was never finalized, so nothing is counted yet).
      const seasonResp = asStructured(
        await dispatcher(
          makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/seasons`, token: golferBearer(bo), body: { name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" } }),
        ),
      );
      expect(seasonResp.statusCode).toBe(201);
      const season = createSeasonResponseSchema.parse(JSON.parse(seasonResp.body!));
      expect(season.season).toMatchObject({ name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" });

      const listResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/crews/${created.crew.crewId}/seasons`, token: golferBearer(ann) })));
      expect(listResp.statusCode).toBe(200);
      const listed = listSeasonsResponseSchema.parse(JSON.parse(listResp.body!));
      // POST /crews already auto-opened the crew's own first season (spec 2026-07-22 §2) — the
      // OLDER of the two, so newest-first puts the just-created "2026" season ahead of it.
      expect(listed.seasons.map((s) => s.seasonId)).toEqual([season.season.seasonId, expect.any(String)]);
      expect(listed.seasons).toHaveLength(2);
    },
  );

  // Crew membership (invited in, accountable out — spec §1): ANY member mints, not just the
  // organizer — driven end-to-end (Bo, an ordinary member, mints his own invite).
  it("POST /crews/{crewId}/invites: any member (not just the organizer) may mint", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    await putMe(dispatcher, bo, "Bo");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    const firstInvite = mintCrewInviteResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
    );
    await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(bo), body: { token: firstInvite.token } }));

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(bo) })),
    );
    expect(resp.statusCode).toBe(200);
    mintCrewInviteResponseSchema.parse(JSON.parse(resp.body!));
  });

  it("POST /crews/{crewId}/invites for a non-member is rejected — 403 not-a-member", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    await putMe(dispatcher, cal, "Cal");

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(cal) })),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-a-member" });
  });

  it("POST /crews/peek with a bad token is rejected — 403 crew-invite-invalid, no Bearer needed to fail this way", async () => {
    const { dispatcher } = await setupCrews();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews/peek", body: { token: "not-a-real-token" } })));
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "crew-invite-invalid" });
  });

  // The season + standings ROUTE wiring end-to-end (Task 9; the counting apparatus this test
  // used to also drive — POST/DELETE .../rounds — is deleted whole, crew-scoreboard spec §2b:
  // standings.rounds is DERIVED now, requiring >=2 CURRENT roster members holding a line for
  // the same round; the crew-scoreboard derivation itself is covered in seasonSlice.test.ts).
  it("drives finalize -> create season -> GET standings — route wiring only", async () => {
    const { dispatcher } = await setupCrews();
    const annGolfer = await putMe(dispatcher, ann, "Ann");

    // A finalized round Ann played (as-self), so its snapshot exists and Ann is a participant.
    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({
              method: "POST",
              path: "/rounds",
              token: golferBearer(ann),
              body: { course: DEFAULT_COURSE, host: { tee: "white" } },
            }),
          ),
        ).body!,
      ),
    );
    expect(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: started.token }))).statusCode).toBe(200);

    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    const season = createSeasonResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/seasons`, token: golferBearer(ann), body: { name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" } }),
          ),
        ).body!,
      ),
    ).season;

    const standingsResp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/crews/${created.crew.crewId}/seasons/${season.seasonId}/standings`, token: golferBearer(ann) })),
    );
    expect(standingsResp.statusCode).toBe(200);
    const standings = seasonStandingsResponseSchema.parse(JSON.parse(standingsResp.body!));
    // "Played together" needs >=2 CURRENT roster members (spec §3a) — Ann is the crew's only
    // member, so the derived list stays empty.
    expect(standings.rounds).toEqual([]);
    expect(annGolfer).toBeDefined();
  });

  // Leave (Task 9): a member removes themselves; POST /crews/{crewId}/leave echoes the crewId.
  it("POST /crews/{crewId}/leave removes the caller from the roster", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const boGolfer = await putMe(dispatcher, bo, "Bo");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    const invite = mintCrewInviteResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
    );
    await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(bo), body: { token: invite.token } }));

    const leaveResp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/leave`, token: golferBearer(bo) })));
    expect(leaveResp.statusCode).toBe(200);
    expect(leaveCrewResponseSchema.parse(JSON.parse(leaveResp.body!))).toEqual({ crewId: created.crew.crewId });

    // Bo is off the roster — GET /crews now 403s not-a-member for Bo.
    const getResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/crews/${created.crew.crewId}`, token: golferBearer(bo) })));
    expect(getResp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(getResp.body!))).toMatchObject({ code: "not-a-member" });
    expect(boGolfer).toBeDefined();
  });

  // Crew membership (invited in, accountable out — spec §1): the organizer's authority, driven
  // through the REAL dispatcher — DELETE /crews/{crewId}/members/{golferId} (remove) and
  // POST /crews/{crewId}/transfer, plus the leaveCrew organizer guard.
  it("DELETE /crews/{crewId}/members/{golferId}: the organizer removes a member (200) — updated crew returned", async () => {
    const { dispatcher } = await setupCrews();
    const annGolfer = await putMe(dispatcher, ann, "Ann");
    const boGolfer = await putMe(dispatcher, bo, "Bo");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    const invite = mintCrewInviteResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
    );
    await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(bo), body: { token: invite.token } }));

    const removeResp = asStructured(
      await dispatcher(makeEvent({ method: "DELETE", path: `/crews/${created.crew.crewId}/members/${boGolfer.golferId}`, token: golferBearer(ann) })),
    );
    expect(removeResp.statusCode).toBe(200);
    const removed = getCrewResponseSchema.parse(JSON.parse(removeResp.body!));
    expect(removed.crew.members).toEqual([{ golferId: annGolfer.golferId, name: "Ann", role: "organizer" }]);
  });

  it("DELETE /crews/{crewId}/members/{golferId}: an ordinary member attempting to remove someone is rejected — 403 not-organizer", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const boGolfer = await putMe(dispatcher, bo, "Bo");
    const calGolfer = await putMe(dispatcher, cal, "Cal");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    for (const account of [bo, cal]) {
      const invite = mintCrewInviteResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
      );
      await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(account), body: { token: invite.token } }));
    }
    expect(boGolfer).toBeDefined();

    // Bo (an ordinary member, not the organizer) tries to remove Cal.
    const resp = asStructured(
      await dispatcher(makeEvent({ method: "DELETE", path: `/crews/${created.crew.crewId}/members/${calGolfer.golferId}`, token: golferBearer(bo) })),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-organizer" });
  });

  it("POST /crews/{crewId}/transfer: the organizer transfers to a member (200) — role flip, exactly one organizer", async () => {
    const { dispatcher } = await setupCrews();
    const annGolfer = await putMe(dispatcher, ann, "Ann");
    const boGolfer = await putMe(dispatcher, bo, "Bo");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    const invite = mintCrewInviteResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
    );
    await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(bo), body: { token: invite.token } }));

    const transferResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/transfer`, token: golferBearer(ann), body: { golferId: boGolfer.golferId } }),
      ),
    );
    expect(transferResp.statusCode).toBe(200);
    const transferred = getCrewResponseSchema.parse(JSON.parse(transferResp.body!));
    expect(transferred.crew.members).toEqual([
      { golferId: annGolfer.golferId, name: "Ann", role: "member" },
      { golferId: boGolfer.golferId, name: "Bo", role: "organizer" },
    ]);

    // Ann (now an ordinary member) can no longer remove/transfer — not-organizer.
    const rejected = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/transfer`, token: golferBearer(ann), body: { golferId: annGolfer.golferId } }),
      ),
    );
    expect(rejected.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(rejected.body!))).toMatchObject({ code: "not-organizer" });
  });

  it("POST /crews/{crewId}/transfer: an ordinary member attempting to transfer is rejected — 403 not-organizer", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const boGolfer = await putMe(dispatcher, bo, "Bo");
    const calGolfer = await putMe(dispatcher, cal, "Cal");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );
    for (const account of [bo, cal]) {
      const invite = mintCrewInviteResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
      );
      await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(account), body: { token: invite.token } }));
    }
    expect(boGolfer).toBeDefined();

    const resp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/transfer`, token: golferBearer(bo), body: { golferId: calGolfer.golferId } }),
      ),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-organizer" });
  });

  it("POST /crews/{crewId}/leave: the organizer cannot leave — 409 organizer-must-transfer", async () => {
    const { dispatcher } = await setupCrews();
    await putMe(dispatcher, ann, "Ann");
    const created = createCrewResponseSchema.parse(
      JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
    );

    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/leave`, token: golferBearer(ann) })));
    expect(resp.statusCode).toBe(409);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "organizer-must-transfer" });
  });

  // Spec 2026-07-22 "the season is the record" §2: editing the end date IS the whole
  // lifecycle — driven through the REAL dispatcher, same "mirrors transferOrganizer/
  // removeCrewMember's own organizer-guard idiom" story the use case itself documents. Replaces
  // the deleted close/reopen verb pair outright.
  describe("PUT /crews/{crewId}/seasons/{seasonId} (spec 2026-07-22 §2)", () => {
    it("the organizer edits a season's dates and name (200), through the real use case", async () => {
      const { dispatcher } = await setupCrews();
      await putMe(dispatcher, ann, "Ann");
      const created = createCrewResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
      );
      const season = createSeasonResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/seasons`, token: golferBearer(ann), body: { name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" } }),
            ),
          ).body!,
        ),
      ).season;
      const seasonPath = `/crews/${created.crew.crewId}/seasons/${season.seasonId}`;

      const putResp = asStructured(
        await dispatcher(makeEvent({ method: "PUT", path: seasonPath, token: golferBearer(ann), body: { name: "Summer Cup", endsAt: "2026-06-30" } })),
      );
      expect(putResp.statusCode).toBe(200);
      const updated = createSeasonResponseSchema.parse(JSON.parse(putResp.body!));
      expect(updated.season).toMatchObject({ seasonId: season.seasonId, name: "Summer Cup", startsAt: "2026-01-01", endsAt: "2026-06-30" });
    });

    it("an ordinary member attempting to edit is rejected — 403 not-organizer", async () => {
      const { dispatcher } = await setupCrews();
      await putMe(dispatcher, ann, "Ann");
      const boGolfer = await putMe(dispatcher, bo, "Bo");
      const created = createCrewResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
      );
      const invite = mintCrewInviteResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
      );
      await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(bo), body: { token: invite.token } }));
      const season = createSeasonResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/seasons`, token: golferBearer(ann), body: { name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" } }),
            ),
          ).body!,
        ),
      ).season;

      const resp = asStructured(
        await dispatcher(makeEvent({ method: "PUT", path: `/crews/${created.crew.crewId}/seasons/${season.seasonId}`, token: golferBearer(bo), body: { name: "Nope" } })),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-organizer" });
      expect(boGolfer).toBeDefined();
    });

    it("401s with no bearer token at all — golfer-tier auth", async () => {
      const { dispatcher } = await setupCrews();
      const resp = asStructured(await dispatcher(makeEvent({ method: "PUT", path: "/crews/anything/seasons/anything", body: { name: "x" } })));
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });

    it("an inverted window (startsAt after endsAt) is rejected — 400 invalid-season-window, no closed-check anywhere", async () => {
      const { dispatcher } = await setupCrews();
      await putMe(dispatcher, ann, "Ann");
      const created = createCrewResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
      );
      const season = createSeasonResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/seasons`, token: golferBearer(ann), body: { name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" } }),
            ),
          ).body!,
        ),
      ).season;

      const resp = asStructured(
        await dispatcher(
          makeEvent({ method: "PUT", path: `/crews/${created.crew.crewId}/seasons/${season.seasonId}`, token: golferBearer(ann), body: { endsAt: "2025-01-01" } }),
        ),
      );
      expect(resp.statusCode).toBe(400);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-season-window" });
    });
  });

  // Spec 2026-07-22 "the season is the record" §2: the crew name is editable — organizer-only,
  // no season lookup. Driven through the REAL dispatcher, same organizer-guard idiom as above.
  describe("PUT /crews/{crewId} (spec 2026-07-22 §2)", () => {
    it("the organizer renames the crew (200), through the real use case", async () => {
      const { dispatcher } = await setupCrews();
      await putMe(dispatcher, ann, "Ann");
      const created = createCrewResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
      );

      const resp = asStructured(
        await dispatcher(makeEvent({ method: "PUT", path: `/crews/${created.crew.crewId}`, token: golferBearer(ann), body: { name: "Sunday Regulars" } })),
      );
      expect(resp.statusCode).toBe(200);
      expect(getCrewResponseSchema.parse(JSON.parse(resp.body!)).crew.name).toBe("Sunday Regulars");
    });

    it("an ordinary member attempting to rename is rejected — 403 not-organizer", async () => {
      const { dispatcher } = await setupCrews();
      await putMe(dispatcher, ann, "Ann");
      const boGolfer = await putMe(dispatcher, bo, "Bo");
      const created = createCrewResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
      );
      const invite = mintCrewInviteResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: `/crews/${created.crew.crewId}/invites`, token: golferBearer(ann) }))).body!),
      );
      await dispatcher(makeEvent({ method: "POST", path: "/crews/join", token: golferBearer(bo), body: { token: invite.token } }));

      const resp = asStructured(
        await dispatcher(makeEvent({ method: "PUT", path: `/crews/${created.crew.crewId}`, token: golferBearer(bo), body: { name: "Nope" } })),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-organizer" });
      expect(boGolfer).toBeDefined();
    });

    it("a whitespace-only name is rejected — 400 invalid-crew-name", async () => {
      const { dispatcher } = await setupCrews();
      await putMe(dispatcher, ann, "Ann");
      const created = createCrewResponseSchema.parse(
        JSON.parse(asStructured(await dispatcher(makeEvent({ method: "POST", path: "/crews", token: golferBearer(ann), body: { name: "Sunday Skins" } }))).body!),
      );

      const resp = asStructured(
        await dispatcher(makeEvent({ method: "PUT", path: `/crews/${created.crew.crewId}`, token: golferBearer(ann), body: { name: "   " } })),
      );
      expect(resp.statusCode).toBe(400);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-crew-name" });
    });
  });
});

// M9 Task 3 (share): POST /rounds/{roundId}/share (participant-gated) + the "round-read" tier
// GET /rounds/{roundId}/events now accepts (participant OR spectator, both round-scoped) + the
// "participant" tier's own new write-rejection of a spectator token. Every write route class
// buildRoutes declares gets its own case here, per the brief's own test list.
describe("createDispatcher — share: spectator tokens + the round-read tier (M9 Task 3)", () => {
  const startAndShare = async (dispatcher: ReturnType<typeof createDispatcher>) => {
    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
        ).body!,
      ),
    );
    const shareResp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/share`, token: started.token })),
    );
    expect(shareResp.statusCode).toBe(200);
    const { url } = shareLinkResponseSchema.parse(JSON.parse(shareResp.body!));
    expect(url).toBe(`/watch/${started.roundId}#${url.split("#")[1]}`); // sanity: the expected /watch/{roundId}#token shape
    const spectatorToken = url.split("#")[1]!;
    return { started, spectatorToken };
  };

  it("POST /rounds/{roundId}/share is deterministic — the same round returns the SAME url on a repeat call", async () => {
    const { dispatcher } = await setup();
    const { started, spectatorToken } = await startAndShare(dispatcher);

    const secondResp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/share`, token: started.token })),
    );
    expect(secondResp.statusCode).toBe(200);
    const second = shareLinkResponseSchema.parse(JSON.parse(secondResp.body!));
    expect(second.url.split("#")[1]).toBe(spectatorToken);
  });

  it("GET /rounds/{roundId}/events — round-read arm 1: a PARTICIPANT token is still accepted (unchanged)", async () => {
    const { dispatcher } = await setup();
    const { started } = await startAndShare(dispatcher);

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: started.token, query: { since: "0" } })),
    );
    expect(resp.statusCode).toBe(200);
  });

  it("GET /rounds/{roundId}/events — round-read arm 2: a SPECTATOR token is accepted", async () => {
    const { dispatcher } = await setup();
    const { started, spectatorToken } = await startAndShare(dispatcher);

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: spectatorToken, query: { since: "0" } })),
    );
    expect(resp.statusCode).toBe(200);
    const events = JSON.parse(resp.body!) as { events: readonly unknown[] };
    expect(events.events.length).toBeGreaterThan(0); // the spectator actually sees the log, not an empty stub
  });

  it("GET /rounds/{roundId}/events — round-read: a spectator token minted for a DIFFERENT round — 403 token-round-mismatch", async () => {
    const { dispatcher } = await setup();
    const { spectatorToken } = await startAndShare(dispatcher);
    const otherRound = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
        ).body!,
      ),
    );

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${otherRound.roundId}/events`, token: spectatorToken, query: { since: "0" } })),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "token-round-mismatch" });
  });

  it("GET /rounds/{roundId}/events — round-read: no bearer token at all — 401 invalid-token", async () => {
    const { dispatcher } = await setup();
    const { started } = await startAndShare(dispatcher);
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, query: { since: "0" } })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("GET /rounds/{roundId}/events — round-read: a garbage bearer token — 401 invalid-token", async () => {
    const { dispatcher } = await setup();
    const { started } = await startAndShare(dispatcher);
    const resp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: "not-a-real-token", query: { since: "0" } })),
    );
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  // Every WRITE route class buildRoutes declares — a verified spectator token 403s
  // read-only-token, never 401 (the token itself is fine, it's just read-only) and never a
  // silent success. Table-driven over every write route so a future write route added to
  // buildRoutes without an entry here is a visible gap, not a silent hole.
  describe("a spectator token 403s read-only-token on every write route class", () => {
    it("POST /rounds/{roundId}/games", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(
        await dispatcher(
          makeEvent({
            method: "POST",
            path: `/rounds/${started.roundId}/games`,
            token: spectatorToken,
            body: { game: { kind: "stableford", players: [started.golferId] } },
          }),
        ),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });

    it("POST /rounds/{roundId}/scores", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(
        await dispatcher(
          makeEvent({
            method: "POST",
            path: `/rounds/${started.roundId}/scores`,
            token: spectatorToken,
            body: {
              golferId: started.golferId,
              hole: 1,
              result: { kind: "strokes", strokes: 4 },
              opId: opId("spectator-op-1"),
              hlc: { wallMs: 1, counter: 0, deviceId: deviceId("spectator-device") },
            },
          }),
        ),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });

    it("POST /rounds/{roundId}/finalize", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: spectatorToken })));
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });

    it("POST /rounds/{roundId}/games/{gameId}/terminate", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(
        await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/games/some-game/terminate`, token: spectatorToken })),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });

    it("POST /rounds/{roundId}/strokes", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(
        await dispatcher(
          makeEvent({
            method: "POST",
            path: `/rounds/${started.roundId}/strokes`,
            token: spectatorToken,
            body: { golferId: started.golferId, strokes: 13 },
          }),
        ),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });

    it("POST /rounds/{roundId}/played-at", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(
        await dispatcher(
          makeEvent({
            method: "POST",
            path: `/rounds/${started.roundId}/played-at`,
            token: spectatorToken,
            body: { playedAtMs: 1_700_000_000_000 },
          }),
        ),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });

    it("POST /rounds/{roundId}/holes", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(
        await dispatcher(
          makeEvent({
            method: "POST",
            path: `/rounds/${started.roundId}/holes`,
            token: spectatorToken,
            body: { holes: "front" },
          }),
        ),
      );
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });

    it("POST /rounds/{roundId}/share itself — minting a NEW share link is participant-only", async () => {
      const { dispatcher } = await setup();
      const { started, spectatorToken } = await startAndShare(dispatcher);
      const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/share`, token: spectatorToken })));
      expect(resp.statusCode).toBe(403);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "read-only-token" });
    });
  });

  // token-round-mismatch is checked BEFORE the scope check on the "participant" tier (dispatch.ts)
  // — a spectator token for a DIFFERENT round on a write route reports the more specific
  // mismatch, not read-only-token, same precedence the brief's own error-shape discipline
  // (M6 lesson: never mask a more specific failure behind a generic one).
  it("a spectator token for a DIFFERENT round on a write route — 403 token-round-mismatch, not read-only-token", async () => {
    const { dispatcher } = await setup();
    const { spectatorToken } = await startAndShare(dispatcher);
    const otherRound = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
        ).body!,
      ),
    );

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/rounds/${otherRound.roundId}/finalize`, token: spectatorToken })),
    );
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "token-round-mismatch" });
  });
});

// Crew membership (invited in, accountable out): a crew-invite token is a REAL, authentic
// bearer (tokens.verify() returns claims for it) but carries no roundId at all — TokenClaims'
// own doc comment (ports/tokenIssuer.ts) calls out the dispatcher's "participant"/"round-read"
// tiers by name as two of the three roundId-consuming verifiers that must narrow on scope and
// reject it (wsConnect's own subscribe gate is the third — see entries/wsConnect.test.ts).
// Minted directly off `tokens` (setup()'s own shared TokenIssuer instance) rather than through
// the crew HTTP routes — this proves the DISPATCHER's generic tier logic rejects ANY crew-invite
// bearer presented to a round-scoped route, independent of how it was minted.
describe("createDispatcher — a crew-invite token never opens a round (crew membership, invited in)", () => {
  it("POST /rounds/{roundId}/finalize (participant tier) — 401 invalid-token, never touches .roundId", async () => {
    const { dispatcher, tokens } = await setup();
    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
        ).body!,
      ),
    );
    const crewInviteToken = tokens.issue({
      scope: "crew-invite",
      crewId: crewId("crew-1"),
      inviterGolferId: golferId("golfer-1"),
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: crewInviteToken })),
    );
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("GET /rounds/{roundId}/events (round-read tier) — 401 invalid-token, never touches .roundId", async () => {
    const { dispatcher, tokens } = await setup();
    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", token: "sub-ann", body: { course: DEFAULT_COURSE, host: { tee: "white" } } })),
        ).body!,
      ),
    );
    const crewInviteToken = tokens.issue({
      scope: "crew-invite",
      crewId: crewId("crew-1"),
      inviterGolferId: golferId("golfer-1"),
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });

    const resp = asStructured(
      await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/events`, token: crewInviteToken, query: { since: "0" } })),
    );
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });
});

// Projection-realignment Task 6: GET /me/rounds and GET /rounds/{roundId}/archive, both
// "golfer"-gated (unlike GET /rounds/{roundId}/events' round-scoped "round-read" tier) — the
// routes-table pin the brief's own Step 1 asks for. Mirrors the M7 golfer-routes suite's own
// ann/bo + golferBearer/stubVerifier idiom.
describe("createDispatcher — snapshot routes: GET /me/rounds + GET /rounds/{roundId}/archive (projection-realignment Task 6)", () => {
  const ann: AccountClaims = { sub: "cognito-sub-ann-archive" };
  const bo: AccountClaims = { sub: "cognito-sub-bo-archive" };
  const golferBearer = (account: AccountClaims): string => `golfer-token-${account.sub}`;

  const stubVerifier: AccountVerifier = {
    verify: async (bearer: string) => {
      const account = [ann, bo].find((candidate) => golferBearer(candidate) === bearer);
      if (!account) throw new Error("stubVerifier: unknown token");
      return account;
    },
  };

  const setupArchive = () => setup(stubVerifier);

  // Seeds ann's own account golfer, starts a round as-self (accounts-only identity spec §3 — the
  // golfer-tier StartRound suite above pins the same arm), then finalizes it with no games
  // configured (nothing left unresolved) — the smallest real finalized round with a real
  // account-golfer participant this suite needs.
  const seedAnnsFinalizedRound = async (dispatcher: ReturnType<typeof createDispatcher>) => {
    // Names ann's account golfer before she starts as-self (the seat resolves from her Bearer).
    await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(ann), body: { name: "Ann" } }));

    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({
              method: "POST",
              path: "/rounds",
              token: golferBearer(ann),
              body: { course: DEFAULT_COURSE, host: { tee: "white" } },
            }),
          ),
        ).body!,
      ),
    );

    const finalizeResp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: started.token })));
    expect(finalizeResp.statusCode).toBe(200);

    return started;
  };

  describe("GET /rounds/{roundId}/archive", () => {
    it("404s round-not-found for a roundId with no snapshot at all", async () => {
      const { dispatcher } = await setupArchive();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/never-started/archive", token: golferBearer(ann) })));
      expect(resp.statusCode).toBe(404);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "round-not-found" });
    });

    it("404s round-not-found for a round that's still LIVE — the snapshot only lands at finalize", async () => {
      const { dispatcher } = await setupArchive();
      const started = startRoundResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({ method: "POST", path: "/rounds", token: golferBearer(ann), body: { course: DEFAULT_COURSE, host: { tee: "white" } } }),
            ),
          ).body!,
        ),
      );

      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/archive`, token: golferBearer(ann) })));
      expect(resp.statusCode).toBe(404);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "round-not-found" });
    });

    it("returns the archive's own event log for the participant who played it", async () => {
      const { dispatcher } = await setupArchive();
      const started = await seedAnnsFinalizedRound(dispatcher);

      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/archive`, token: golferBearer(ann) })));
      expect(resp.statusCode).toBe(200);
      const { events } = getRoundArchiveResponseSchema.parse(JSON.parse(resp.body!));
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event) => event.kind === "round-finalized")).toBe(true);
    });

    // Navigation spec §6b (binding): the archive read relaxed to any signed-in golfer — the
    // former stranger-403 pin (task-6-brief.md) is superseded; a signed-in golfer who simply
    // never played this round still gets the event log.
    it("returns the archive's own event log for a signed-in golfer who never played this round — any signed-in golfer may view it now (spec §6b)", async () => {
      const { dispatcher } = await setupArchive();
      const started = await seedAnnsFinalizedRound(dispatcher);

      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/archive`, token: golferBearer(bo) })));
      expect(resp.statusCode).toBe(200);
      const { events } = getRoundArchiveResponseSchema.parse(JSON.parse(resp.body!));
      expect(events.some((event) => event.kind === "round-finalized")).toBe(true);
    });

    it("401s with no bearer token at all — golfer-tier auth, never the round-scoped participant/spectator tier", async () => {
      const { dispatcher } = await setupArchive();
      const started = await seedAnnsFinalizedRound(dispatcher);

      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/rounds/${started.roundId}/archive` })));
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });
  });

  describe("GET /me/rounds", () => {
    it("returns an empty list for a golfer who has never played a finalized round", async () => {
      const { dispatcher } = await setupArchive();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me/rounds", token: golferBearer(bo) })));
      expect(resp.statusCode).toBe(200);
      expect(getMyRoundsResponseSchema.parse(JSON.parse(resp.body!))).toEqual({ rounds: [] });
    });

    it("401s with no bearer token at all", async () => {
      const { dispatcher } = await setupArchive();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me/rounds" })));
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });
  });

  // Projection-realignment Task 13: "your rounds, right now" — presence, not finalized
  // history. Same golfer tier/wiring idiom as GET /me/rounds just above.
  describe("GET /me/rounds/live", () => {
    it("returns an empty list for a golfer with no live round", async () => {
      const { dispatcher } = await setupArchive();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me/rounds/live", token: golferBearer(bo) })));
      expect(resp.statusCode).toBe(200);
      expect(getMyLiveRoundsResponseSchema.parse(JSON.parse(resp.body!))).toEqual({ rounds: [] });
    });

    it("lists a round the golfer just started, by identity — courseName + joinedAt + playedAt on the wire", async () => {
      const { dispatcher } = await setupArchive();
      await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(ann), body: { name: "Ann" } }));

      const started = startRoundResponseSchema.parse(
        JSON.parse(
          asStructured(
            await dispatcher(
              makeEvent({
                method: "POST",
                path: "/rounds",
                token: golferBearer(ann),
                body: { course: DEFAULT_COURSE, host: { tee: "white" } },
              }),
            ),
          ).body!,
        ),
      );

      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me/rounds/live", token: golferBearer(ann) })));
      expect(resp.statusCode).toBe(200);
      const parsed = getMyLiveRoundsResponseSchema.parse(JSON.parse(resp.body!));
      // playedAt (spec 2026-08-01 §4b, replacing the old createdAt) — domain's playedAtMsOf over
      // the round's genesis, read at getMyLiveRounds.ts's own journal read.
      expect(parsed.rounds).toEqual([
        { roundId: started.roundId, courseName: fixtureLinks.courseName, joinedAt: expect.any(Number), playedAt: expect.any(Number) },
      ]);
    });

    it("401s with no bearer token at all", async () => {
      const { dispatcher } = await setupArchive();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me/rounds/live" })));
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });
  });

  // Navigation spec §6a: the golfer page's read — "golfer"-gated (any signed-in caller), but
  // NOT self-scoped (unlike GET /me/record just above): the target golferId rides the PATH.
  describe("GET /golfers/{golferId}", () => {
    it("returns another golfer's name/metrics/history for any signed-in caller", async () => {
      const { dispatcher } = await setupArchive();
      const putResp = asStructured(await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(ann), body: { name: "Ann" } })));
      const { golfer } = golferResponseSchema.parse(JSON.parse(putResp.body!));

      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/golfers/${golfer.golferId}`, token: golferBearer(bo) })));
      expect(resp.statusCode).toBe(200);
      const parsed = getGolferResponseSchema.parse(JSON.parse(resp.body!));
      expect(parsed).toEqual({
        name: "Ann",
        metrics: { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, averageHistory: [], bests: {}, milestones: [] },
        history: [],
      });
    });

    it("404s golfer-not-found for an unknown golferId", async () => {
      const { dispatcher } = await setupArchive();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/golfers/no-such-golfer", token: golferBearer(bo) })));
      expect(resp.statusCode).toBe(404);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "golfer-not-found" });
    });

    it("401s with no bearer token at all", async () => {
      const { dispatcher } = await setupArchive();
      const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/golfers/anything" })));
      expect(resp.statusCode).toBe(401);
      expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
    });
  });
});

// Architecture-realignment Task 14: the participant-token re-mint — the route+auth pin (a
// dispatch-level check that the wire is actually assembled correctly; the full use-case
// behavior matrix — check order, every error arm — lives in
// application/src/rounds/mintParticipantToken.test.ts). Same ann/bo/golferBearer/stubVerifier
// idiom as the snapshot-routes suite above, self-contained rather than sharing its closure.
describe("createDispatcher — POST /rounds/{roundId}/token (Task 14: participant token re-mint)", () => {
  const ann: AccountClaims = { sub: "cognito-sub-ann-token" };
  const bo: AccountClaims = { sub: "cognito-sub-bo-token" };
  const golferBearer = (account: AccountClaims): string => `golfer-token-${account.sub}`;

  const stubVerifier: AccountVerifier = {
    verify: async (bearer: string) => {
      const account = [ann, bo].find((candidate) => golferBearer(candidate) === bearer);
      if (!account) throw new Error("stubVerifier: unknown token");
      return account;
    },
  };

  const setupToken = () => setup(stubVerifier);

  // Seeds ann's own account golfer and starts a LIVE round as-self (the seat resolves from her
  // Bearer) — the smallest real round with a real account-golfer participant this suite needs.
  const seedAnnsLiveRound = async (dispatcher: ReturnType<typeof createDispatcher>) => {
    await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(ann), body: { name: "Ann" } }));

    return startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({
              method: "POST",
              path: "/rounds",
              token: golferBearer(ann),
              body: { course: DEFAULT_COURSE, host: { tee: "white" } },
            }),
          ),
        ).body!,
      ),
    );
  };

  it("mints a fresh, WORKING participant token for the caller's own participation — same wire shape as JoinRoundResponse", async () => {
    const { dispatcher } = await setupToken();
    const started = await seedAnnsLiveRound(dispatcher);

    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/token`, token: golferBearer(ann) })));
    expect(resp.statusCode).toBe(200);
    const minted = joinRoundResponseSchema.parse(JSON.parse(resp.body!));
    // The join code rides the credential (spec 2026-07-20 §2) — mint's own response carries the
    // SAME code startRound minted, read back off the round's meta item.
    expect(minted).toEqual({ roundId: started.roundId, token: expect.any(String), golferId: started.golferId, joinCode: started.joinCode });

    // The re-minted token actually authorizes a "participant"-tier route — a real round trip,
    // not just a response-shape check.
    const scoreResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/rounds/${started.roundId}/scores`,
          token: minted.token,
          body: {
            golferId: started.golferId,
            hole: 1,
            result: { kind: "strokes", strokes: 4 },
            opId: opId("mint-token-op-1"),
            hlc: { wallMs: 1, counter: 0, deviceId: deviceId("mint-token-device") },
          },
        }),
      ),
    );
    expect(scoreResp.statusCode).toBe(200);
  });

  it("403s not-a-participant for a signed-in golfer who was never seated in this round", async () => {
    const { dispatcher } = await setupToken();
    const started = await seedAnnsLiveRound(dispatcher);

    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/token`, token: golferBearer(bo) })));
    expect(resp.statusCode).toBe(403);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-a-participant" });
  });

  it("404s round-not-found for a roundId that was never created — for a caller who DOES have an account golfer", async () => {
    const { dispatcher } = await setupToken();
    // A real golfer row for ann first (PUT /me) — otherwise the no-golfer-row 403 would fire
    // before the round is ever folded (mintParticipantToken.ts's own check-order doc comment),
    // masking this specific 404 case.
    await dispatcher(makeEvent({ method: "PUT", path: "/me", token: golferBearer(ann), body: { name: "Ann" } }));

    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/rounds/never-started/token", token: golferBearer(ann) })));
    expect(resp.statusCode).toBe(404);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "round-not-found" });
  });

  it("409s round-final for an actual participant once the round is finalized", async () => {
    const { dispatcher } = await setupToken();
    const started = await seedAnnsLiveRound(dispatcher);
    const finalizeResp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/finalize`, token: started.token })));
    expect(finalizeResp.statusCode).toBe(200);

    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/token`, token: golferBearer(ann) })));
    expect(resp.statusCode).toBe(409);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "round-final" });
  });

  it("401s with no bearer token at all — golfer-tier auth, never the round-scoped participant tier", async () => {
    const { dispatcher } = await setupToken();
    const started = await seedAnnsLiveRound(dispatcher);

    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: `/rounds/${started.roundId}/token` })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });
});

// Prod-readiness Arc B Task 3: one structured access-log line per request. The existing suites
// above all use createNullLogger() (which swallows info()), so none of them can see this line —
// these two tests build their OWN capturing logger, reusing setup()'s real route table/tokens/
// verifier (setup() now takes an optional logger, defaulting to createNullLogger() as before).
describe("createDispatcher — access log (prod-readiness Arc B Task 3)", () => {
  it("logs one structured access line per request with route, status, sub, latencyMs", async () => {
    const infos: { message: string; data?: Record<string, unknown> }[] = [];
    const logger: Logger = { info: (m, d) => infos.push({ message: m, data: d }), warn: () => {}, error: () => {} };
    // subVerifier (setup()'s default) maps any bearer string to a sub of the same value — a
    // golfer-tier request with token "sub-123" is verified as sub "sub-123".
    const { dispatcher } = await setup(subVerifier, logger);

    const res = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/me", token: "sub-123" })));
    expect(res.statusCode).toBe(200);

    const line = infos.find((l) => l.message === "request");
    expect(line).toBeDefined();
    expect(line!.data).toMatchObject({ route: expect.stringMatching(/^[A-Z]+ \//), status: Number(res.statusCode) });
    expect(line!.data!.sub).toBe("sub-123");
    expect(typeof line!.data!.latencyMs).toBe("number");
  });

  it("omits sub on an auth:none route and logs route 'not-found' for an unmatched path", async () => {
    const infos: { message: string; data?: Record<string, unknown> }[] = [];
    const logger: Logger = { info: (m, d) => infos.push({ message: m, data: d }), warn: () => {}, error: () => {} };
    const { dispatcher } = await setup(subVerifier, logger);

    // GET /courses is `auth: "none"` — no bearer token is presented, and none is required.
    await dispatcher(makeEvent({ method: "GET", path: "/courses", query: { query: "anything" } }));
    // Never matches any route — the dispatcher's own 404, distinct from a matched route that
    // itself happens to 404 (e.g. course-not-found).
    await dispatcher(makeEvent({ method: "GET", path: "/no/such/route" }));

    const noneLine = infos.find((l) => l.message === "request" && l.data!.route !== "not-found");
    expect(noneLine).toBeDefined();
    expect(noneLine!.data!.sub).toBeUndefined();

    const missLine = infos.find((l) => l.message === "request" && l.data!.route === "not-found");
    expect(missLine).toBeDefined();
    expect(missLine!.data!.status).toBe(404);
  });
});
