import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { fixtureWhite } from "@swng/domain";
import { buildApp, createConsoleLogger } from "./compositionRoot.js";

// Pin for the M3-deferred fix (task-6-brief.md item 5): consoleLogger used to spread `data`
// AFTER `message` in the logged object, so a `data.message` key silently clobbered the
// actual log message. Message must always win.
describe("createConsoleLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("info: a data.message key never clobbers the real log message", () => {
    const logger = createConsoleLogger();
    logger.info("the real message", { message: "an attacker-controlled or coincidental data.message", roundId: "r-1" });

    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({ level: "info", roundId: "r-1", message: "the real message" });
  });

  it("error: a data.message key never clobbers the real log message", () => {
    const logger = createConsoleLogger();
    logger.error("the real error message", { message: "coincidental data.message" });

    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({ level: "error", message: "the real error message" });
  });

  // Pin for M6 Task 4's carry 3: `level` sat AHEAD of `...data` in the object literal, so a
  // `data.level` key (coincidental or otherwise) clobbered the log entry's own "info"/"error"
  // level. Mirrors the message-wins tests above — `level` must win the same way `message`
  // does, not just `message`.
  it("info: a data.level key never clobbers the real log level", () => {
    const logger = createConsoleLogger();
    logger.info("the real message", { level: "attacker-controlled-or-coincidental", roundId: "r-1" });

    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({ level: "info", roundId: "r-1", message: "the real message" });
  });

  it("error: a data.level key never clobbers the real log level", () => {
    const logger = createConsoleLogger();
    logger.error("the real error message", { level: "coincidental data.level" });

    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({ level: "error", message: "the real error message" });
  });
});

// Regression: wsConnect.ts/wsDisconnect.ts share buildApp with http.ts (compositionRoot.ts's
// doc comment), but swngStack.ts only puts TABLE_CORE in httpFn's environment. Reading it
// via requireEnv crashed both WS Lambdas' cold start in beta the moment M6 Task 4 wired the
// course use cases in ("buildApp: missing required env var TABLE_CORE") — wedging every
// WebSocket $connect/$disconnect until this was caught by pnpm e2e:beta and fixed.
describe("buildApp — TABLE_CORE is optional (wsConnect/wsDisconnect never set it)", () => {
  const baseEnv = {
    TABLE_ROUNDS: "rounds-table",
    TABLE_CONNECTIONS: "connections-table",
    TOKEN_SECRET: "test-secret",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when TABLE_CORE is absent — wsConnect/wsDisconnect's real env shape", () => {
    expect(() => buildApp(baseEnv)).not.toThrow();
  });

  it("does not throw when TABLE_CORE IS present — httpFn's real env shape", () => {
    expect(() => buildApp({ ...baseEnv, TABLE_CORE: "core-table" })).not.toThrow();
  });

  it("a dispatched course route 500s gracefully (not a process crash) when TABLE_CORE was absent at cold start", async () => {
    const app = buildApp(baseEnv);
    const event: APIGatewayProxyEventV2 = {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/courses",
      rawQueryString: "",
      headers: {},
      requestContext: {
        accountId: "test-account",
        apiId: "test-api",
        domainName: "test.execute-api.us-east-1.amazonaws.com",
        domainPrefix: "test",
        http: { method: "POST", path: "/courses", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
        requestId: "req-1",
        routeKey: "$default",
        stage: "$default",
        time: "07/Jul/2026:00:00:00 +0000",
        timeEpoch: 0,
      },
      body: JSON.stringify({ name: "Casa Verde GC", tee: fixtureWhite, enteredBy: "Ann" }),
      isBase64Encoded: false,
    };

    const result = (await app.dispatcher(event)) as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(500);
  });
});
