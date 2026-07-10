import { afterEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureLinks, golferId, roundId } from "@swng/domain";
import type { AddGameRequest, AddTeeSetRequest, CreateCourseRequest, JoinRoundRequest, StartRoundRequest, VerifyTeeSetRequest } from "@swng/contracts";
import { addGame, addTeeSet, ApiError, createCourse, createRound, finalizeRound, getCourse, joinRound, peekRound, searchCourses, verifyTeeSet } from "./api";

// Pinned to match vitest.config.ts's test.env.VITE_HTTP_URL — config.ts reads it at import
// time, so every test in this file shares the same fake origin.
const HTTP_URL = "https://api.example.test";

const fakeResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal("fetch", vi.fn(impl));
};

// One CourseView wire body reused by every course-endpoint test below — a single hole is
// enough to exercise courseCardSchema (this is api.ts's own wire-parsing test, not domain's
// invariant tests, which already cover the real 9/18-hole shape elsewhere).
const courseViewJson = {
  courseId: "course-1",
  name: "Pebble Beach",
  card: {
    courseName: "Pebble Beach",
    teeSets: [{ name: "white", rating: 71.8, slope: 130, holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] }],
  },
  teeSets: [{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRound", () => {
  const input: StartRoundRequest = { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } };

  it("POSTs the request body to /rounds and parses a matching response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { roundId: "round-1", joinCode: "ABC123", token: "tok-1", golferId: "ann" });
    });

    const result = await createRound(input);

    expect(seenUrl).toBe(`${HTTP_URL}/rounds`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input); // wire body matches StartRoundRequest exactly
    expect(result).toEqual({ roundId: roundId("round-1"), joinCode: "ABC123", token: "tok-1", golferId: golferId("ann") });
  });

  it("throws a coded ApiError when the server rejects with an error body", async () => {
    stubFetch(async () => fakeResponse(400, { code: "invalid-request", message: "card is missing a tee set" }));

    const error: unknown = await createRound(input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error as ApiError).toMatchObject({ code: "invalid-request", status: 400 });
  });
});

describe("joinRound", () => {
  const input: JoinRoundRequest = { code: "ABC123", name: "Bo", tee: "white", courseHandicap: 2 };

  it("POSTs the request body to /rounds/join and parses a matching response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { roundId: "round-1", token: "tok-2", golferId: "bo" });
    });

    const result = await joinRound(input);

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/join`);
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result).toEqual({ roundId: roundId("round-1"), token: "tok-2", golferId: golferId("bo") });
  });

  it("throws a coded ApiError on a bad join code", async () => {
    stubFetch(async () => fakeResponse(404, { code: "bad-join-code", message: "no round with that code" }));

    const error: unknown = await joinRound(input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("bad-join-code");
  });
});

describe("addGame", () => {
  it("POSTs { game } to /rounds/{roundId}/games with the bearer token and parses the response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { gameId: "game-1", seq: 5 });
    });

    const game: AddGameRequest["game"] = { kind: "stableford", players: [golferId("ann"), golferId("bo")] };
    const result = await addGame(roundId("round-1"), "tok-3", game);

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/games`);
    expect(JSON.parse(String(seenInit?.body))).toEqual({ game });
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-3");
    // `token` is api.ts's own internal init property, not a real RequestInit member — it must
    // never reach the actual fetch() call (fetch would ignore it silently, but it's still a
    // leak of a bespoke property into a standard API surface).
    expect(seenInit).not.toHaveProperty("token");
    expect(result).toEqual({ gameId: expect.anything(), seq: 5 });
  });
});

describe("finalizeRound", () => {
  it("POSTs to /rounds/{roundId}/finalize with the bearer token and parses the response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { results: [], handicapping: [] });
    });

    const result = await finalizeRound(roundId("round-1"), "tok-4");

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/finalize`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-4");
    expect(seenInit).not.toHaveProperty("token");
    expect(result).toEqual({ results: [], handicapping: [] });
  });

  it("surfaces a fetch rejection as ApiError('network')", async () => {
    stubFetch(async () => {
      throw new Error("offline");
    });

    const error: unknown = await finalizeRound(roundId("round-1"), "tok-4").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("network");
  });
});

describe("getCourse", () => {
  it("GETs /courses/{courseId} and parses a CourseView response", async () => {
    let seenUrl: string | undefined;
    stubFetch(async (url) => {
      seenUrl = String(url);
      return fakeResponse(200, { course: courseViewJson });
    });

    const result = await getCourse(courseId("course-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/courses/course-1`);
    expect(result.course.courseId).toBe(courseId("course-1"));
    expect(result.course.card).toEqual(courseViewJson.card);
  });
});

describe("searchCourses", () => {
  it("GETs /courses?query=... (percent-encoded) and parses the results", async () => {
    let seenUrl: string | undefined;
    stubFetch(async (url) => {
      seenUrl = String(url);
      return fakeResponse(200, { courses: [{ courseId: "course-1", name: "Pebble Beach" }] });
    });

    const result = await searchCourses("pebble beach");

    expect(seenUrl).toBe(`${HTTP_URL}/courses?query=pebble+beach`);
    expect(result).toEqual({ courses: [{ courseId: courseId("course-1"), name: "Pebble Beach" }] });
  });

  it("adds limit to the query string when given", async () => {
    let seenUrl: string | undefined;
    stubFetch(async (url) => {
      seenUrl = String(url);
      return fakeResponse(200, { courses: [] });
    });

    await searchCourses("pebble", 5);

    expect(seenUrl).toBe(`${HTTP_URL}/courses?query=pebble&limit=5`);
  });
});

describe("createCourse", () => {
  const input: CreateCourseRequest = { name: "Pebble Beach", tee: courseViewJson.card.teeSets[0]!, enteredBy: "Ann" };

  it("POSTs the request body to /courses and parses a CourseView response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { course: courseViewJson });
    });

    const result = await createCourse(input);

    expect(seenUrl).toBe(`${HTTP_URL}/courses`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.course.name).toBe("Pebble Beach");
  });

  // The exact scenario AddCoursePage's inline-per-code display depends on — a domain
  // validation rejection surfaces here as a coded ApiError, same shape as every other
  // rejection this module maps (not a special case).
  it("throws a coded ApiError for a domain validation rejection", async () => {
    stubFetch(async () => fakeResponse(400, { code: "invalid-rating", message: 'tee "white" rating 200 outside 30..90' }));

    const error: unknown = await createCourse(input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid-rating");
  });
});

describe("addTeeSet", () => {
  it("POSTs the request body to /courses/{courseId}/tees and parses a CourseView response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { course: courseViewJson });
    });

    const input: AddTeeSetRequest = { tee: courseViewJson.card.teeSets[0]!, enteredBy: "Bo" };
    const result = await addTeeSet(courseId("course-1"), input);

    expect(seenUrl).toBe(`${HTTP_URL}/courses/course-1/tees`);
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.course.name).toBe("Pebble Beach");
  });
});

describe("verifyTeeSet", () => {
  it("POSTs the request body to /courses/{courseId}/verify and parses a CourseView response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { course: courseViewJson });
    });

    const input: VerifyTeeSetRequest = { teeName: "white", verifierName: "Bo" };
    const result = await verifyTeeSet(courseId("course-1"), input);

    expect(seenUrl).toBe(`${HTTP_URL}/courses/course-1/verify`);
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.course.teeSets).toEqual(courseViewJson.teeSets);
  });
});

describe("peekRound", () => {
  it("GETs /rounds/peek?code=... and parses the preview response", async () => {
    let seenUrl: string | undefined;
    stubFetch(async (url) => {
      seenUrl = String(url);
      return fakeResponse(200, { courseName: "Pebble Beach", teeSets: [{ name: "white", rating: 71.8, slope: 130 }] });
    });

    const result = await peekRound("ABC123");

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/peek?code=ABC123`);
    expect(result).toEqual({ courseName: "Pebble Beach", teeSets: [{ name: "white", rating: 71.8, slope: 130 }] });
  });

  it("throws a coded ApiError on an unknown code", async () => {
    stubFetch(async () => fakeResponse(404, { code: "bad-join-code", message: "no round with that code" }));

    const error: unknown = await peekRound("ZZZ999").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("bad-join-code");
  });
});
