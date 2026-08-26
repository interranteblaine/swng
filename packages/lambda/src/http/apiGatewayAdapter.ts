import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { HttpRequest, HttpResponse } from "./httpRequest.js";

// The ONLY place API Gateway's HTTP API (payload format 2.0) shape is read or produced
// (httpRequest.ts's own doc comment) — dispatch.ts touches none of it directly.

// HTTP API (payload format 2.0) lower-cases header names, but this never trusts that — every
// key is folded to lower case here so dispatch.ts's bearer-token check can read
// `headers.authorization` unconditionally instead of re-deriving the case-insensitivity itself.
export const fromApiGatewayEvent = (event: APIGatewayProxyEventV2): HttpRequest => {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(event.headers)) {
    headers[key.toLowerCase()] = value;
  }

  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) query[key] = value;
  }

  // Base64-decoding is transport-specific (API Gateway's own isBase64Encoded flag) so it
  // happens here; JSON-parsing the result is NOT transport-specific and stays dispatch.ts's job
  // (readJsonBody). An empty body ("") is treated the same as an absent one, matching the
  // original `!event.body` check this replaces.
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : undefined;

  return {
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath,
    headers,
    query,
    body,
  };
};

export const toApiGatewayResult = (response: HttpResponse): APIGatewayProxyResultV2 => ({
  statusCode: response.statusCode,
  headers: response.headers,
  body: response.body,
});
