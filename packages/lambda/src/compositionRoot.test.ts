import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, DynamoDBStreamEvent } from "aws-lambda";
import { deviceId, fixtureLinks18, fixtureWhite, golferId, opId, roundId } from "@swng/domain";
import type { RoundArchive, RoundEvent } from "@swng/domain";
import { createInMemoryGolferStore, createInMemoryProjectionStore, createNullLogger, projectArchive, putAndBindGolfer } from "@swng/application";
import { buildApp, buildProjector, buildRebuild, createConsoleLogger, createProjectorHandler } from "./compositionRoot.js";

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

// M7 Task 4: same "shared buildApp, entry-scoped env" story as TABLE_CORE above — only httpFn
// gets USER_POOL_ID/USER_POOL_CLIENT_ID (swngStack.ts); wsConnect/wsDisconnect never do. No
// route declares `auth: "golfer"` yet (that lands with the golfer routes in a later task), so
// unlike the TABLE_CORE block above there's no dispatched-route-500s test here — nothing
// dispatches through the verifier yet for it to fail gracefully on.
describe("buildApp — USER_POOL_ID/USER_POOL_CLIENT_ID are optional (wsConnect/wsDisconnect never set them)", () => {
  const baseEnv = {
    TABLE_ROUNDS: "rounds-table",
    TABLE_CONNECTIONS: "connections-table",
    TOKEN_SECRET: "test-secret",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when USER_POOL_ID/USER_POOL_CLIENT_ID are absent — wsConnect/wsDisconnect's real env shape", () => {
    expect(() => buildApp(baseEnv)).not.toThrow();
  });

  it("does not throw when USER_POOL_ID/USER_POOL_CLIENT_ID ARE present — httpFn's real env shape", () => {
    expect(() => buildApp({ ...baseEnv, USER_POOL_ID: "us-east-1_Test123", USER_POOL_CLIENT_ID: "test-client-id" })).not.toThrow();
  });
});

// M7 Task 5: TABLE_PROJECTIONS was granted + env'd onto httpFn back in Task 4 but unread by
// buildApp until this task wired getMyRecord to a real ProjectionStore — same "shared
// buildApp, entry-scoped env" story as TABLE_CORE/USER_POOL_ID above. wsConnect/wsDisconnect
// never set it (swngStack.ts only puts it on httpFn/projectorFn/rebuildFn), so buildApp must
// read it lazily/optionally, mirroring the TABLE_CORE idiom exactly.
describe("buildApp — TABLE_PROJECTIONS is optional (wsConnect/wsDisconnect never set it)", () => {
  const baseEnv = {
    TABLE_ROUNDS: "rounds-table",
    TABLE_CONNECTIONS: "connections-table",
    TOKEN_SECRET: "test-secret",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when TABLE_PROJECTIONS is absent — wsConnect/wsDisconnect's real env shape", () => {
    expect(() => buildApp(baseEnv)).not.toThrow();
  });

  it("does not throw when TABLE_PROJECTIONS IS present — httpFn's real env shape", () => {
    expect(() => buildApp({ ...baseEnv, TABLE_PROJECTIONS: "projections-table" })).not.toThrow();
  });
});

// Projection-realignment Task 2: same "shared buildApp, entry-scoped env" story — only httpFn
// carries TABLE_SNAPSHOTS (swngStack.ts); wsConnect/wsDisconnect never do. The journal is
// constructed with snapshotsTableName either way (undefined for those entries) — the guard only
// fires if an append actually sets options.snapshot, which only finalize does, and only httpFn
// dispatches finalize. So buildApp must read it optionally, mirroring the TABLE_CORE idiom.
describe("buildApp — TABLE_SNAPSHOTS is optional (wsConnect/wsDisconnect never set it)", () => {
  const baseEnv = {
    TABLE_ROUNDS: "rounds-table",
    TABLE_CONNECTIONS: "connections-table",
    TOKEN_SECRET: "test-secret",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when TABLE_SNAPSHOTS is absent — wsConnect/wsDisconnect's real env shape", () => {
    expect(() => buildApp(baseEnv)).not.toThrow();
  });

  it("does not throw when TABLE_SNAPSHOTS IS present — httpFn's real env shape", () => {
    expect(() => buildApp({ ...baseEnv, TABLE_SNAPSHOTS: "snapshots-table" })).not.toThrow();
  });
});

describe("buildProjector / buildRebuild — required env vars", () => {
  it("buildProjector throws a clear error when TABLE_PROJECTIONS is missing", () => {
    expect(() => buildProjector({})).toThrow(/TABLE_PROJECTIONS/);
  });

  // Accounts-only identity (spec §7): the projector reads golfer rows on the core table to project
  // only account-bound golfers, so TABLE_CORE is required now (matching swngStack.ts's projectorFn env).
  it("buildProjector throws a clear error when TABLE_CORE is missing", () => {
    expect(() => buildProjector({ TABLE_PROJECTIONS: "projections-table" })).toThrow(/TABLE_CORE/);
  });

  it("buildProjector does not throw when TABLE_PROJECTIONS + TABLE_CORE are present", () => {
    expect(() => buildProjector({ TABLE_PROJECTIONS: "projections-table", TABLE_CORE: "core-table" })).not.toThrow();
  });

  // Projection-realignment Task 2: the rebuild reads the snapshots table now, not the rounds
  // table — its required env is TABLE_SNAPSHOTS + TABLE_PROJECTIONS (matching swngStack.ts's
  // RebuildFunction env, which dropped TABLE_ROUNDS for TABLE_SNAPSHOTS). Accounts-only identity
  // (spec §7) adds TABLE_CORE — the replay goes through the same golfer-row-reading projectArchive.
  it("buildRebuild throws a clear error when TABLE_SNAPSHOTS is missing", () => {
    expect(() => buildRebuild({ TABLE_PROJECTIONS: "projections-table" })).toThrow(/TABLE_SNAPSHOTS/);
  });

  it("buildRebuild throws a clear error when TABLE_PROJECTIONS is missing", () => {
    expect(() => buildRebuild({ TABLE_SNAPSHOTS: "snapshots-table" })).toThrow(/TABLE_PROJECTIONS/);
  });

  it("buildRebuild throws a clear error when TABLE_CORE is missing", () => {
    expect(() => buildRebuild({ TABLE_SNAPSHOTS: "snapshots-table", TABLE_PROJECTIONS: "projections-table" })).toThrow(/TABLE_CORE/);
  });

  it("buildRebuild does not throw when all three required vars are present", () => {
    expect(() => buildRebuild({ TABLE_SNAPSHOTS: "snapshots-table", TABLE_PROJECTIONS: "projections-table", TABLE_CORE: "core-table" })).not.toThrow();
  });
});

// createProjectorHandler's stream-record loop, over fakes (M7 Task 4 brief: "entry tests over
// fakes") — `project` here is the REAL projectArchive bound to an in-memory ProjectionStore
// (@swng/application's own testing fake), so this proves the loop's control flow (multi-record
// batches, poison-record log-and-rethrow) with zero AWS calls, not just that some mock got
// called.
describe("createProjectorHandler", () => {
  const ann = golferId("ann");
  const bo = golferId("bo");

  const finalizedEvent = (wallMs: number, roundKey: string): RoundEvent => ({
    kind: "round-finalized",
    opId: opId(`finalize-${roundKey}`),
    hlc: { wallMs, counter: 0, deviceId: deviceId("server") },
    authorId: ann,
  });

  const archiveFor = (roundKey: string, wallMs: number, participantId = ann): RoundArchive => ({
    roundId: roundId(roundKey),
    card: fixtureLinks18,
    participants: [{ golferId: participantId, name: participantId, tee: "white", courseHandicap: 8 }],
    games: [],
    cells: {},
    // A real archive's log always opens with round-created (its genesis) — carried so the
    // projector's createdAtMsOf (accounts-only identity spec §5) resolves; its wall time (1) is
    // arbitrary here, only its PRESENCE matters.
    events: [
      { kind: "round-created", roundId: roundId(roundKey), card: fixtureLinks18, opId: opId(`created-${roundKey}`), hlc: { wallMs: 1, counter: 0, deviceId: deviceId("server") }, authorId: ann },
      finalizedEvent(wallMs, roundKey),
    ],
    results: [],
    terminatedGameIds: [],
    handicapping: [{ golferId: participantId, kind: "complete", ags: 90, differential: 9.0 }],
  });

  // The "image" the fake parseArchive below reads back is the archive itself, unwrapped —
  // never real DynamoDB-JSON-shaped AttributeValues (that's parseSnapshotStreamImage's own
  // concern, unit-tested in adapters-dynamodb), so NewImage's real type is cast away here.
  const streamEventFor = (records: readonly { eventId: string; image: RoundArchive | undefined }[]): DynamoDBStreamEvent => ({
    Records: records.map(
      (r) => ({ eventID: r.eventId, eventName: "INSERT", dynamodb: { NewImage: r.image } }) as unknown as DynamoDBStreamEvent["Records"][number],
    ),
  });

  // A fake parseArchive standing in for adapters-dynamodb's real parseSnapshotStreamImage
  // (which needs an actually-marshalled DynamoDB image) — here the "image" IS the archive
  // itself, unwrapped, so this loop's own control flow is what's under test, not marshalling.
  const fakeParseArchive = (image: Record<string, unknown> | undefined): RoundArchive => {
    if (!image) throw new Error("fakeParseArchive: no image (simulated poison record)");
    return image as unknown as RoundArchive;
  };

  // Accounts-only identity (spec §7): projectArchive projects only ACCOUNT golfers (a golfer row
  // carrying a sub), so seed ann + bo as sub-bound rows and pass the golferStore through.
  const setup = async () => {
    const projectionStore = createInMemoryProjectionStore();
    const golferStore = createInMemoryGolferStore();
    await putAndBindGolfer(golferStore, ann, "sub-ann", "Ann");
    await putAndBindGolfer(golferStore, bo, "sub-bo", "Bo");
    const project = projectArchive({ projectionStore, golferStore, logger: createNullLogger() });
    return { projectionStore, golferStore, project, logger: createNullLogger() };
  };

  it("projects every record in a batch", async () => {
    const ctx = await setup();
    const handler = createProjectorHandler({ parseArchive: fakeParseArchive, project: ctx.project, logger: ctx.logger });

    await handler(
      streamEventFor([
        { eventId: "evt-1", image: archiveFor("r1", 1_000) },
        { eventId: "evt-2", image: archiveFor("r2", 2_000, bo) },
      ]),
    );

    expect(await ctx.projectionStore.listLines(ann)).toHaveLength(1);
    expect(await ctx.projectionStore.listLines(bo)).toHaveLength(1);
  });

  it("a poison record (unparseable NEW_IMAGE) logs and rethrows — never silently skipped", async () => {
    const ctx = await setup();
    const errorSpy = vi.fn();
    const handler = createProjectorHandler({ parseArchive: fakeParseArchive, project: ctx.project, logger: { ...ctx.logger, error: errorSpy } });

    await expect(handler(streamEventFor([{ eventId: "evt-poison", image: undefined }]))).rejects.toThrow(/poison record/);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]![1]).toMatchObject({ eventId: "evt-poison" });
  });

  it("a poison record partway through a batch stops the batch — never proceeds past the failure", async () => {
    const ctx = await setup();
    const handler = createProjectorHandler({ parseArchive: fakeParseArchive, project: ctx.project, logger: ctx.logger });

    await expect(
      handler(
        streamEventFor([
          { eventId: "evt-1", image: archiveFor("r1", 1_000) },
          { eventId: "evt-poison", image: undefined },
          { eventId: "evt-3", image: archiveFor("r3", 3_000, bo) },
        ]),
      ),
    ).rejects.toThrow();

    // The first record's write lands (already awaited before the poison record throws), but
    // the third — after the poison record in this batch — never runs.
    expect(await ctx.projectionStore.listLines(ann)).toHaveLength(1);
    expect(await ctx.projectionStore.listLines(bo)).toHaveLength(0);
  });
});
