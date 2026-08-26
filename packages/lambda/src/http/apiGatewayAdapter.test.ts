import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { fromApiGatewayEvent, toApiGatewayResult } from "./apiGatewayAdapter.js";

// Builds just enough of an APIGatewayProxyEventV2 (HTTP API payload format 2.0) for
// fromApiGatewayEvent to read — every field the adapter actually touches, overridable per test.
//
// `httpPath` defaults to a value that's DELIBERATELY DIFFERENT from `path` (rawPath) — the two
// genuinely diverge in production (rawPath includes a non-$default stage prefix and preserves
// percent-encoding; requestContext.http.path does not), so an adapter reading the wrong one must
// fail a test here, not just in prod.
const eventWith = (opts: {
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  query?: Record<string, string>;
  method?: string;
  path?: string;
  httpPath?: string;
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
    http: {
      method: opts.method ?? "GET",
      path: opts.httpPath ?? "/http-path-not-raw-path",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "vitest",
    },
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

  // Before this task, the isBase64Encoded:false branch was covered incidentally by every one
  // of dispatch.test.ts's ~140 requests (the ternary lived inside dispatch.ts's readJsonBody).
  // The extraction moved that ternary here and dispatch.test.ts's makeRequest builds an
  // HttpRequest directly, never touching fromApiGatewayEvent — so without this test, the
  // most-travelled line in the product (a plain, non-base64 JSON body) had zero coverage.
  it("passes a plain (non-base64) body through unchanged", () => {
    const raw = JSON.stringify({ hello: "world" });
    expect(fromApiGatewayEvent(eventWith({ body: raw, isBase64Encoded: false })).body).toBe(raw);
  });

  it("carries query parameters across", () => {
    expect(fromApiGatewayEvent(eventWith({ query: { since: "3" } })).query).toEqual({ since: "3" });
  });

  // queryStringParameters can hand back a key mapped to `undefined` (API Gateway's own typing
  // allows it for a param present with no value) — dispatch.ts used to filter that out itself;
  // now fromApiGatewayEvent does. Without this, deleting the `value !== undefined` guard leaves
  // every other test green, since eventWith's other query tests pass only defined values.
  // toStrictEqual (not toEqual) is load-bearing here: toEqual ignores undefined-valued
  // properties, so `{ since: "3", blank: undefined }` would pass either way — the point of this
  // test is that the "blank" KEY itself must be absent, not merely undefined.
  it("drops a query key whose value is undefined", () => {
    const event = eventWith({ query: { since: "3" } });
    (event.queryStringParameters as Record<string, string | undefined>)["blank"] = undefined;
    expect(fromApiGatewayEvent(event).query).toStrictEqual({ since: "3" });
  });

  it("defaults query to {} when queryStringParameters is absent", () => {
    expect(fromApiGatewayEvent(eventWith({})).query).toEqual({});
  });

  it("uppercases the method and takes the path from rawPath, not requestContext.http.path", () => {
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
