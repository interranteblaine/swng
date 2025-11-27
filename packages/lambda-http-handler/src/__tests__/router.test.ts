import { describe, it, expect } from "vitest";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  ApplicationError,
  type RoundService,
  type Logger,
} from "@swng/application";
import type {
  Player,
  RoundConfig,
  RoundSnapshot,
  RoundState,
  Score,
} from "@swng/domain";
import { routeRequest } from "../lambda-http-handler/router";
import { toHttpErrorResponse } from "../lambda-http-handler/httpUtils";

type HttpEvent = Parameters<APIGatewayProxyHandlerV2>[0];

function mkEvent(
  method: string,
  path: string,
  opts?: {
    headers?: Record<string, string>;
    body?: unknown;
    isBase64Encoded?: boolean;
    stage?: string;
  }
): HttpEvent {
  const body =
    opts?.body === undefined
      ? undefined
      : typeof opts.body === "string"
      ? opts.body
      : JSON.stringify(opts.body);

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: opts?.headers,
    requestContext: {
      accountId: "acc",
      apiId: "api",
      domainName: "example.com",
      domainPrefix: "example",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req",
      routeKey: "$default",
      stage: opts?.stage ?? "$default",
      time: "",
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: opts?.isBase64Encoded ?? false,
  } as unknown as HttpEvent;
}

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  with: () => noopLogger,
};

function sampleRound(): {
  config: RoundConfig;
  state: RoundState;
  player: Player;
  score: Score;
  snapshot: RoundSnapshot;
} {
  const config: RoundConfig = {
    roundId: "rnd_1",
    accessCode: "ABC123",
    courseName: "Course",
    holes: 3,
    par: [3, 4, 5],
    createdAt: new Date().toISOString(),
  };
  const state: RoundState = {
    roundId: "rnd_1",
    currentHole: 1,
    status: "IN_PROGRESS",
    stateVersion: 1,
    updatedAt: new Date().toISOString(),
  };
  const player: Player = {
    roundId: "rnd_1",
    playerId: "ply_1",
    name: "Alice",
    color: "#000000",
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const score: Score = {
    roundId: "rnd_1",
    playerId: "ply_1",
    holeNumber: 1,
    strokes: 3,
    updatedBy: "ply_1",
    updatedAt: new Date().toISOString(),
  };
  const snapshot: RoundSnapshot = {
    config,
    state,
    players: [player],
    scores: [score],
  };
  return { config, state, player, score, snapshot };
}

function mockService(overrides: Partial<RoundService> = {}): RoundService {
  // Provide defaults that throw if unexpectedly called to catch route mistakes
  const svc: RoundService = {
    createRound: async () => {
      throw new Error("createRound not mocked");
    },
    joinRound: async () => {
      throw new Error("joinRound not mocked");
    },
    getRound: async () => {
      throw new Error("getRound not mocked");
    },
    updateScore: async () => {
      throw new Error("updateScore not mocked");
    },
    patchRoundState: async () => {
      throw new Error("patchRoundState not mocked");
    },
    updatePlayer: async () => {
      throw new Error("updatePlayer not mocked");
    },
    ...overrides,
  };
  return svc;
}

describe("router.routeRequest", () => {
  it("POST /rounds -> creates a round and returns 201", async () => {
    const { config, state } = sampleRound();
    const service = mockService({
      createRound: async () => ({ config, state }),
    });

    const event = mkEvent("POST", "/rounds", {
      body: { courseName: "Course", par: [3, 4, 5] },
    });

    const res = await routeRequest(event, service);

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body!);
    expect(body).toEqual({ config, state });
  });

  it("POST /rounds/join -> returns 200 and sets x-session-id header", async () => {
    const { snapshot, player } = sampleRound();
    const service = mockService({
      joinRound: async () => ({
        roundId: snapshot.config.roundId,
        player,
        sessionId: "sess_1",
        snapshot,
      }),
    });

    const event = mkEvent("POST", "/rounds/join", {
      body: { accessCode: "ABC123", playerName: "Alice", color: "#000000" },
    });

    const res = await routeRequest(event, service);

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["x-session-id"]).toBe("sess_1");
    const body = JSON.parse(res.body!);
    expect(body.roundId).toBe(snapshot.config.roundId);
  });

  it("GET /rounds/{id} without session header -> 401 via toHttpErrorResponse", async () => {
    const service = mockService({
      getRound: async () => ({ snapshot: sampleRound().snapshot }),
    });
    const event = mkEvent("GET", "/rounds/rnd_1");

    try {
      await routeRequest(event, service);
      throw new Error("Expected routeRequest to throw for missing session");
    } catch (err) {
      const resp = toHttpErrorResponse(err, noopLogger);
      expect(resp.statusCode).toBe(401);
      const body = JSON.parse(resp.body!);
      expect(body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("PATCH /rounds/{id}/state conflict -> 409 via toHttpErrorResponse", async () => {
    const service = mockService({
      patchRoundState: async () => {
        throw new ApplicationError("CONFLICT", "State version mismatch");
      },
    });

    const event = mkEvent("PATCH", "/rounds/rnd_1/state", {
      headers: { "x-session-id": "sess_1" },
      body: { currentHole: 2 },
    });

    try {
      await routeRequest(event, service);
      throw new Error("Expected routeRequest to throw for conflict");
    } catch (err) {
      const resp = toHttpErrorResponse(err, noopLogger);
      expect(resp.statusCode).toBe(409);
      const body = JSON.parse(resp.body!);
      expect(body.error.code).toBe("CONFLICT");
    }
  });

  it("Unknown route -> 404", async () => {
    const service = mockService({});
    const event = mkEvent("GET", "/unknown");

    const res = await routeRequest(event, service);

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body!);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("Malformed JSON -> 400 via toHttpErrorResponse", async () => {
    const service = mockService({
      createRound: async () => {
        throw new Error("Should not be called");
      },
    });
    const event = mkEvent("POST", "/rounds", {
      // Intentionally invalid JSON to trigger parse error
      body: "{ invalid",
    });

    try {
      await routeRequest(event, service);
      throw new Error("Expected routeRequest to throw for invalid JSON");
    } catch (err) {
      const resp = toHttpErrorResponse(err, noopLogger);
      expect(resp.statusCode).toBe(400);
      const body = JSON.parse(resp.body!);
      expect(body.error.code).toBe("INVALID_INPUT");
    }
  });

  it("POST /beta/rounds is normalized and routed to /rounds", async () => {
    const { config, state } = sampleRound();
    const service = mockService({
      createRound: async () => ({ config, state }),
    });

    const res = await routeRequest(
      mkEvent("POST", "/beta/rounds", {
        stage: "beta",
        body: { courseName: "Course", par: [3, 4, 5] },
      }),
      service
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body!);
    expect(body).toEqual({ config, state });
  });

  it("POST /prod/rounds/join is normalized and routed to /rounds/join", async () => {
    const { snapshot, player } = sampleRound();
    const service = mockService({
      joinRound: async () => ({
        roundId: snapshot.config.roundId,
        player,
        sessionId: "sess_1",
        snapshot,
      }),
    });

    const res = await routeRequest(
      mkEvent("POST", "/prod/rounds/join", {
        stage: "prod",
        body: { accessCode: "ABC123", playerName: "Alice", color: "#000000" },
      }),
      service
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["x-session-id"]).toBe("sess_1");
    const body = JSON.parse(res.body!);
    expect(body.roundId).toBe(snapshot.config.roundId);
  });
});
