import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { fromFetchResponse, toFetchRequest } from "./fetchAdapter.js";

// Builds just enough of an APIGatewayProxyEventV2 (HTTP API payload format 2.0) for
// toFetchRequest to read — mirrors apiGatewayAdapter.test.ts's own eventWith, since the MCP
// entry (Task 13) is the second consumer of the same raw event shape, just bound to a
// web-standard Request instead of HttpRequest.
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
  rawPath: opts.path ?? "/mcp",
  rawQueryString: opts.query ? new URLSearchParams(opts.query).toString() : "",
  headers: opts.headers ?? {},
  queryStringParameters: opts.query,
  requestContext: {
    accountId: "test-account",
    apiId: "test-api",
    domainName: "test.execute-api.us-east-1.amazonaws.com",
    domainPrefix: "test",
    http: {
      method: opts.method ?? "POST",
      path: opts.path ?? "/mcp",
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

describe("toFetchRequest", () => {
  it("rebuilds the absolute URL from Host, path and query", () => {
    const request = toFetchRequest(eventWith({ headers: { host: "mcp.beta.swng.golf" }, path: "/mcp", query: { a: "1" }, method: "GET" }));
    expect(request.url).toBe("https://mcp.beta.swng.golf/mcp?a=1");
  });

  it("decodes a base64 body", async () => {
    const raw = JSON.stringify({ hello: "world" });
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    const request = toFetchRequest(
      eventWith({ headers: { host: "mcp.beta.swng.golf", "content-type": "application/json" }, body: encoded, isBase64Encoded: true }),
    );
    await expect(request.text()).resolves.toBe(raw);
  });

  it("preserves Mcp-Method and Mcp-Name", () => {
    // The transport rejects a request whose headers disagree with the body (-32020
    // HeaderMismatch — design spec's own global constraint) — a shim that drops these two
    // headers turns every tool call into a header mismatch.
    const request = toFetchRequest(
      eventWith({
        headers: { host: "mcp.beta.swng.golf", "mcp-method": "tools/call", "mcp-name": "get_round" },
        body: "{}",
      }),
    );
    expect(request.headers.get("Mcp-Method")).toBe("tools/call");
    expect(request.headers.get("Mcp-Name")).toBe("get_round");
  });
});

describe("fromFetchResponse", () => {
  it("carries status, headers and body from a web Response back to an API Gateway result", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
    });
    const result = await fromFetchResponse(response);
    expect(result.statusCode).toBe(401);
    expect(result.headers?.["www-authenticate"]).toBe('Bearer error="invalid_token"');
    expect(result.body).toBe(JSON.stringify({ ok: true }));
  });
});
