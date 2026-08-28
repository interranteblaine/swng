import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { deviceId, fixtureLinks18, golferId, opId, roundId } from "@swng/domain";
import type { RoundArchive, RoundEvent } from "@swng/domain";
import { createFixedClock, createInMemoryGolferStore, createInMemoryProjectionStore, createNullLogger, projectArchive, putAndBindGolfer } from "@swng/application";
import { buildApp, buildProjector, buildRebuild, createConsoleLogger, createEmfMetrics, createProjectorHandler, createRandomIds } from "./compositionRoot.js";
import { createHmacTokenIssuer } from "./auth/hmacTokenIssuer.js";
import type { HttpRequest } from "./http/httpRequest.js";
import { createCognitoVerifier } from "@swng/adapters-cognito";

// Task 11 review fix 2: buildApp's default verifier branch (deps.accountVerifier ?? ...
// createCognitoVerifier(...)) is otherwise pinned by NOTHING — every existing test either
// injects a fake accountVerifier or never dispatches a "golfer" route, so replacing the
// default with `unavailableVerifier()` unconditionally would break the web silently. Wrapping
// the real createCognitoVerifier in a spy (rather than a fake replacement) keeps every OTHER
// test in this file byte-identical — the wrapped function still constructs and returns the
// real Cognito verifier, this just lets one test downstream assert it was actually called.
vi.mock("@swng/adapters-cognito", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@swng/adapters-cognito")>();
  return { ...actual, createCognitoVerifier: vi.fn(actual.createCognitoVerifier) };
});

// Every buildApp call in this file injects this fake in place of the real Secrets Manager
// fetch (Task 4: buildApp now resolves TOKEN_SECRET_ARN via an injectable readSecret seam) —
// no test here needs AWS credentials or a network call. "resolved-secret" is deliberately
// NOT the string "test-secret" a stray TOKEN_SECRET-reading regression would produce, so a
// test asserting on signed-token behavior can tell the two paths apart.
const fakeReadSecret = async (_arn: string): Promise<string> => "resolved-secret";

// Prod-readiness hardening Arc A, Task 2: a join code is a capability (holding one lets someone
// onto a round and record scores), so it must come from a CSPRNG, not Math.random's predictable
// PRNG. The wire-side alphabet regex landed in Task 1; this pins the generator's own output stays
// inside that alphabet AND that it never touches Math.random.
describe("createRandomIds — newJoinCode", () => {
  it("mints a 6-char join code from the unambiguous alphabet only", () => {
    const ids = createRandomIds();
    for (let i = 0; i < 200; i += 1) {
      const code = ids.newJoinCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it("does not use Math.random for join codes", () => {
    const spy = vi.spyOn(Math, "random");
    createRandomIds().newJoinCode();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

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

// EMF (CloudWatch Embedded Metric Format): the house-style hand-rolled analogue of
// createConsoleLogger above — a specially-shaped JSON stdout line CloudWatch auto-extracts
// into a metric, no PutMetricData/IAM/async flush involved.
describe("createEmfMetrics", () => {
  it("createEmfMetrics writes a valid EMF envelope to stdout (namespace swng, Stage dimension, Count 1)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      createEmfMetrics("beta").count("RoundsCreated");
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(payload._aws.CloudWatchMetrics[0]).toEqual({
        Namespace: "swng",
        Dimensions: [["Stage"]],
        Metrics: [{ Name: "RoundsCreated", Unit: "Count" }],
      });
      expect(typeof payload._aws.Timestamp).toBe("number");
      expect(payload.Stage).toBe("beta");
      expect(payload.RoundsCreated).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("createEmfMetrics never throws", () => {
    expect(() => createEmfMetrics("beta").count("Signups")).not.toThrow();
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
    TOKEN_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-test",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when TABLE_CORE is absent — wsConnect/wsDisconnect's real env shape", async () => {
    await expect(buildApp(baseEnv, { readSecret: fakeReadSecret })).resolves.toBeDefined();
  });

  it("does not throw when TABLE_CORE IS present — httpFn's real env shape", async () => {
    await expect(buildApp({ ...baseEnv, TABLE_CORE: "core-table" }, { readSecret: fakeReadSecret })).resolves.toBeDefined();
  });

  it("a dispatched course route 500s gracefully (not a process crash) when TABLE_CORE was absent at cold start", async () => {
    const app = await buildApp(baseEnv, { readSecret: fakeReadSecret });
    // GET /courses/{courseId} is auth "none" (course-cards spec §4), so it reaches the handler
    // — and the unavailable card store — with no Cognito config required; the write routes are
    // "golfer"-gated now and would 401 before the store, which wouldn't exercise this path.
    const request: HttpRequest = { method: "GET", path: "/courses/does-not-exist", headers: {}, query: {}, body: undefined };

    const result = await app.dispatcher(request);
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
    TOKEN_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-test",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when USER_POOL_ID/USER_POOL_CLIENT_ID are absent — wsConnect/wsDisconnect's real env shape", async () => {
    await expect(buildApp(baseEnv, { readSecret: fakeReadSecret })).resolves.toBeDefined();
  });

  it("does not throw when USER_POOL_ID/USER_POOL_CLIENT_ID ARE present — httpFn's real env shape", async () => {
    await expect(
      buildApp({ ...baseEnv, USER_POOL_ID: "us-east-1_Test123", USER_POOL_CLIENT_ID: "test-client-id" }, { readSecret: fakeReadSecret }),
    ).resolves.toBeDefined();
  });
});

// Task 11 (the bug this task exists to prevent): buildApp built createCognitoVerifier
// internally with no seam to override it, so nothing short of a real Cognito user pool could
// dispatch a "golfer"-tier route in a test — which is exactly how a `tokenUse: "id"` verifier
// wired up to reject every Cognito ACCESS token went uncaught. `deps.accountVerifier` opens
// that seam, same idiom as `deps.readSecret` above. This test proves two things at once: the
// seam is wired (the injected fake, not a real Cognito verifier, is what the dispatcher calls),
// and doing so does NOT require TABLE_CORE/USER_POOL_ID/USER_POOL_CLIENT_ID to be set — a fake
// verifier is enough to reach a golfer-tier handler in a hermetic test.
describe("buildApp — deps.accountVerifier overrides the default Cognito verifier", () => {
  const baseEnv = {
    TABLE_ROUNDS: "rounds-table",
    TABLE_CONNECTIONS: "connections-table",
    TOKEN_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-test",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  // GET /me reaches unavailableGolferStore (no TABLE_CORE here) and 500s — expected, and
  // covered by the TABLE_CORE describe block above's own "500s gracefully" test. Silenced the
  // same way createConsoleLogger's own describe block above does (:46-47): a passing suite's
  // stdout/stderr should be pristine, not carrying a real access-log line and a full
  // "dispatcher: unhandled error" stack trace that trains people to ignore stack traces.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.mocked(createCognitoVerifier).mockClear();
  });

  it("dispatches a golfer-tier route through the injected fake verifier, not the real Cognito one", async () => {
    const fakeVerifier = { verify: vi.fn(async () => ({ sub: "sub-1" })) };
    const app = await buildApp(baseEnv, { readSecret: fakeReadSecret, accountVerifier: fakeVerifier });

    const request: HttpRequest = { method: "GET", path: "/me", headers: { authorization: "Bearer fake-access-token" }, query: {}, body: undefined };
    await app.dispatcher(request);

    expect(fakeVerifier.verify).toHaveBeenCalledWith("fake-access-token");
  });

  // Task 11 review fix 2 (the important one): pins the DEFAULT branch itself, not just that an
  // override works. Nothing else in this file would fail if `deps.accountVerifier ?? ...` were
  // replaced with `deps.accountVerifier ?? unavailableVerifier()` — dropping the Cognito
  // fallback and silently breaking the web, precisely the class of regression this task exists
  // to prevent (a `tokenUse: "id"` verifier is exactly what buildApp must still construct here).
  it("falls back to the real createCognitoVerifier, with the real pool/client config, when no accountVerifier is injected", async () => {
    await buildApp({ ...baseEnv, USER_POOL_ID: "us-east-1_Test123", USER_POOL_CLIENT_ID: "test-client-id" }, { readSecret: fakeReadSecret });

    expect(createCognitoVerifier).toHaveBeenCalledWith({ userPoolId: "us-east-1_Test123", clientId: "test-client-id" });
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
    TOKEN_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-test",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when TABLE_PROJECTIONS is absent — wsConnect/wsDisconnect's real env shape", async () => {
    await expect(buildApp(baseEnv, { readSecret: fakeReadSecret })).resolves.toBeDefined();
  });

  it("does not throw when TABLE_PROJECTIONS IS present — httpFn's real env shape", async () => {
    await expect(buildApp({ ...baseEnv, TABLE_PROJECTIONS: "projections-table" }, { readSecret: fakeReadSecret })).resolves.toBeDefined();
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
    TOKEN_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-test",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };

  it("does not throw when TABLE_SNAPSHOTS is absent — wsConnect/wsDisconnect's real env shape", async () => {
    await expect(buildApp(baseEnv, { readSecret: fakeReadSecret })).resolves.toBeDefined();
  });

  it("does not throw when TABLE_SNAPSHOTS IS present — httpFn's real env shape", async () => {
    await expect(buildApp({ ...baseEnv, TABLE_SNAPSHOTS: "snapshots-table" }, { readSecret: fakeReadSecret })).resolves.toBeDefined();
  });
});

// Prod-readiness hardening Arc A, Task 4: the token-signing secret moves from a plaintext
// TOKEN_SECRET env var to a runtime Secrets Manager fetch by ARN — buildApp reads
// TOKEN_SECRET_ARN (never TOKEN_SECRET again) and resolves it through an injectable
// `readSecret` seam (default = @swng/adapters-secretsmanager's real SDK fetch) so this suite
// never touches AWS.
describe("buildApp — resolves TOKEN_SECRET_ARN via the injected readSecret seam (Task 4)", () => {
  const baseEnv = {
    TABLE_ROUNDS: "rounds-table",
    TABLE_CONNECTIONS: "connections-table",
    WS_ENDPOINT: "https://example.execute-api.us-east-1.amazonaws.com/beta",
  };
  const secretArn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-beta";

  it("builds the token issuer from the resolved secret, not a plaintext env var", async () => {
    const readSecret = vi.fn(async (arn: string): Promise<string> => {
      expect(arn).toBe(secretArn);
      return "resolved-secret";
    });

    const app = await buildApp({ ...baseEnv, TOKEN_SECRET_ARN: secretArn }, { readSecret });

    // The injected reader was actually called, exactly once, with the ARN — not skipped, not
    // called with something else.
    expect(readSecret).toHaveBeenCalledOnce();
    expect(readSecret).toHaveBeenCalledWith(secretArn);

    // Prove the RESOLVED value is what actually signs (not some other secret, and not
    // TOKEN_SECRET, which was never even in the env passed above): a token minted by
    // app.tokens verifies under a standalone issuer keyed by "resolved-secret" — the same
    // "build a second issuer off the same secret" idiom wsConnect.test.ts already uses.
    const claims = { scope: "participant" as const, roundId: roundId("r-1"), golferId: golferId("g-1") };
    const token = app.tokens.issue(claims);
    const standaloneIssuer = createHmacTokenIssuer({ secret: "resolved-secret", clock: createFixedClock(0) });
    expect(standaloneIssuer.verify(token)).toEqual(claims);

    // And it must NOT verify under any other secret — proving the resolved value, not some
    // fixed/default string, is what actually signed it.
    const wrongIssuer = createHmacTokenIssuer({ secret: "some-other-secret", clock: createFixedClock(0) });
    expect(wrongIssuer.verify(token)).toBeUndefined();
  });

  it("throws a clear error when TOKEN_SECRET_ARN is missing", async () => {
    await expect(buildApp(baseEnv, { readSecret: fakeReadSecret })).rejects.toThrow(/TOKEN_SECRET_ARN/);
  });

  // The plaintext delivery path is GONE, not just deprioritized: a legacy TOKEN_SECRET env
  // var (with no ARN) must not silently satisfy buildApp — it has to fail the same way an
  // env missing the var entirely does.
  it("a TOKEN_SECRET env var alone (no ARN) no longer satisfies buildApp — the plaintext path is gone", async () => {
    await expect(buildApp({ ...baseEnv, TOKEN_SECRET: "plaintext-secret" }, { readSecret: fakeReadSecret })).rejects.toThrow(/TOKEN_SECRET_ARN/);
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
    // A seat nobody typed a number onto sits on its default 0 strokes (spec 2026-07-30 §2).
    participants: [{ golferId: participantId, name: participantId, tee: "white", strokes: 0 }],
    games: [],
    cells: {},
    // A real archive's log always opens with round-created (its genesis) — carried so the
    // projector's createdAtMsOf (accounts-only identity spec §5) resolves; its wall time (1) is
    // arbitrary here, only its PRESENCE matters. playedAtMs mirrors that same arbitrary instant
    // (round-played-date spec 2026-08-01 §3a's required field — no fallback exists to lean on).
    // Deliberately equal (Minor 7, task-7 review) — correct today since no assertion in this
    // file reads it, but the exact same-instant shape this arc has twice shipped an
    // unfalsifiable test on. Any future played-date assertion here must make the two diverge
    // ACROSS A CALENDAR DAY to be observable.
    events: [
      {
        kind: "round-created",
        roundId: roundId(roundKey),
        card: fixtureLinks18,
        playedAtMs: 1,
        opId: opId(`created-${roundKey}`),
        hlc: { wallMs: 1, counter: 0, deviceId: deviceId("server") },
        authorId: ann,
      },
      finalizedEvent(wallMs, roundKey),
    ],
    results: [],
    terminatedGameIds: [],
  });

  // The "image" the fake parseArchive below reads back is the archive itself, unwrapped —
  // never real DynamoDB-JSON-shaped AttributeValues (that's parseSnapshotStreamImage's own
  // concern, unit-tested in adapters-dynamodb), so NewImage's real type is cast away here.
  const streamEventFor = (records: readonly { eventId: string; image: RoundArchive | undefined; eventName?: "INSERT" | "REMOVE" }[]): DynamoDBStreamEvent => ({
    Records: records.map(
      (r) =>
        ({ eventID: r.eventId, eventName: r.eventName ?? "INSERT", dynamodb: { NewImage: r.image } }) as unknown as DynamoDBStreamEvent["Records"][number],
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

  it("a REMOVE record (an operational snapshot scrap) is skipped, logged, never thrown — the batch's INSERTs still project", async () => {
    const ctx = await setup();
    const infoSpy = vi.fn();
    const handler = createProjectorHandler({ parseArchive: fakeParseArchive, project: ctx.project, logger: { ...ctx.logger, info: infoSpy } });

    // The REMOVE carries no NEW_IMAGE — exactly the shape that blocked the shard live on
    // 2026-07-15 when the beta scrap deleted 1,080 snapshots. It must not reach parseArchive.
    await handler(
      streamEventFor([
        { eventId: "evt-removed", image: undefined, eventName: "REMOVE" },
        { eventId: "evt-live", image: archiveFor("r-after-scrap", 3_000) },
      ]),
    );

    expect(await ctx.projectionStore.listLines(ann)).toHaveLength(1);
    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy.mock.calls[0]![1]).toMatchObject({ eventId: "evt-removed" });
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
