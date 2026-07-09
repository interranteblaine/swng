import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { deviceId, fixtureLinks, fixtureWhite, opId } from "@swng/domain";
import {
  addGame,
  addTeeSet,
  createCapturingBroadcast,
  createCourse,
  createFixedClock,
  createInMemoryCourseStore,
  createInMemoryJournal,
  createInMemoryRoundStore,
  createNullLogger,
  createSequentialIds,
  finalizeRound,
  getCourse,
  joinRound,
  peekRound,
  readEvents,
  recordScore,
  searchCourses,
  startRound,
  verifyTeeSet,
} from "@swng/application";
import {
  addGameResponseSchema,
  addTeeSetResponseSchema,
  createCourseResponseSchema,
  errorResponseSchema,
  finalizeRoundResponseSchema,
  getCourseResponseSchema,
  joinRoundResponseSchema,
  peekRoundResponseSchema,
  recordScoreResponseSchema,
  searchCoursesResponseSchema,
  startRoundResponseSchema,
  verifyTeeSetResponseSchema,
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

const setup = () => {
  const journal = createInMemoryJournal();
  const store = createInMemoryRoundStore();
  const courseStore = createInMemoryCourseStore();
  const broadcast = createCapturingBroadcast();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("id");
  const tokens = createHmacTokenIssuer({ secret: "dispatch-test-secret", clock });
  const logger = createNullLogger();

  const useCases: UseCases = {
    startRound: startRound({ journal, store, broadcast, tokens, clock, ids }),
    joinRound: joinRound({ journal, store, broadcast, tokens, clock, ids }),
    addGame: addGame({ journal, broadcast, clock, ids }),
    recordScore: recordScore({ journal, broadcast }),
    finalizeRound: finalizeRound({ journal, store, broadcast, clock, ids }),
    readEvents: readEvents({ journal }),
    peekRound: peekRound({ journal, store }),
    createCourse: createCourse({ courseStore, idGenerator: ids, clock, logger }),
    addTeeSet: addTeeSet({ courseStore, clock, logger }),
    verifyTeeSet: verifyTeeSet({ courseStore, clock, logger }),
    getCourse: getCourse({ courseStore }),
    searchCourses: searchCourses({ courseStore }),
  };

  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, logger);
  return { dispatcher, tokens };
};

describe("createDispatcher — HTTP-shaped golden path", () => {
  it("drives create -> join -> add game -> score -> duplicate re-send -> finalize", async () => {
    const { dispatcher } = setup();

    const startResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: "/rounds",
          body: { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } },
        }),
      ),
    );
    expect(startResp.statusCode).toBe(201);
    const started = startRoundResponseSchema.parse(JSON.parse(startResp.body!));

    const joinResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: "/rounds/join", body: { code: started.joinCode, name: "Bo", tee: "white", courseHandicap: 2 } }),
      ),
    );
    expect(joinResp.statusCode).toBe(201);
    const joined = joinRoundResponseSchema.parse(JSON.parse(joinResp.body!));

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
          { golferId: started.golferId, points: 15 },
          { golferId: joined.golferId, points: 19 },
        ],
      }),
    ]);
  });

  it("rejects a request with no bearer token on a participant route — 401", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/rounds/some-round/finalize" })));
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("rejects a request with a garbage bearer token on a participant route — 401", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(
      await dispatcher(makeEvent({ method: "POST", path: "/rounds/some-round/finalize", token: "not-a-real-token" })),
    );
    expect(resp.statusCode).toBe(401);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-token" });
  });

  it("rejects a token minted for round X used on round Y's path — 403 token-round-mismatch", async () => {
    const { dispatcher } = setup();

    const roundX = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", body: { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } } })),
        ).body!,
      ),
    );
    const roundY = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(makeEvent({ method: "POST", path: "/rounds", body: { card: fixtureLinks, host: { name: "Cal", tee: "white", courseHandicap: 12 } } })),
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
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/rounds", body: { card: fixtureLinks } })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("rejects a body that isn't valid JSON at all — 400 with errorResponseSchema shape", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/rounds", rawBody: "{not valid json" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("404s an unmatched path, shaped through the same error envelope as every other error", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/not-a-real-route" })));
    expect(resp.statusCode).toBe(404);
    // The not-found body is hand-built in dispatch.ts, but it must still round-trip through
    // errorResponseSchema — one error-shaping site (errorMapping.ts), not a second one that
    // only the 404 path uses.
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "not-found" });
  });

  it("404s a matched path with the wrong method", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "DELETE", path: "/rounds" })));
    expect(resp.statusCode).toBe(404);
  });

  it("maps a malformed percent-escape in the path to a structured 400, not a raw throw", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/%zz/scores" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("rejects GET events with a non-integer ?since= — 400 invalid-request, not a silently-empty page", async () => {
    const { dispatcher } = setup();
    const started = startRoundResponseSchema.parse(
      JSON.parse(
        asStructured(
          await dispatcher(
            makeEvent({ method: "POST", path: "/rounds", body: { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } } }),
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
});

// M6 Task 4: the course CRUD/search surface + the pre-join peek — all `auth: "none"`
// (routes.ts's why-comment: identity is M7, rate-limiting/abuse is M9).
describe("createDispatcher — course routes + peek (M6 Task 4)", () => {
  it("drives create -> add a second tee -> verify -> get -> search over HTTP", async () => {
    const { dispatcher } = setup();

    const createResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: "/courses", body: { name: "Casa Verde GC", tee: fixtureWhite, enteredBy: "Ann" } }),
      ),
    );
    expect(createResp.statusCode).toBe(201);
    const created = createCourseResponseSchema.parse(JSON.parse(createResp.body!));
    expect(created.course.name).toBe("Casa Verde GC");

    const blueTee = { ...fixtureWhite, name: "blue", rating: 73.1, slope: 132 };
    const addTeeResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/courses/${created.course.courseId}/tees`,
          body: { tee: blueTee, enteredBy: "Bo" },
        }),
      ),
    );
    expect(addTeeResp.statusCode).toBe(201);
    const withTee = addTeeSetResponseSchema.parse(JSON.parse(addTeeResp.body!));
    expect(withTee.course.card.teeSets.map((tee) => tee.name).sort()).toEqual(["blue", "white"]);

    const verifyResp = asStructured(
      await dispatcher(
        makeEvent({
          method: "POST",
          path: `/courses/${created.course.courseId}/verify`,
          body: { teeName: "white", verifierName: "Cal" },
        }),
      ),
    );
    expect(verifyResp.statusCode).toBe(200);
    const verified = verifyTeeSetResponseSchema.parse(JSON.parse(verifyResp.body!));
    expect(verified.course.teeSets.find((tee) => tee.name === "white")?.verifiedBy).toEqual(["Cal"]);

    const getResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: `/courses/${created.course.courseId}` })));
    expect(getResp.statusCode).toBe(200);
    const fetched = getCourseResponseSchema.parse(JSON.parse(getResp.body!));
    expect(fetched.course.courseId).toBe(created.course.courseId);

    const searchResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/courses", query: { query: "Casa" } })));
    expect(searchResp.statusCode).toBe(200);
    const searched = searchCoursesResponseSchema.parse(JSON.parse(searchResp.body!));
    expect(searched.courses.map((c) => c.name)).toEqual(["Casa Verde GC"]);
  });

  it("404s GET /courses/{courseId} for an unknown id — course-not-found", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/courses/does-not-exist" })));
    expect(resp.statusCode).toBe(404);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "course-not-found" });
  });

  it("400s GET /courses with no ?query= — invalid-request, never an empty-string search", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/courses" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("400s a zod-invalid POST /courses body — invalid-request", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "POST", path: "/courses", body: { name: "Casa Verde GC" } })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("peeks a live round by join code — courseName + tee summaries, over HTTP", async () => {
    const { dispatcher } = setup();
    const startResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: "/rounds", body: { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } } }),
      ),
    );
    const started = startRoundResponseSchema.parse(JSON.parse(startResp.body!));

    const peekResp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/peek", query: { code: started.joinCode } })));
    expect(peekResp.statusCode).toBe(200);
    const peeked = peekRoundResponseSchema.parse(JSON.parse(peekResp.body!));
    expect(peeked.courseName).toBe(fixtureLinks.courseName);
  });

  it("400s GET /rounds/peek with no ?code= — invalid-request", async () => {
    const { dispatcher } = setup();
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/peek" })));
    expect(resp.statusCode).toBe(400);
    expect(errorResponseSchema.parse(JSON.parse(resp.body!))).toMatchObject({ code: "invalid-request" });
  });

  it("404s GET /rounds/peek with an unknown join code — bad-join-code, not a 401", async () => {
    const { dispatcher } = setup();
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
    const { dispatcher } = setup();
    const startResp = asStructured(
      await dispatcher(
        makeEvent({ method: "POST", path: "/rounds", body: { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } } }),
      ),
    );
    const started = startRoundResponseSchema.parse(JSON.parse(startResp.body!));

    // No `token` — if this were (mis)matched to the participant-gated events route it would
    // 401 (invalid-token), never reach peekRound.
    const resp = asStructured(await dispatcher(makeEvent({ method: "GET", path: "/rounds/peek", query: { code: started.joinCode } })));
    expect(resp.statusCode).toBe(200);
    const peeked = peekRoundResponseSchema.parse(JSON.parse(resp.body!));
    expect(Object.keys(peeked).sort()).toEqual(["courseName", "teeSets"]);
  });
});
