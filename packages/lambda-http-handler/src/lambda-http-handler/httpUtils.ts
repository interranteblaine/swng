import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { ApplicationError, Logger } from "@swng/application";
import { ApplicationError as AppError } from "@swng/application";

export function json(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function requireSessionId(
  headers: Record<string, string | undefined> | undefined
): string {
  const sessionId = getHeader(headers, "x-session-id");
  if (!sessionId) {
    throw new AppError("UNAUTHORIZED", "Missing x-session-id header");
  }
  return sessionId;
}

export function parseJson<T = unknown>(
  body: string | undefined,
  isBase64Encoded?: boolean
): T {
  if (!body) return {} as T;
  const raw = isBase64Encoded
    ? Buffer.from(body, "base64").toString("utf8")
    : body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AppError("INVALID_INPUT", "Malformed JSON body");
  }
}

export function mapAppErrorToStatus(code: ApplicationError["code"]): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "CONFLICT":
    case "INVARIANT_VIOLATION":
      return 409;
    default:
      return 500;
  }
}

export function toHttpErrorResponse(
  err: unknown,
  logger: Logger
): APIGatewayProxyStructuredResultV2 {
  if (err instanceof AppError) {
    const status = mapAppErrorToStatus(err.code);
    logger.warn("ApplicationError", {
      code: err.code,
      message: err.message,
    });
    return json(status, { error: { code: err.code, message: err.message } });
  }

  if (err instanceof Error) {
    logger.error("Unhandled error", {
      message: err.message,
      stack: err.stack,
    });
  } else {
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message)
        : "Internal server error";
    logger.error("Unhandled error", { message, err });
  }

  return json(500, {
    error: { code: "INTERNAL", message: "Internal server error" },
  });
}
