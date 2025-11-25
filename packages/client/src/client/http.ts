import type {
  CreateRoundOutput,
  JoinRoundOutput,
  GetRoundOutput,
  UpdateScoreOutput,
  PatchRoundStateOutput,
  UpdatePlayerOutput,
} from "@swng/application";
import type {
  CreateRoundRequest,
  JoinRoundRequest,
  UpdateScoreRequest,
  PatchRoundStateRequest,
  UpdatePlayerRequest,
} from "@swng/contracts";
import type { RoundId } from "@swng/domain";
import type { HttpPort } from "./types";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH";

type ErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

function toUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path}`;
}

function parseError(data: unknown): { code?: string; message?: string } {
  if (data && typeof data === "object") {
    const env = data as ErrorEnvelope;
    const err = env.error;
    const code =
      err &&
      typeof err === "object" &&
      typeof (err as { code?: unknown }).code === "string"
        ? String((err as { code?: unknown }).code)
        : undefined;
    const message =
      err &&
      typeof err === "object" &&
      typeof (err as { message?: unknown }).message === "string"
        ? String((err as { message?: unknown }).message)
        : undefined;
    return { code, message };
  }
  return {};
}

async function fetchJson<T>(
  http: HttpPort,
  baseUrl: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
  sessionId?: string
): Promise<T> {
  const url = toUrl(baseUrl, path);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId) headers["x-session-id"] = sessionId;

  const res = await http.request({
    url,
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = res.bodyText;
  const data: unknown = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const { code, message } = parseError(data);
    const codeStr = code ?? `HTTP_${res.status}`;
    const msg = message ?? `Request failed with status ${res.status}`;
    const err = new Error(`[${codeStr}] ${msg}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = codeStr;
    err.status = res.status;
    throw err;
  }

  return data as T;
}

export function createHttpClient(http: HttpPort, baseUrl: string) {
  return {
    async createRound(input: CreateRoundRequest): Promise<CreateRoundOutput> {
      return fetchJson<CreateRoundOutput>(
        http,
        baseUrl,
        "POST",
        "/rounds",
        input
      );
    },

    async joinRound(input: JoinRoundRequest): Promise<JoinRoundOutput> {
      return fetchJson<JoinRoundOutput>(
        http,
        baseUrl,
        "POST",
        "/rounds/join",
        input
      );
    },

    async getRound(args: {
      roundId: RoundId;
      sessionId: string;
    }): Promise<GetRoundOutput> {
      const { roundId, sessionId } = args;
      return fetchJson<GetRoundOutput>(
        http,
        baseUrl,
        "GET",
        `/rounds/${encodeURIComponent(roundId)}`,
        undefined,
        sessionId
      );
    },

    async updateScore(
      args: { roundId: RoundId; sessionId: string } & UpdateScoreRequest
    ): Promise<UpdateScoreOutput> {
      const { roundId, sessionId, playerId, holeNumber, strokes } = args;
      const body: UpdateScoreRequest = { playerId, holeNumber, strokes };
      return fetchJson<UpdateScoreOutput>(
        http,
        baseUrl,
        "PUT",
        `/rounds/${encodeURIComponent(roundId)}/scores`,
        body,
        sessionId
      );
    },

    async patchRoundState(
      args: { roundId: RoundId; sessionId: string } & PatchRoundStateRequest
    ): Promise<PatchRoundStateOutput> {
      const { roundId, sessionId, currentHole, status } = args;
      const body: PatchRoundStateRequest = { currentHole, status };
      return fetchJson<PatchRoundStateOutput>(
        http,
        baseUrl,
        "PATCH",
        `/rounds/${encodeURIComponent(roundId)}/state`,
        body,
        sessionId
      );
    },

    async updatePlayer(
      args: {
        roundId: RoundId;
        sessionId: string;
        playerId: string;
      } & UpdatePlayerRequest
    ): Promise<UpdatePlayerOutput> {
      const { roundId, sessionId, playerId, name, color } = args;
      const body: UpdatePlayerRequest = { name, color };
      return fetchJson<UpdatePlayerOutput>(
        http,
        baseUrl,
        "PATCH",
        `/rounds/${encodeURIComponent(roundId)}/players/${encodeURIComponent(
          playerId
        )}`,
        body,
        sessionId
      );
    },
  };
}
