import { addGameResponseSchema, errorResponseSchema, finalizeRoundResponseSchema, joinRoundResponseSchema, parse, startRoundResponseSchema } from "@swng/contracts";
import type { AddGameRequest, AddGameResponse, FinalizeRoundResponse, JoinRoundRequest, JoinRoundResponse, StartRoundRequest, StartRoundResponse } from "@swng/contracts";
import type { RoundId } from "@swng/domain";
import { config } from "./config";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

// The four non-session commands share this: build the URL off config.httpUrl, attach the
// bearer token when one's given, and map a rejected fetch or a non-2xx response onto one
// ApiError shape — mirrors @swng/client's transport.ts requestJson (score/pull go through
// the session instead, never through here). A non-2xx body is parsed best-effort against
// errorResponseSchema: API Gateway's own edge errors (timeouts, throttles) are HTML/plain
// text, never JSON, so a SyntaxError there must not escape as some other error shape.
const requestJson = async (path: string, init: (RequestInit & { token?: string }) | undefined): Promise<unknown> => {
  // `token` is this function's own bespoke property, not part of RequestInit — it must be
  // destructured out and never spread into the real fetch() call below (fetch would just
  // ignore an unknown property, but silently leaking a bearer token into a generic init object
  // is the kind of thing that bites later, e.g. if `rest` is ever logged or forwarded).
  const { token, ...rest } = init ?? {};
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${config.httpUrl}${path}`, { ...rest, headers });
  } catch {
    throw new ApiError("network", undefined, "network error");
  }

  if (!response.ok) {
    let code = `http-${response.status}`;
    let message = `request failed with status ${response.status}`;
    try {
      const errorBody = errorResponseSchema.safeParse(await response.json());
      if (errorBody.success) {
        code = errorBody.data.code;
        message = errorBody.data.message;
      }
    } catch {
      // non-JSON error body (API Gateway's own edge page): fall back to the status-derived
      // code/message above.
    }
    throw new ApiError(code, response.status, message);
  }

  return response.json();
};

export const createRound = async (input: StartRoundRequest): Promise<StartRoundResponse> => {
  const json = await requestJson("/rounds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return parse(startRoundResponseSchema, json);
};

export const joinRound = async (input: JoinRoundRequest): Promise<JoinRoundResponse> => {
  const json = await requestJson("/rounds/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return parse(joinRoundResponseSchema, json);
};

export const addGame = async (roundId: RoundId, token: string, game: AddGameRequest["game"]): Promise<AddGameResponse> => {
  const body: AddGameRequest = { game };
  const json = await requestJson(`/rounds/${roundId}/games`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), token });
  return parse(addGameResponseSchema, json);
};

export const finalizeRound = async (roundId: RoundId, token: string): Promise<FinalizeRoundResponse> => {
  const json = await requestJson(`/rounds/${roundId}/finalize`, { method: "POST", token });
  return parse(finalizeRoundResponseSchema, json);
};
