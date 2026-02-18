import type {
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { ApplicationError, type RoundService, type CourseService } from "@swng/application";
import { json, parseJson, requireSessionId } from "./httpUtils";
import {
  parseCreateRoundRequest,
  parseJoinRoundRequest,
  parseUpdateScoreRequest,
  parseDeleteScoreRequest,
  parsePatchRoundStateRequest,
  parseUpdatePlayerRequest,
} from "@swng/contracts";

export type HttpEvent = Parameters<APIGatewayProxyHandlerV2>[0];
export type HttpResult = APIGatewayProxyStructuredResultV2;

function getMethodAndPath(event: HttpEvent): { method: string; path: string } {
  const method = event.requestContext.http.method;
  const raw = decodeURI(event.rawPath || "/");
  const stage = event.requestContext?.stage;

  // Normalize path: strip stage prefix (e.g., "/beta/..." -> "/...")
  if (stage && raw === `/${stage}`) {
    return { method, path: "/" };
  }
  if (stage && raw.startsWith(`/${stage}/`)) {
    return { method, path: raw.slice(stage.length + 1) };
  }

  return { method, path: raw };
}

const RE_ROUND = /^\/rounds\/([^/]+)$/;
const RE_SCORES = /^\/rounds\/([^/]+)\/scores$/;
const RE_STATE = /^\/rounds\/([^/]+)\/state$/;
const RE_PLAYER = /^\/rounds\/([^/]+)\/players\/([^/]+)$/;
const RE_COURSES = /^\/courses$/;
const RE_COURSE = /^\/courses\/([^/]+)$/;

export async function routeRequest(
  event: HttpEvent,
  service: RoundService,
  courseService?: CourseService
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

    const result = await service.createRound(body);

    return json(201, result, { "x-session-id": result.sessionId });
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

  // DELETE /rounds/{roundId}/scores
  {
    const m = path.match(RE_SCORES);
    if (method === "DELETE" && m) {
      const roundId = decodeURIComponent(m[1]);
      const sessionId = requireSessionId(event.headers);

      const raw = parseJson<unknown>(event.body, event.isBase64Encoded);
      const parsed = parseDeleteScoreRequest(raw);
      if (!parsed.ok) {
        throw new ApplicationError("INVALID_INPUT", parsed.error);
      }
      const body = parsed.data;

      const result = await service.deleteScore({
        roundId,
        sessionId,
        playerId: body.playerId,
        holeNumber: body.holeNumber,
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
        status: body.status,
      });

      return json(200, result);
    }
  }

  // DELETE /rounds/{roundId}/players/{playerId}
  {
    const m = path.match(RE_PLAYER);
    if (method === "DELETE" && m) {
      const roundId = decodeURIComponent(m[1]);
      const playerId = decodeURIComponent(m[2]);
      const sessionId = requireSessionId(event.headers);

      const result = await service.removePlayer({
        roundId,
        sessionId,
        playerId,
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

  // GET /courses
  if (method === "GET" && RE_COURSES.test(path) && courseService) {
    const result = await courseService.listCourses();
    return json(200, result);
  }

  // GET /courses/{courseId}
  {
    const m = path.match(RE_COURSE);
    if (method === "GET" && m && courseService) {
      const courseId = decodeURIComponent(m[1]);
      const result = await courseService.getCourse(courseId);
      return json(200, result);
    }
  }

  // No route matched
  return json(404, {
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
}
