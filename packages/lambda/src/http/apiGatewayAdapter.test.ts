import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { fromApiGatewayEvent, toApiGatewayResult } from "./apiGatewayAdapter.js";

// Builds just enough of an APIGatewayProxyEventV2 (HTTP API payload format 2.0) for
// fromApiGatewayEvent to read — every field the adapter actually touches, overridable per test.
const eventWith = (opts: {
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  query?: Record<string, string>;
  method?: string;
  path?: string;
}): APIGatewayProxyEventV2 => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: opts.path ?? "/rounds",
  rawQueryString: "",
  headers: opts.headers ?? {},
  queryStringParameters: opts.query,
  requestContext: {
    accountId: "test-account",
    apiId: "test-api",
    domainName: "test.execute-api.us-east-1.amazonaws.com",
    domainPrefix: "test",
    http: { method: opts.method ?? "GET", path: opts.path ?? "/rounds", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    requestId: "req-1",
    routeKey: "$default",
    stage: "$default",
    time: "07/Jul/2026:00:00:00 +0000",
    timeEpoch: 0,
  },
  body: opts.body,
  isBase64Encoded: opts.isBase64Encoded ?? false,
});

describe("fromApiGatewayEvent", () => {
  it("lifts the bearer header regardless of case", () => {
    expect(fromApiGatewayEvent(eventWith({ headers: { Authorization: "Bearer x" } })).headers.authorization).toBe("Bearer x");
  });

  it("decodes a base64 body", () => {
    const raw = JSON.stringify({ hello: "world" });
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    expect(fromApiGatewayEvent(eventWith({ body: encoded, isBase64Encoded: true })).body).toBe(raw);
  });

  it("carries query parameters across", () => {
    expect(fromApiGatewayEvent(eventWith({ query: { since: "3" } })).query).toEqual({ since: "3" });
  });

  it("uppercases the method and takes the path from rawPath", () => {
    const request = fromApiGatewayEvent(eventWith({ method: "post", path: "/rounds/abc/scores" }));
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/rounds/abc/scores");
  });
});

describe("toApiGatewayResult", () => {
  it("passes statusCode, headers, and body through unchanged", () => {
    const result = toApiGatewayResult({ statusCode: 201, headers: { "content-type": "application/json" }, body: '{"ok":true}' });
    expect(result).toEqual({ statusCode: 201, headers: { "content-type": "application/json" }, body: '{"ok":true}' });
  });
});
