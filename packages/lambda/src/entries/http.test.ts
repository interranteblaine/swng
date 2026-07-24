import { beforeAll, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

// Prod-readiness hardening Arc A fix wave (post-review): appPromise's cache used to be `??=`
// alone, which only reassigns on null/undefined — a REJECTED buildApp() promise (a transient
// cold-start Secrets Manager throttle/network blip, or an AccessDenied in the narrow deploy
// window before the grantRead IAM policy attaches) stayed cached forever, 500ing every request
// for that warm container's whole remaining lifetime (Lambda doesn't recycle a container just
// because a handler throws). The fix (http.ts's own doc comment) clears appPromise back to
// undefined in a `.catch` before rethrowing, so the NEXT invocation retries buildApp from
// scratch instead of replaying the same rejection. This test proves that self-heal at http.ts,
// the busiest of the three entries: the mocked secret reader below rejects exactly once
// (simulating that transient failure) then succeeds — the first handler call must reject, and
// the second must succeed even though appPromise was never reassigned in between by this test.
const TOKEN_SECRET = vi.hoisted(() => "http-entry-test-secret");
const readSecretCalls = vi.hoisted(() => ({ count: 0 }));

// Hoisted (vi.mock factories run before this file's own top-level code) — http.ts's lazy
// buildApp() call uses the REAL default secret reader (no injected seam at the entry level, by
// design: entries/http.ts's own doc comment / wsConnect.test.ts's precedent), so the module it
// comes from is mocked here instead.
vi.mock("@swng/adapters-secretsmanager", () => ({
  createSecretsManagerReader:
    () =>
    async (_arn: string): Promise<string> => {
      readSecretCalls.count += 1;
      if (readSecretCalls.count === 1) {
        throw new Error("simulated transient Secrets Manager failure (cold-start throttle/AccessDenied)");
      }
      return TOKEN_SECRET;
    },
}));

let handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

beforeAll(async () => {
  process.env["TABLE_ROUNDS"] = "rounds-table";
  process.env["TABLE_CONNECTIONS"] = "connections-table";
  process.env["TOKEN_SECRET_ARN"] = "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-test";
  process.env["WS_ENDPOINT"] = "https://example.execute-api.us-east-1.amazonaws.com/test";
  const mod = await import("./http.js");
  handler = mod.handler as typeof handler;
});

// Just enough of an APIGatewayProxyEventV2 (HTTP API payload format 2.0) to reach the
// dispatcher's routing step and get a guaranteed 404 — no route matches, so no use case and no
// DynamoDB call ever runs. This test cares only about buildApp's own init self-heal, not any
// route's business logic, so the cheapest request that still exercises the full
// `await (await appPromise).dispatcher(event)` path is a path nothing matches.
const makeEvent = (): APIGatewayProxyEventV2 => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: "/definitely-not-a-route",
  rawQueryString: "",
  headers: {},
  requestContext: {
    accountId: "test-account",
    apiId: "test-api",
    domainName: "test.execute-api.us-east-1.amazonaws.com",
    domainPrefix: "test",
    http: { method: "GET", path: "/definitely-not-a-route", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    requestId: "req-1",
    routeKey: "$default",
    stage: "$default",
    time: "07/Jul/2026:00:00:00 +0000",
    timeEpoch: 0,
  },
  body: undefined,
  isBase64Encoded: false,
});

describe("http handler — a rejected cold-start init self-heals", () => {
  it("does not poison the warm container: the first call rejects, the second succeeds", async () => {
    await expect(handler(makeEvent())).rejects.toThrow(/simulated transient Secrets Manager failure/);

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
  });
});
