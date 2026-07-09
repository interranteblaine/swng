import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { Clock, ConnectionRegistry, IdGenerator, Logger, TokenIssuer } from "@swng/application";
import { addGame, finalizeRound, joinRound, readEvents, recordScore, startRound } from "@swng/application";
import { createApiGatewayBroadcast, createManagementClient } from "@swng/adapters-apigateway";
import { createDocumentClient, createDynamoConnectionRegistry, createDynamoEventJournal, createDynamoRoundStore } from "@swng/adapters-dynamodb";
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
// `data` spreads FIRST, `message` second — a caller-supplied `data.message` key (coincidental
// or otherwise) must never clobber the actual log message; spreading `data` after `message`
// would let it win instead.
export const createConsoleLogger = (): Logger => ({
  info: (message, data) => console.log(JSON.stringify({ level: "info", ...data, message })),
  error: (message, data) => console.error(JSON.stringify({ level: "error", ...data, message })),
});

const requireEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`buildApp: missing required env var ${key}`);
  return value;
};

export interface App {
  readonly dispatcher: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
  readonly registry: ConnectionRegistry;
  readonly tokens: TokenIssuer;
}

// Built ONCE at module scope by each entry (cold start), never re-instantiated per
// invocation (conventions §3) — every dependency this Lambda deployment needs, wired from
// env: TABLE_ROUNDS, TABLE_CONNECTIONS, TOKEN_SECRET, WS_ENDPOINT (apps/infra-cdk, M3 Task 5).
export const buildApp = (env: NodeJS.ProcessEnv): App => {
  const tableRounds = requireEnv(env, "TABLE_ROUNDS");
  const tableConnections = requireEnv(env, "TABLE_CONNECTIONS");
  const tokenSecret = requireEnv(env, "TOKEN_SECRET");
  const wsEndpoint = requireEnv(env, "WS_ENDPOINT");

  const clock = createSystemClock();
  const ids = createRandomIds();
  const logger = createConsoleLogger();

  const documentClient = createDocumentClient();
  const journal = createDynamoEventJournal({ client: documentClient, tableName: tableRounds });
  const store = createDynamoRoundStore({ client: documentClient, tableName: tableRounds });
  const registry = createDynamoConnectionRegistry({ client: documentClient, tableName: tableConnections });

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
  };

  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, logger);

  return { dispatcher, registry, tokens };
};
