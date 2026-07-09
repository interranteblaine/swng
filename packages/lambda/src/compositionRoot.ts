import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { Clock, ConnectionRegistry, CourseStore, IdGenerator, Logger, TokenIssuer } from "@swng/application";
import {
  addGame,
  addTeeSet,
  createCourse,
  finalizeRound,
  getCourse,
  joinRound,
  peekRound,
  readEvents,
  recordScore,
  searchCourses,
  startRound,
  verifyTeeSet,
} from "@swng/application";
import { createApiGatewayBroadcast, createManagementClient } from "@swng/adapters-apigateway";
import {
  createDocumentClient,
  createDynamoConnectionRegistry,
  createDynamoCourseStore,
  createDynamoEventJournal,
  createDynamoRoundStore,
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

export interface App {
  readonly dispatcher: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
  readonly registry: ConnectionRegistry;
  readonly tokens: TokenIssuer;
}

// Built ONCE at module scope by each entry (cold start), never re-instantiated per
// invocation (conventions §3) — every dependency this Lambda deployment needs, wired from
// env: TABLE_ROUNDS, TABLE_CONNECTIONS, TOKEN_SECRET, WS_ENDPOINT (apps/infra-cdk, M3 Task 5),
// plus TABLE_CORE (M6 Task 4) which is OPTIONAL here — only httpFn's environment carries it
// (see unavailableCourseStore above / swngStack.ts).
export const buildApp = (env: NodeJS.ProcessEnv): App => {
  const tableRounds = requireEnv(env, "TABLE_ROUNDS");
  const tableConnections = requireEnv(env, "TABLE_CONNECTIONS");
  const tableCore = env.TABLE_CORE; // optional — see unavailableCourseStore above
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

  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, logger);

  return { dispatcher, registry, tokens };
};
