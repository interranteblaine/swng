import { describe, it, expect, beforeEach } from "vitest";
import { createHttpClient } from "../client/http";
import type { HttpPort } from "../client/types";

describe("client http (stateless)", () => {
  const calls: {
    url: string;
    init: { method?: string; headers?: Record<string, string>; body?: string };
  }[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  function makeHttpPort(): HttpPort {
    return {
      async request(req) {
        // record call
        calls.push({
          url: String(req.url),
          init: {
            method: req.method ?? "GET",
            headers: req.headers ?? {},
            body: req.body,
          },
        });

        // simulate endpoints used by tests
        if (String(req.url).endsWith("/rounds/join")) {
          const out = {
            roundId: "r1",
            sessionId: "s1",
            player: {
              roundId: "r1",
              playerId: "p1",
              name: "Alice",
              color: "#000000",
              joinedAt: "2020-01-01T00:00:00Z",
              updatedAt: "2020-01-01T00:00:00Z",
            },
            snapshot: {
              config: {
                roundId: "r1",
                accessCode: "AC",
                courseName: "Course",
                holes: 1,
                par: [3],
                createdAt: "2020-01-01T00:00:00Z",
              },
              state: {
                roundId: "r1",
                currentHole: 1,
                status: "IN_PROGRESS",
                stateVersion: 1,
                updatedAt: "2020-01-01T00:00:00Z",
              },
              players: [],
              scores: [],
            },
          };
          return {
            ok: true,
            status: 200,
            bodyText: JSON.stringify(out),
          };
        }

        if (/\/rounds\/r1$/.test(String(req.url))) {
          const out = {
            snapshot: {
              config: {
                roundId: "r1",
                accessCode: "AC",
                courseName: "Course",
                holes: 1,
                par: [3],
                createdAt: "2020-01-01T00:00:00Z",
              },
              state: {
                roundId: "r1",
                currentHole: 1,
                status: "IN_PROGRESS",
                stateVersion: 1,
                updatedAt: "2020-01-01T00:00:00Z",
              },
              players: [],
              scores: [],
            },
          };
          return {
            ok: true,
            status: 200,
            bodyText: JSON.stringify(out),
          };
        }

        if (/\/rounds\/r1\/scores$/.test(String(req.url))) {
          const out = {
            score: {
              roundId: "r1",
              playerId: "p1",
              holeNumber: 2,
              strokes: 4,
              updatedBy: "p1",
              updatedAt: "2020-01-01T00:00:00Z",
            },
          };
          return {
            ok: true,
            status: 200,
            bodyText: JSON.stringify(out),
          };
        }

        // default OK
        return {
          ok: true,
          status: 200,
          bodyText: "{}",
        };
      },
    };
  }

  it("joinRound returns values and getRound sends x-session-id", async () => {
    const base = "https://api.example.com";
    const http = createHttpClient(makeHttpPort(), base);

    const join = await http.joinRound({
      accessCode: "ABC123",
      playerName: "Alice",
    });

    expect(join.sessionId).toBe("s1");
    expect(join.roundId).toBe("r1");

    await http.getRound({ roundId: join.roundId, sessionId: join.sessionId });

    const last = calls[calls.length - 1];
    expect(last.url).toBe("https://api.example.com/rounds/r1");
    expect(last.init.headers?.["x-session-id"]).toBe("s1");
    expect(last.init.method).toBe("GET");
  });

  it("updateScore hits correct route/method and attaches x-session-id", async () => {
    const base = "https://api.example.com";
    const http = createHttpClient(makeHttpPort(), base);

    await http.updateScore({
      roundId: "r1",
      sessionId: "s1",
      playerId: "p1",
      holeNumber: 2,
      strokes: 4,
    });

    const last = calls[calls.length - 1];
    expect(last.url).toBe("https://api.example.com/rounds/r1/scores");
    expect(last.init.method).toBe("PUT");
    expect(last.init.headers?.["x-session-id"]).toBe("s1");
    expect(JSON.parse(last.init.body || "{}")).toEqual({
      playerId: "p1",
      holeNumber: 2,
      strokes: 4,
    });
  });
});
