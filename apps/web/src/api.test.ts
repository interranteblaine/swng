import { afterEach, describe, expect, it, vi } from "vitest";
import { cardId, courseId, crewId, gameId, golferId, roundId } from "@swng/domain";
import type {
  AddGameRequest,
  AppendCountedRoundRequest,
  CreateCourseRequest,
  CreateCrewRequest,
  CreateSeasonRequest,
  JoinCrewRequest,
  JoinRoundRequest,
  StartRoundRequest,
  SupersedeCardRequest,
  UpdateMeRequest,
} from "@swng/contracts";
import {
  addGame,
  appendCountedRound,
  ApiError,
  createCourse,
  createCrew,
  createRound,
  createSeason,
  finalizeRound,
  getCourse,
  getCrew,
  getMe,
  getMyLiveRounds,
  getMyRecord,
  getMyRounds,
  getRoundArchive,
  getSeasonStandings,
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
  removeCountedRound,
  removeCrewMember,
  searchCourses,
  shareRound,
  supersedeCard,
  terminateGame,
  transferOrganizer,
  updateMe,
} from "./api";

// Pinned to match vitest.config.ts's test.env.VITE_HTTP_URL — config.ts reads it at import
// time, so every test in this file shares the same fake origin.
const HTTP_URL = "https://api.example.test";

const fakeResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal("fetch", vi.fn(impl));
};

// One CourseView wire body (course-cards spec §4) reused by every course-endpoint test below —
// a single hole is enough to exercise courseCardSchema (this is api.ts's own wire-parsing test,
// not domain's invariant tests, which already cover the real 9/18-hole shape elsewhere).
const courseViewJson = {
  courseId: "course-1",
  cardId: "card-1",
  card: {
    courseName: "Pebble Beach",
    source: { cardId: "card-1", courseId: "course-1" },
    teeSets: [{ teeId: "t-white", name: "white", rating: 71.8, slope: 130, holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] }],
  },
  enteredBy: "Ann",
  updatedAtMs: 1_700_000_000_000,
};

// An input tee for a create/supersede request: no teeId (the server mints/tracks ids).
const inputTee = { name: "white", rating: 71.8, slope: 130, holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRound", () => {
  const input: StartRoundRequest = { course: { courseId: courseId("course-1"), cardId: cardId("card-1") }, host: { tee: "white", courseHandicap: 8 } };

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

  // Accounts-only identity (spec §3): "golfer"-gated on the wire — the caller always attaches
  // their own Bearer, and the seat is resolved server-side (no name/golferId in the body). Same
  // shape-preserving token-attach idiom as addGame/finalizeRound.
  it("attaches a Bearer token to the request (as-self create)", async () => {
    let seenInit: RequestInit | undefined;
    stubFetch(async (_url, init) => {
      seenInit = init;
      return fakeResponse(201, { roundId: "round-self", joinCode: "SELF01", token: "tok-self", golferId: "ann-g" });
    });

    await createRound(input, "tok-caller");

    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-caller");
  });
});

describe("joinRound", () => {
  const input: JoinRoundRequest = { code: "ABC123", tee: "white", courseHandicap: 2 };

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

  // Same "golfer"-gated as-self story as createRound above (accounts-only identity spec §3).
  it("attaches a Bearer token to the request (as-self join)", async () => {
    let seenInit: RequestInit | undefined;
    stubFetch(async (_url, init) => {
      seenInit = init;
      return fakeResponse(201, { roundId: "round-1", token: "tok-2", golferId: "bo-g" });
    });

    await joinRound(input, "tok-caller");

    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
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

describe("getCrew", () => {
  it("GETs /crews/{crewId} with the bearer token and parses a GetCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crew: { crewId: "crew-1", name: "Sunday crew", members: [] } });
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

// M8 Task 6: the crew home surface — same requestJson + bearer-token idiom as every
// golfer-gated call above.
describe("createCrew", () => {
  it("POSTs { name } to /crews with the bearer token and parses a CreateCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { crew: { crewId: "crew-1", name: "Sunday crew", members: [] } });
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

// Crew membership (invited in, accountable out — spec §2/§3): the permanent join code is gone
// — POST /crews/join now carries the SAME bearer-shaped `token` a mint response hands out.
describe("joinCrewByInvite", () => {
  it("POSTs { token } to /crews/join with the bearer token and parses a JoinCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crew: { crewId: "crew-1", name: "Sunday crew", members: [] } });
    });

    const input: JoinCrewRequest = { token: "invite-token-1" };
    const result = await joinCrewByInvite("tok-me", input);

    expect(seenUrl).toBe(`${HTTP_URL}/crews/join`);
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.crew.crewId).toBe(crewId("crew-1"));
  });

  it("throws a coded ApiError('crew-invite-expired') on an expired invite", async () => {
    stubFetch(async () => fakeResponse(403, { code: "crew-invite-expired", message: "invite token expired" }));

    const error: unknown = await joinCrewByInvite("tok-me", { token: "stale-token" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("crew-invite-expired");
  });
});

// Crew membership (invited in, accountable out — spec §2): ANY member mints a fresh 7-day
// invite link — same POST + bearer-token idiom as every crew call above.
describe("mintCrewInvite", () => {
  it("POSTs to /crews/{crewId}/invites with the bearer token and parses a MintCrewInviteResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { token: "invite-token-1", expiresAtMs: 1_700_000_000_000 });
    });

    const result = await mintCrewInvite("tok-crew", crewId("crew-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/invites`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result).toEqual({ token: "invite-token-1", expiresAtMs: 1_700_000_000_000 });
  });
});

// Crew membership (invited in, accountable out — spec §2): auth "none" — the consent screen's
// preview, mirroring peekRound's own "none"-auth shape above.
describe("peekCrewInvite", () => {
  it("POSTs { token } to /crews/peek with NO bearer token and parses a PeekCrewInviteResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crewName: "The Saturday Boys", memberCount: 8, inviterName: "Al" });
    });

    const result = await peekCrewInvite({ token: "invite-token-1" });

    expect(seenUrl).toBe(`${HTTP_URL}/crews/peek`);
    expect(JSON.parse(String(seenInit?.body))).toEqual({ token: "invite-token-1" });
    expect((seenInit?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    expect(result).toEqual({ crewName: "The Saturday Boys", memberCount: 8, inviterName: "Al" });
  });

  it("throws a coded ApiError('crew-invite-invalid') on a bad token", async () => {
    stubFetch(async () => fakeResponse(403, { code: "crew-invite-invalid", message: "invite token invalid" }));

    const error: unknown = await peekCrewInvite({ token: "garbage" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("crew-invite-invalid");
  });
});

// Crew membership (invited in, accountable out — spec §1): the organizer's authority — no
// request schema, the target golferId rides the path.
describe("removeCrewMember", () => {
  it("DELETEs /crews/{crewId}/members/{golferId} with the bearer token and parses a GetCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crew: { crewId: "crew-1", name: "Sunday crew", members: [] } });
    });

    const result = await removeCrewMember("tok-crew", crewId("crew-1"), golferId("bo-g"));

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/members/bo-g`);
    expect(seenInit?.method).toBe("DELETE");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result.crew.crewId).toBe(crewId("crew-1"));
  });

  it("throws a coded ApiError('not-organizer') on a 403", async () => {
    stubFetch(async () => fakeResponse(403, { code: "not-organizer", message: "caller is not the organizer" }));

    const error: unknown = await removeCrewMember("tok-crew", crewId("crew-1"), golferId("bo-g")).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("not-organizer");
  });
});

describe("transferOrganizer", () => {
  it("POSTs { golferId } to /crews/{crewId}/transfer with the bearer token and parses a GetCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crew: { crewId: "crew-1", name: "Sunday crew", members: [] } });
    });

    const result = await transferOrganizer("tok-crew", crewId("crew-1"), { golferId: golferId("bo-g") });

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/transfer`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual({ golferId: "bo-g" });
    expect(result.crew.crewId).toBe(crewId("crew-1"));
  });

  it("throws a coded ApiError('not-a-member') when the target has left the crew", async () => {
    stubFetch(async () => fakeResponse(403, { code: "not-a-member", message: "golfer bo-g is not a member of crew crew-1" }));

    const error: unknown = await transferOrganizer("tok-crew", crewId("crew-1"), { golferId: golferId("bo-g") }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("not-a-member");
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

// Architecture-realignment Task 11: crew seasons + counted rounds + standings-on-read + leave —
// same requestJson + bearer-token idiom as every crew call above.
describe("createSeason", () => {
  it("POSTs { name } to /crews/{crewId}/seasons with the bearer token and parses a CreateSeasonResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { season: { seasonId: "s-1", name: "2026", status: "open", createdAtMs: 1_700_000_000_000 } });
    });

    const input: CreateSeasonRequest = { name: "2026" };
    const result = await createSeason("tok-crew", crewId("crew-1"), input);

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/seasons`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result.season.seasonId).toBe("s-1");
  });

  it("throws a coded ApiError('invalid-season-name') on a 400", async () => {
    stubFetch(async () => fakeResponse(400, { code: "invalid-season-name", message: "season name must be 1-60 characters" }));

    const error: unknown = await createSeason("tok-crew", crewId("crew-1"), { name: "" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid-season-name");
  });
});

describe("listSeasons", () => {
  it("GETs /crews/{crewId}/seasons with the bearer token and parses a ListSeasonsResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { seasons: [{ seasonId: "s-1", name: "2026", status: "open", createdAtMs: 1_700_000_000_000 }] });
    });

    const result = await listSeasons("tok-crew", crewId("crew-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/seasons`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result.seasons).toHaveLength(1);
  });
});

describe("appendCountedRound", () => {
  it("POSTs { roundId } to /crews/{crewId}/seasons/{seasonId}/rounds with the bearer token and parses an AppendCountedRoundResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { round: { roundId: "round-1", finalizedAt: 1_700_000_000_000, appendedBy: "ann-g" } });
    });

    const input: AppendCountedRoundRequest = { roundId: roundId("round-1") };
    const result = await appendCountedRound("tok-crew", crewId("crew-1"), "season-1", input);

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/seasons/season-1/rounds`);
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.round.roundId).toBe(roundId("round-1"));
  });

  it("throws a coded ApiError('round-already-counted') on a 409", async () => {
    stubFetch(async () => fakeResponse(409, { code: "round-already-counted", message: "round round-1 is already counted in season season-1 of crew crew-1" }));

    const error: unknown = await appendCountedRound("tok-crew", crewId("crew-1"), "season-1", { roundId: roundId("round-1") }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("round-already-counted");
  });
});

describe("removeCountedRound", () => {
  it("DELETEs /crews/{crewId}/seasons/{seasonId}/rounds/{roundId} with the bearer token and parses a RemoveCountedRoundResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { roundId: "round-1" });
    });

    const result = await removeCountedRound("tok-crew", crewId("crew-1"), "season-1", roundId("round-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/seasons/season-1/rounds/round-1`);
    expect(seenInit?.method).toBe("DELETE");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result).toEqual({ roundId: roundId("round-1") });
  });

  it("throws a coded ApiError('not-the-appender') on a 403", async () => {
    stubFetch(async () => fakeResponse(403, { code: "not-the-appender", message: "only the appending member may remove this round" }));

    const error: unknown = await removeCountedRound("tok-crew", crewId("crew-1"), "season-1", roundId("round-1")).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("not-the-appender");
  });
});

describe("getSeasonStandings", () => {
  it("GETs /crews/{crewId}/seasons/{seasonId}/standings with the bearer token and parses a SeasonStandingsResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [] });
    });

    const result = await getSeasonStandings("tok-crew", crewId("crew-1"), "season-1");

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/seasons/season-1/standings`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result.seasonId).toBe("season-1");
  });
});

describe("leaveCrew", () => {
  it("POSTs to /crews/{crewId}/leave with the bearer token and parses a LeaveCrewResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { crewId: "crew-1" });
    });

    const result = await leaveCrew("tok-crew", crewId("crew-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/crews/crew-1/leave`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-crew");
    expect(result).toEqual({ crewId: crewId("crew-1") });
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
    expect(result.course.enteredBy).toBe("Ann");
  });
});

describe("searchCourses", () => {
  it("GETs /courses?query=... (percent-encoded) and parses the results with holeCount", async () => {
    let seenUrl: string | undefined;
    stubFetch(async (url) => {
      seenUrl = String(url);
      return fakeResponse(200, { courses: [{ courseId: "course-1", name: "Pebble Beach", holeCount: 18 }] });
    });

    const result = await searchCourses("pebble beach");

    expect(seenUrl).toBe(`${HTTP_URL}/courses?query=pebble+beach`);
    expect(result).toEqual({ courses: [{ courseId: courseId("course-1"), name: "Pebble Beach", holeCount: 18 }] });
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
  const input: CreateCourseRequest = { name: "Pebble Beach", teeSets: [inputTee] };

  it("POSTs the request body + Bearer to /courses and parses a CourseView response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(201, { course: courseViewJson });
    });

    const result = await createCourse(input, "tok-1");

    expect(seenUrl).toBe(`${HTTP_URL}/courses`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.course.card.courseName).toBe("Pebble Beach");
  });

  // The exact scenario AddCoursePage's inline-per-code display depends on — a domain
  // validation rejection surfaces here as a coded ApiError, same shape as every other
  // rejection this module maps (not a special case).
  it("throws a coded ApiError for a domain validation rejection", async () => {
    stubFetch(async () => fakeResponse(400, { code: "invalid-rating", message: 'tee "white" rating 200 outside 30..90' }));

    const error: unknown = await createCourse(input, "tok-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid-rating");
  });
});

describe("supersedeCard", () => {
  it("PUTs the whole-card body + Bearer to /courses/{courseId} and parses a CourseView response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { course: courseViewJson });
    });

    const input: SupersedeCardRequest = { name: "Pebble Beach", teeSets: [{ ...inputTee, teeId: "t-white" }], supersedes: "card-0" };
    const result = await supersedeCard(courseId("course-1"), input, "tok-2");

    expect(seenUrl).toBe(`${HTTP_URL}/courses/course-1`);
    expect(seenInit?.method).toBe("PUT");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-2");
    expect(JSON.parse(String(seenInit?.body))).toEqual(input);
    expect(result.course.cardId).toBe("card-1");
  });
});

describe("peekRound", () => {
  it("GETs /rounds/peek?code=... and parses the preview response", async () => {
    let seenUrl: string | undefined;
    stubFetch(async (url) => {
      seenUrl = String(url);
      return fakeResponse(200, { courseName: "Pebble Beach", teeSets: [{ name: "white", par: 72, rating: 71.8, slope: 130 }], createdAt: 1_700_000_000_000 });
    });

    const result = await peekRound("ABC123");

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/peek?code=ABC123`);
    expect(result).toEqual({ courseName: "Pebble Beach", teeSets: [{ name: "white", par: 72, rating: 71.8, slope: 130 }], createdAt: 1_700_000_000_000 });
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

describe("getMyRecord", () => {
  it("GETs /me/record with the bearer token and parses a GetMyRecordResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { metrics: {}, history: [] });
    });

    const result = await getMyRecord("tok-me");

    expect(seenUrl).toBe(`${HTTP_URL}/me/record`);
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-me");
    expect(result).toEqual({ metrics: {}, history: [] });
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

describe("getMyLiveRounds", () => {
  it("GETs /me/rounds/live with the bearer token and parses a GetMyLiveRoundsResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { rounds: [] });
    });

    const result = await getMyLiveRounds("tok-me");

    expect(seenUrl).toBe(`${HTTP_URL}/me/rounds/live`);
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

describe("mintParticipantToken", () => {
  it("POSTs to /rounds/{roundId}/token with the bearer token and parses a JoinRoundResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { roundId: "round-1", token: "fresh-token", golferId: "golfer-1" });
    });

    const result = await mintParticipantToken("tok-mint", roundId("round-1"));

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/token`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-mint");
    expect(result).toEqual({ roundId: roundId("round-1"), token: "fresh-token", golferId: golferId("golfer-1") });
  });
});

// accounts-only identity spec §4: same POST + bearer-token (participant) idiom as terminateGame
// below — no body, and the appended participant-left events come back for the caller to fold.
describe("leaveRound", () => {
  it("POSTs to /rounds/{roundId}/leave with the bearer token and parses a LeaveRoundResponse", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return fakeResponse(200, { events: [] });
    });

    const result = await leaveRound(roundId("round-1"), "tok-leave");

    expect(seenUrl).toBe(`${HTTP_URL}/rounds/round-1/leave`);
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer tok-leave");
    expect(seenInit).not.toHaveProperty("token");
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
