import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, golferId, roundId } from "@swng/domain";
import type { AddGameRequest, JoinRoundRequest, StartRoundRequest } from "@swng/contracts";
import { addGame, ApiError, createRound, finalizeRound, joinRound } from "./api";

// Pinned to match vitest.config.ts's test.env.VITE_HTTP_URL — config.ts reads it at import
// time, so every test in this file shares the same fake origin.
const HTTP_URL = "https://api.example.test";

const fakeResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal("fetch", vi.fn(impl));
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
