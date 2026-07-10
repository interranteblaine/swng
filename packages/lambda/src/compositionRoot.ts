import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, DynamoDBStreamEvent } from "aws-lambda";
import type { RoundArchive } from "@swng/domain";
import type { AccountVerifier, ArchiveSource, Clock, ConnectionRegistry, CourseStore, IdGenerator, Logger, TokenIssuer } from "@swng/application";
import {
  addGame,
  addTeeSet,
  createCourse,
  finalizeRound,
  getCourse,
  joinRound,
  peekRound,
  projectArchive,
  readEvents,
  rebuildProjections,
  recordScore,
  searchCourses,
  startRound,
  verifyTeeSet,
} from "@swng/application";
import { createApiGatewayBroadcast, createManagementClient } from "@swng/adapters-apigateway";
import { createCognitoVerifier } from "@swng/adapters-cognito";
import {
  createDocumentClient,
  createDynamoArchiveSource,
  createDynamoConnectionRegistry,
  createDynamoCourseStore,
  createDynamoEventJournal,
  createDynamoProjectionStore,
  createDynamoRoundStore,
  parseArchiveStreamImage,
} from "@swng/adapters-dynamodb";
import { createHmacTokenIssuer } from "./auth/hmacTokenIssuer.js";
import { createDispatcher } from "./http/dispatch.js";
import { buildRoutes } from "./http/routes.js";
import type { UseCases } from "./http/routes.js";

// 6 chars, no 0/O/1/I/L (M3 plan, Global Constraints) — visually unambiguous when read
// aloud or typed on a phone at the first tee.
const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const JOIN_CODE_LENGTH = 6;

const createSystemClock = (): Clock => ({ now: () => Date.now() });

const createRandomIds = (): IdGenerator => ({
  newId: () => randomUUID(),
  newJoinCode: () =>
    Array.from({ length: JOIN_CODE_LENGTH }, () => JOIN_CODE_ALPHABET.charAt(Math.floor(Math.random() * JOIN_CODE_ALPHABET.length))).join(""),
});

// A structured console Logger — the beta-grade choice (M9 hardens); CloudWatch ingests
// whatever a Lambda writes to stdout/stderr, so JSON lines here are already log-queryable.
// Exported (rather than kept module-private like createSystemClock/createRandomIds above)
// solely so compositionRoot.test.ts can pin its message-wins ordering without standing up a
// whole buildApp.
// `data` spreads FIRST, `level` and `message` both LAST — a caller-supplied `data.level` or
// `data.message` key (coincidental or otherwise) must never clobber the log entry's own
// fields; spreading `data` in between two reserved keys, rather than before just one, is what
// protects both. (`level` used to sit ahead of the spread — the M4 fix reserved `message` but
// missed `level`, which a `data.level` key could still clobber.)
export const createConsoleLogger = (): Logger => ({
  info: (message, data) => console.log(JSON.stringify({ ...data, level: "info", message })),
  error: (message, data) => console.error(JSON.stringify({ ...data, level: "error", message })),
});

const requireEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`buildApp: missing required env var ${key}`);
  return value;
};

// buildApp is the ONE composition root every entry shares (entries/http.ts, wsConnect.ts,
// wsDisconnect.ts all call it at module scope) — but TABLE_CORE only reaches httpFn's
// environment (swngStack.ts: "the course routes (M6) are HTTP-only — wsConnect/wsDisconnect
// never touch the core table"). wsConnect/wsDisconnect only ever reach into `app.tokens`/
// `app.registry`, never `app.dispatcher`, so their course-backed use cases are dead code —
// but buildApp still constructs the full UseCases table unconditionally (conventions §3: one
// composition root, not one per entry). A `requireEnv("TABLE_CORE")` here would crash THEIR
// cold start over a table they'll never query; this throws only if something actually calls
// through it, which only http.ts's dispatched course routes ever do.
const unavailableCourseStore = (): CourseStore => {
  const unavailable = (): never => {
    throw new Error("buildApp: TABLE_CORE is not set for this entry — course routes are HTTP-only (see swngStack.ts)");
  };
  return { put: unavailable, get: unavailable, search: unavailable };
};

// Same shape as unavailableCourseStore above, for the same reason: the "golfer" auth tier
// (M7 Task 4) is dispatched HTTP-only, but wsConnect/wsDisconnect share buildApp and never
// receive USER_POOL_ID/USER_POOL_CLIENT_ID (swngStack.ts only sets them on httpFn) — this
// throws only if a golfer-tier route is ever actually dispatched against a cold start that
// has no Cognito config, never at construction time.
const unavailableVerifier = (): AccountVerifier => ({
  verify: (): never => {
    throw new Error("buildApp: USER_POOL_ID/USER_POOL_CLIENT_ID are not set for this entry — the golfer auth tier is HTTP-only (see swngStack.ts)");
  },
});

export interface App {
  readonly dispatcher: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
  readonly registry: ConnectionRegistry;
  readonly tokens: TokenIssuer;
}

// Built ONCE at module scope by each entry (cold start), never re-instantiated per
// invocation (conventions §3) — every dependency this Lambda deployment needs, wired from
// env: TABLE_ROUNDS, TABLE_CONNECTIONS, TOKEN_SECRET, WS_ENDPOINT (apps/infra-cdk, M3 Task 5),
// plus TABLE_CORE (M6 Task 4) and USER_POOL_ID/USER_POOL_CLIENT_ID (M7 Task 4), both OPTIONAL
// here — only httpFn's environment carries them (see unavailableCourseStore/
// unavailableVerifier above / swngStack.ts).
export const buildApp = (env: NodeJS.ProcessEnv): App => {
  const tableRounds = requireEnv(env, "TABLE_ROUNDS");
  const tableConnections = requireEnv(env, "TABLE_CONNECTIONS");
  const tableCore = env.TABLE_CORE; // optional — see unavailableCourseStore above
  const userPoolId = env.USER_POOL_ID; // optional — see unavailableVerifier above
  const userPoolClientId = env.USER_POOL_CLIENT_ID; // optional, same reason
  const tokenSecret = requireEnv(env, "TOKEN_SECRET");
  const wsEndpoint = requireEnv(env, "WS_ENDPOINT");

  const clock = createSystemClock();
  const ids = createRandomIds();
  const logger = createConsoleLogger();

  const documentClient = createDocumentClient();
  const journal = createDynamoEventJournal({ client: documentClient, tableName: tableRounds });
  const store = createDynamoRoundStore({ client: documentClient, tableName: tableRounds });
  const registry = createDynamoConnectionRegistry({ client: documentClient, tableName: tableConnections });
  const courseStore = tableCore !== undefined ? createDynamoCourseStore({ client: documentClient, tableName: tableCore }) : unavailableCourseStore();
  const verifier =
    userPoolId !== undefined && userPoolClientId !== undefined
      ? createCognitoVerifier({ userPoolId, clientId: userPoolClientId })
      : unavailableVerifier();

  const managementClient = createManagementClient(wsEndpoint);
  const broadcast = createApiGatewayBroadcast({ client: managementClient, connections: registry, logger });

  const tokens = createHmacTokenIssuer({ secret: tokenSecret, clock });

  const useCases: UseCases = {
    startRound: startRound({ journal, store, broadcast, tokens, clock, ids }),
    joinRound: joinRound({ journal, store, broadcast, tokens, clock, ids }),
    addGame: addGame({ journal, broadcast, clock, ids }),
    recordScore: recordScore({ journal, broadcast }),
    finalizeRound: finalizeRound({ journal, store, broadcast, clock, ids }),
    readEvents: readEvents({ journal }),
    peekRound: peekRound({ journal, store }),
    createCourse: createCourse({ courseStore, idGenerator: ids, clock, logger }),
    addTeeSet: addTeeSet({ courseStore, clock, logger }),
    verifyTeeSet: verifyTeeSet({ courseStore, clock, logger }),
    getCourse: getCourse({ courseStore }),
    searchCourses: searchCourses({ courseStore }),
  };

  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, verifier, logger);

  return { dispatcher, registry, tokens };
};

// --- Projector (M7 Task 4): the DynamoDB Streams trigger on the rounds table's ARCHIVE
// items --------------------------------------------------------------------------------------

export interface ProjectorApp {
  readonly handler: (event: DynamoDBStreamEvent) => Promise<void>;
}

// The stream-record loop, factored out from its DynamoDB wiring (buildProjector below) —
// `parseArchive` is deps-injected (rather than this calling adapters-dynamodb's
// parseArchiveStreamImage directly) so compositionRoot.test.ts can drive the whole loop
// (multi-record batches, poison-record handling) against a plain fake, no AWS SDK types or
// calls involved (packages/lambda may not import `@aws-sdk/*` directly — eslint.config.mjs).
// Beta has no DLQ / on-failure destination on this event source mapping (swngStack.ts) — a
// poison record (an unparseable NEW_IMAGE, or projectArchive itself throwing) is logged and
// RETHROWN, never swallowed: with no partial-batch-failure reporting configured, that fails
// the whole batch, and the event source mapping retries it (until maxRecordAge/retryAttempts,
// both left at their infinite CDK defaults) — costing retries and (eventually) a human
// noticing a CloudWatch alarm, but never silently stopping a golfer's index from ever
// updating again, which a swallowed error would do instead.
export const createProjectorHandler =
  (deps: {
    parseArchive: (image: Record<string, unknown> | undefined) => RoundArchive;
    project: (archive: RoundArchive) => Promise<void>;
    logger: Logger;
  }) =>
  async (event: DynamoDBStreamEvent): Promise<void> => {
    for (const record of event.Records) {
      try {
        const archive = deps.parseArchive(record.dynamodb?.NewImage);
        await deps.project(archive);
      } catch (error) {
        deps.logger.error("projector: failed to project a stream record — will retry (no DLQ on this beta event source)", {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          eventId: record.eventID,
        });
        throw error;
      }
    }
  };

// TABLE_PROJECTIONS is the only env this entry needs (swngStack.ts) — unlike buildApp, nothing
// here is shared with another entry, so there's no "optional var" story to mirror.
export const buildProjector = (env: NodeJS.ProcessEnv): ProjectorApp => {
  const tableProjections = requireEnv(env, "TABLE_PROJECTIONS");

  const clock = createSystemClock();
  const logger = createConsoleLogger();
  const documentClient = createDocumentClient();
  const projectionStore = createDynamoProjectionStore({ client: documentClient, tableName: tableProjections });
  const project = projectArchive({ projectionStore, clock, logger });

  return { handler: createProjectorHandler({ parseArchive: parseArchiveStreamImage, project, logger }) };
};

// --- Rebuild (M7 Task 4): manual-invoke only, replays every archive in the rounds table
// through the SAME projectArchive the stream trigger uses (rebuildProjections' own doc
// comment: "no forked math") -------------------------------------------------------------

export interface RebuildApp {
  readonly handler: () => Promise<{ rounds: number; golfers: number }>;
}

export const buildRebuild = (env: NodeJS.ProcessEnv): RebuildApp => {
  const tableRounds = requireEnv(env, "TABLE_ROUNDS");
  const tableProjections = requireEnv(env, "TABLE_PROJECTIONS");

  const clock = createSystemClock();
  const logger = createConsoleLogger();
  const documentClient = createDocumentClient();
  const projectionStore = createDynamoProjectionStore({ client: documentClient, tableName: tableProjections });
  const archiveSource: ArchiveSource = createDynamoArchiveSource({ client: documentClient, tableName: tableRounds });

  return { handler: rebuildProjections({ archiveSource, projectionStore, clock, logger }) };
};
