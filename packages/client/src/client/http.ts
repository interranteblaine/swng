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
  baseUrl: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
  sessionId?: string
): Promise<T> {
  if (typeof fetch !== "function") {
    throw new Error("global fetch not available (browser-only client)");
  }

  const url = toUrl(baseUrl, path);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId) headers["x-session-id"] = sessionId;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
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

export async function createRound(
  baseUrl: string,
  input: CreateRoundRequest
): Promise<CreateRoundOutput> {
  return fetchJson<CreateRoundOutput>(baseUrl, "POST", "/rounds", input);
}

export async function joinRound(
  baseUrl: string,
  input: JoinRoundRequest
): Promise<JoinRoundOutput> {
  return fetchJson<JoinRoundOutput>(baseUrl, "POST", "/rounds/join", input);
}

export async function getRound(
  baseUrl: string,
  args: { roundId: RoundId; sessionId: string }
): Promise<GetRoundOutput> {
  const { roundId, sessionId } = args;
  return fetchJson<GetRoundOutput>(
    baseUrl,
    "GET",
    `/rounds/${encodeURIComponent(roundId)}`,
    undefined,
    sessionId
  );
}

export async function updateScore(
  baseUrl: string,
  args: { roundId: RoundId; sessionId: string } & UpdateScoreRequest
): Promise<UpdateScoreOutput> {
  const { roundId, sessionId, playerId, holeNumber, strokes } = args;
  const body: UpdateScoreRequest = { playerId, holeNumber, strokes };
  return fetchJson<UpdateScoreOutput>(
    baseUrl,
    "PUT",
    `/rounds/${encodeURIComponent(roundId)}/scores`,
    body,
    sessionId
  );
}

export async function patchRoundState(
  baseUrl: string,
  args: { roundId: RoundId; sessionId: string } & PatchRoundStateRequest
): Promise<PatchRoundStateOutput> {
  const { roundId, sessionId, currentHole, status } = args;
  const body: PatchRoundStateRequest = { currentHole, status };
  return fetchJson<PatchRoundStateOutput>(
    baseUrl,
    "PATCH",
    `/rounds/${encodeURIComponent(roundId)}/state`,
    body,
    sessionId
  );
}

export async function updatePlayer(
  baseUrl: string,
  args: {
    roundId: RoundId;
    sessionId: string;
    playerId: string;
  } & UpdatePlayerRequest
): Promise<UpdatePlayerOutput> {
  const { roundId, sessionId, playerId, name, color } = args;
  const body: UpdatePlayerRequest = { name, color };
  return fetchJson<UpdatePlayerOutput>(
    baseUrl,
    "PATCH",
    `/rounds/${encodeURIComponent(roundId)}/players/${encodeURIComponent(
      playerId
    )}`,
    body,
    sessionId
  );
}
