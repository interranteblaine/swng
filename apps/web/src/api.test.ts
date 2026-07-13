import { afterEach, describe, expect, it, vi } from "vitest";
import { courseId, crewId, fixtureLinks, gameId, golferId, roundId } from "@swng/domain";
import type {
  AddCrewMemberRequest,
  AddGameRequest,
  AddParticipantRequest,
  AddTeeSetRequest,
  ClaimGolferRequest,
  CreateCourseRequest,
  CreateCrewRequest,
  JoinCrewRequest,
  JoinRoundRequest,
  SaveStandingGameRequest,
  StartRoundRequest,
  UpdateMeRequest,
  VerifyTeeSetRequest,
} from "@swng/contracts";
import {
  addCrewMember,
  addGame,
  addParticipant,
  addTeeSet,
  ApiError,
  claimGolfer,
  createCourse,
  createCrew,
  createRound,
  finalizeRound,
  getCourse,
  getCrew,
  getCrewRecords,
  getMe,
  getMyRecord,
  getMyRounds,
  getRoundArchive,
  joinCrew,
  joinRound,
  listMyCrews,
  peekRound,
  saveStandingGame,
  searchCourses,
  shareRound,
  terminateGame,
  updateMe,
  verifyTeeSet,
} from "./api";

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

  // M8 Task 5 (play as yourself): an optional Bearer token, attached only when the caller
  // passes one — "optional-golfer" on the wire, same shape-preserving idiom as the token param
  // already on addGame/finalizeRound, just optional here since an anonymous create must stay
  // byte-identical to the call above (no `token` arg at all).
  it("attaches a Bearer token when one is given, alongside a golferId in the body (as-self create)", async () => {
    let seenInit: RequestInit | undefined;
    stubFetch(async (_url, init) => {
      seenInit = init;
      return fakeResponse(201, { roundId: "round-self", joinCode: "SELF01", token: "tok-self", golferId: "ann-g" });
    });

    const selfInput: StartRoundRequest = { ...input, golferId: golferId("ann-g") };
    await createRound(selfInput, "tok-caller");

    expect(JSON.parse(String(seenInit?.body))).toEqual(selfInput);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-caller");
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

  // Same optional-Bearer story as createRound above (M8 Task 5).
  it("attaches a Bearer token when one is given, alongside a golferId in the body (as-self join)", async () => {
    let seenInit: RequestInit | undefined;
    stubFetch(async (_url, init) => {
      seenInit = init;
      return fakeResponse(201, { roundId: "round-1", token: "tok-2", golferId: "bo-g" });
    });

    const selfInput: JoinRoundRequest = { ...input, golferId: golferId("bo-g") };
    await joinRound(selfInput, "tok-caller");

    expect(JSON.parse(String(seenInit?.body))).toEqual(selfInput);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-caller");
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

describe("addParticipant", () => {
  it("POSTs the request body to /rounds/{roundId}/players with the bearer token and parses the events response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { events: [] });
    });

    const input: AddParticipantRequest = { name: "Dave", tee: "white", courseHandicap: 10 };
    const result = await addParticipant(roundId("round-1"), "tok-add", input);

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/players`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-add");
    expect(result).toEqual({ events: [] });
  });

  it("carries a supplied golferId (the crew quick-add's stable id) verbatim in the body", async () => {
    let seenInit: RequestInit | undefined;
    stubFetch(async (_url, init) => {
      seenInit = init;
      return fakeResponse(201, { events: [] });
    });

    const input: AddParticipantRequest = { name: "Cal", tee: "blue", courseHandicap: 5, golferId: golferId("cal-crew") };
    await addParticipant(roundId("round-1"), "tok-add", input);

    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
  });
});

describe("getCrew", () => {
  it("GETs /crews/{crewId} with the bearer token and parses a GetCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crew: { crewId: "crew-1", name: "Sunday crew", joinCode: "ZZZ111", members: [] } });
    });

    const result = await getCrew("tok-crew", crewId("crew-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result.crew.crewId).toBe(crewId("crew-1"));
  });

  it("throws a coded ApiError on a non-member 403", async () => {
    stubFetch(async () => fakeResponse(403, { code: "not-a-member", message: "not a member of this crew" }));

    const error: unknown = await getCrew("tok-crew", crewId("crew-1")).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("not-a-member");
  });
});

// M8 Task 6: the crew home + "play the usual" surface — same requestJson + bearer-token idiom
// as every golfer-gated call above.
describe("createCrew", () => {
  it("POSTs { name } to /crews with the bearer token and parses a CreateCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { crew: { crewId: "crew-1", name: "Sunday crew", joinCode: "ZZZ111", members: [] } });
    });

    const input: CreateCrewRequest = { name: "Sunday crew" };
    const result = await createCrew("tok-crew", input);

    expect(seenUrl).toBe(`${HTTP_URL}/crews`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result.crew.crewId).toBe(crewId("crew-1"));
  });
});

describe("joinCrew", () => {
  it("POSTs { code } to /crews/join with the bearer token and parses a JoinCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crew: { crewId: "crew-1", name: "Sunday crew", joinCode: "ZZZ111", members: [] } });
    });

    const input: JoinCrewRequest = { code: "ZZZ111" };
    const result = await joinCrew("tok-me", input);

    expect(seenUrl).toBe(`${HTTP_URL}/crews/join`);
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.crew.crewId).toBe(crewId("crew-1"));
  });

  it("throws a coded ApiError('unknown-crew') on an unknown code", async () => {
    stubFetch(async () => fakeResponse(404, { code: "unknown-crew", message: "no crew with that code" }));

    const error: unknown = await joinCrew("tok-me", { code: "ZZZ999" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("unknown-crew");
  });
});

describe("listMyCrews", () => {
  it("GETs /me/crews with the bearer token and parses a ListMyCrewsResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crews: [{ crewId: "crew-1", name: "Sunday crew", memberCount: 4 }] });
    });

    const result = await listMyCrews("tok-me");

    expect(seenUrl).toBe(`${HTTP_URL}/me/crews`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-me");
    expect(result).toEqual({ crews: [{ crewId: crewId("crew-1"), name: "Sunday crew", memberCount: 4 }] });
  });
});

describe("addCrewMember", () => {
  // De-ghost (architecture-realignment Task 9): the body is now { golferId }, not { name }.
  it("POSTs { golferId } to /crews/{crewId}/members with the bearer token and parses an AddCrewMemberResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { crew: { crewId: "crew-1", name: "Sunday crew", joinCode: "ZZZ111", members: [{ golferId: "dave-g", name: "Dave", role: "member", claimed: true }] } });
    });

    const input: AddCrewMemberRequest = { golferId: golferId("dave-g") };
    const result = await addCrewMember("tok-crew", crewId("crew-1"), input);

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/members`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.crew.members).toEqual([{ golferId: golferId("dave-g"), name: "Dave", role: "member", claimed: true }]);
  });
});

describe("saveStandingGame", () => {
  it("PUTs { standingGame } to /crews/{crewId}/standing-game with the bearer token and parses a SaveStandingGameResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crew: { crewId: "crew-1", name: "Sunday crew", joinCode: "ZZZ111", members: [] } });
    });

    const input: SaveStandingGameRequest = { standingGame: { courseId: courseId("course-1"), tee: "white", games: [] } };
    const result = await saveStandingGame("tok-crew", crewId("crew-1"), input);

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/standing-game`);
    expect(seenInit?.method).toBe("PUT");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.crew.crewId).toBe(crewId("crew-1"));
  });
});

describe("getCrewRecords", () => {
  it("GETs /crews/{crewId}/records (no ?season=) with the bearer token and parses a GetCrewRecordsResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { season: 2026, ledger: [], headToHead: [] });
    });

    const result = await getCrewRecords("tok-crew", crewId("crew-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/records`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result).toEqual({ season: 2026, ledger: [], headToHead: [] });
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

// M9 Task 3 (share): same POST + bearer-token idiom as finalizeRound above.
describe("shareRound", () => {
  it("POSTs to /rounds/{roundId}/share with the bearer token and parses the response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { url: "/watch/round-1#spectator-token" });
    });

    const result = await shareRound(roundId("round-1"), "tok-4");

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/share`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-4");
    expect(result).toEqual({ url: "/watch/round-1#spectator-token" });
  });

  it("surfaces a fetch rejection as ApiError('network')", async () => {
    stubFetch(async () => {
      throw new Error("offline");
    });

    const error: unknown = await shareRound(roundId("round-1"), "tok-4").catch((caught: unknown) => caught);

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

    const input: VerifyTeeSetRequest = { teeName: "white", verifierName: "Bo", version: 1 };
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

// M7 Task 6: the golfer identity surface + game termination — same requestJson + bearer-token
// idiom as addGame/finalizeRound above (auth: "golfer"/"participant" on the wire, never "none").
describe("getMe", () => {
  it("GETs /me with the bearer token and parses a GetMeResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
    });

    const result = await getMe("tok-me");

    expect(seenUrl).toBe(`${HTTP_URL}/me`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-me");
    expect(result).toEqual({ golfer: { golferId: golferId("ann"), name: "Ann" } });
  });

  // GET /me NEVER creates (the plan's amendment) — a signed-in user with no golfer row gets
  // `golfer: null`, and api.ts must pass that through rather than choking on it.
  it("parses a null golfer for an unbound sub", async () => {
    stubFetch(async () => fakeResponse(200, { golfer: null }));

    const result = await getMe("tok-me");

    expect(result).toEqual({ golfer: null });
  });
});

describe("updateMe", () => {
  it("PUTs the request body to /me with the bearer token and parses a GolferResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann Updated", declared: 12.3 } });
    });

    const input: UpdateMeRequest = { name: "Ann Updated", declared: 12.3 };
    const result = await updateMe("tok-me", input);

    expect(seenUrl).toBe(`${HTTP_URL}/me`);
    expect(seenInit?.method).toBe("PUT");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-me");
    expect(result.golfer.name).toBe("Ann Updated");
  });
});

describe("claimGolfer", () => {
  it("POSTs { golferId } to /golfers/claim with the bearer token and parses a GolferResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { golfer: { golferId: "ghost-1", name: "Ghost" } });
    });

    const input: ClaimGolferRequest = { golferId: golferId("ghost-1"), code: "ABC123" };
    const result = await claimGolfer("tok-me", input);

    expect(seenUrl).toBe(`${HTTP_URL}/golfers/claim`);
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-me");
    expect(result).toEqual({ golfer: { golferId: golferId("ghost-1"), name: "Ghost" } });
  });

  it("throws a coded ApiError('golfer-already-claimed') on a 409", async () => {
    stubFetch(async () => fakeResponse(409, { code: "golfer-already-claimed", message: "already claimed" }));

    const error: unknown = await claimGolfer("tok-me", { golferId: golferId("ghost-1"), code: "ABC123" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("golfer-already-claimed");
  });
});

describe("getMyRecord", () => {
  it("GETs /me/record with the bearer token and parses a GetMyRecordResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { history: [] });
    });

    const result = await getMyRecord("tok-me");

    expect(seenUrl).toBe(`${HTTP_URL}/me/record`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-me");
    expect(result).toEqual({ history: [] });
  });
});

describe("getMyRounds", () => {
  it("GETs /me/rounds with the bearer token and parses a GetMyRoundsResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { rounds: [] });
    });

    const result = await getMyRounds("tok-me");

    expect(seenUrl).toBe(`${HTTP_URL}/me/rounds`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-me");
    expect(result).toEqual({ rounds: [] });
  });
});

describe("getRoundArchive", () => {
  it("GETs /rounds/{roundId}/archive with the bearer token and parses a GetRoundArchiveResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { events: [] });
    });

    const result = await getRoundArchive("tok-archive", roundId("round-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/archive`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-archive");
    expect(result).toEqual({ events: [] });
  });
});

describe("terminateGame", () => {
  it("POSTs to /rounds/{roundId}/games/{gameId}/terminate with the bearer token and parses a TerminateGameResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { events: [] });
    });

    const result = await terminateGame(roundId("round-1"), "tok-term", gameId("game-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/games/game-1/terminate`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-term");
    expect(result).toEqual({ events: [] });
  });
});
