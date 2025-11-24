import type {
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { ApplicationError, type RoundService } from "@swng/application";
import { json, parseJson, requireSessionId } from "./httpUtils";
import {
  parseCreateRoundRequest,
  parseJoinRoundRequest,
  parseUpdateScoreRequest,
  parsePatchRoundStateRequest,
  parseUpdatePlayerRequest,
} from "@swng/contracts";

export type HttpEvent = Parameters<APIGatewayProxyHandlerV2>[0];
export type HttpResult = APIGatewayProxyStructuredResultV2;

function getMethodAndPath(event: HttpEvent): { method: string; path: string } {
  const method = event.requestContext.http.method;
  const path = decodeURI(event.rawPath || "/");
  return { method, path };
}

const RE_ROUND = /^\/rounds\/([^/]+)$/;
const RE_SCORES = /^\/rounds\/([^/]+)\/scores$/;
const RE_STATE = /^\/rounds\/([^/]+)\/state$/;
const RE_PLAYER = /^\/rounds\/([^/]+)\/players\/([^/]+)$/;

export async function routeRequest(
  event: HttpEvent,
  service: RoundService
): Promise<HttpResult> {
  const { method, path } = getMethodAndPath(event);

  // POST /rounds
  if (method === "POST" && path === "/rounds") {
    const raw = parseJson<unknown>(event.body, event.isBase64Encoded);
    const parsed = parseCreateRoundRequest(raw);
    if (!parsed.ok) {
      throw new ApplicationError("INVALID_INPUT", parsed.error);
    }
    const body = parsed.data;

    const result = await service.createRound({
      courseName: body.courseName,
      par: body.par,
    });

    return json(201, result);
  }

  // POST /rounds/join
  if (method === "POST" && path === "/rounds/join") {
    const raw = parseJson<unknown>(event.body, event.isBase64Encoded);
    const parsed = parseJoinRoundRequest(raw);
    if (!parsed.ok) {
      throw new ApplicationError("INVALID_INPUT", parsed.error);
    }
    const body = parsed.data;

    const result = await service.joinRound({
      accessCode: body.accessCode,
      playerName: body.playerName,
      color: body.color,
    });

    return json(200, result, { "x-session-id": result.sessionId });
  }

  // GET /rounds/{roundId}
  {
    const m = path.match(RE_ROUND);
    if (method === "GET" && m) {
      const roundId = decodeURIComponent(m[1]);
      const sessionId = requireSessionId(event.headers);

      const result = await service.getRound({ roundId, sessionId });
      return json(200, result);
    }
  }

  // PUT /rounds/{roundId}/scores
  {
    const m = path.match(RE_SCORES);
    if (method === "PUT" && m) {
      const roundId = decodeURIComponent(m[1]);
      const sessionId = requireSessionId(event.headers);

      const raw = parseJson<unknown>(event.body, event.isBase64Encoded);
      const parsed = parseUpdateScoreRequest(raw);
      if (!parsed.ok) {
        throw new ApplicationError("INVALID_INPUT", parsed.error);
      }
      const body = parsed.data;

      const result = await service.updateScore({
        roundId,
        sessionId,
        playerId: body.playerId,
        holeNumber: body.holeNumber,
        strokes: body.strokes,
      });

      return json(200, result);
    }
  }

  // PATCH /rounds/{roundId}/state
  {
    const m = path.match(RE_STATE);
    if (method === "PATCH" && m) {
      const roundId = decodeURIComponent(m[1]);
      const sessionId = requireSessionId(event.headers);

      const raw = parseJson<unknown>(event.body, event.isBase64Encoded);
      const parsed = parsePatchRoundStateRequest(raw);
      if (!parsed.ok) {
        throw new ApplicationError("INVALID_INPUT", parsed.error);
      }
      const body = parsed.data;

      const result = await service.patchRoundState({
        roundId,
        sessionId,
        currentHole: body.currentHole,
        status: body.status,
      });

      return json(200, result);
    }
  }

  // PATCH /rounds/{roundId}/players/{playerId}
  {
    const m = path.match(RE_PLAYER);
    if (method === "PATCH" && m) {
      const roundId = decodeURIComponent(m[1]);
      const playerId = decodeURIComponent(m[2]);
      const sessionId = requireSessionId(event.headers);

      const raw = parseJson<unknown>(event.body, event.isBase64Encoded);
      const parsed = parseUpdatePlayerRequest(raw);
      if (!parsed.ok) {
        throw new ApplicationError("INVALID_INPUT", parsed.error);
      }
      const body = parsed.data;

      const result = await service.updatePlayer({
        roundId,
        sessionId,
        playerId,
        name: body.name,
        color: body.color,
      });

      return json(200, result);
    }
  }

  // No route matched
  return json(404, {
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
}
