import { randomInt, randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, DynamoDBStreamEvent } from "aws-lambda";
import type { RoundArchive } from "@swng/domain";
import type {
  AccountVerifier,
  CardStore,
  Clock,
  ConnectionRegistry,
  CrewStore,
  GolferStore,
  IdGenerator,
  Logger,
  ProjectionStore,
  SnapshotStore,
  TokenIssuer,
} from "@swng/application";
import {
  abandonRound,
  addGame,
  createCourse,
  createCrew,
  createSeason,
  finalizeRound,
  getCourse,
  getCrew,
  getGolfer,
  getMyCourseRecord,
  getMyGolfer,
  getMyLiveRounds,
  getMyRecord,
  getMyRounds,
  getRoundArchive,
  getSeasonStandings,
  getShareLink,
  joinCrewByInvite,
  joinRound,
  leaveCrew,
  leaveRound,
  listMyCrews,
  listSeasons,
  mintCrewInvite,
  mintParticipantToken,
  peekCrewInvite,
  peekRound,
  projectArchive,
  readEvents,
  rebuildProjections,
  recordScore,
  removeCrewMember,
  searchCourses,
  setHandicap,
  startRound,
  supersedeCard,
  terminateGame,
  transferOrganizer,
  updateCrew,
  updateMyGolfer,
  updateSeason,
} from "@swng/application";
import { createApiGatewayBroadcast, createManagementClient } from "@swng/adapters-apigateway";
import { createCognitoVerifier } from "@swng/adapters-cognito";
import {
  createDocumentClient,
  createDynamoCardStore,
  createDynamoConnectionRegistry,
  createDynamoCrewStore,
  createDynamoEventJournal,
  createDynamoGolferStore,
  createDynamoProjectionStore,
  createDynamoRoundStore,
  createDynamoSnapshotStore,
  parseSnapshotStreamImage,
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

// Exported (rather than kept module-private) solely so compositionRoot.test.ts can pin the
// join-code generator's alphabet/CSPRNG-source invariants without standing up a whole buildApp
// — mirrors createConsoleLogger's own export just below.
export const createRandomIds = (): IdGenerator => ({
  newId: () => randomUUID(),
  // crypto.randomInt is a CSPRNG — a join code is a capability (it lets someone onto a round),
  // so it must not come from Math.random's predictable PRNG.
  newJoinCode: () =>
    Array.from({ length: JOIN_CODE_LENGTH }, () => JOIN_CODE_ALPHABET.charAt(randomInt(JOIN_CODE_ALPHABET.length))).join(""),
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
  warn: (message, data) => console.warn(JSON.stringify({ ...data, level: "warn", message })),
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
const unavailableCardStore = (): CardStore => {
  const unavailable = (): never => {
    throw new Error("buildApp: TABLE_CORE is not set for this entry — course routes are HTTP-only (see swngStack.ts)");
  };
  return { create: unavailable, supersede: unavailable, getCurrent: unavailable, search: unavailable };
};

// Same shape as unavailableCardStore above, for the same reason: the "golfer" auth tier
// (M7 Task 4) is dispatched HTTP-only, but wsConnect/wsDisconnect share buildApp and never
// receive USER_POOL_ID/USER_POOL_CLIENT_ID (swngStack.ts only sets them on httpFn) — this
// throws only if a golfer-tier route is ever actually dispatched against a cold start that
// has no Cognito config, never at construction time.
const unavailableVerifier = (): AccountVerifier => ({
  verify: (): never => {
    throw new Error("buildApp: USER_POOL_ID/USER_POOL_CLIENT_ID are not set for this entry — the golfer auth tier is HTTP-only (see swngStack.ts)");
  },
});

// Same shape again, for TABLE_CORE (unavailableCardStore's own reason: wsConnect/
// wsDisconnect never dispatch a golfer/course route) — golferStore lives on the CORE table
// (keys.ts's golferPk), not TABLE_PROJECTIONS, so it shares TABLE_CORE's optionality with
// courseStore rather than getting its own env var.
const unavailableGolferStore = (): GolferStore => {
  const unavailable = (): never => {
    throw new Error("buildApp: TABLE_CORE is not set for this entry — golfer routes are HTTP-only (see swngStack.ts)");
  };
  return { put: unavailable, get: unavailable, getMany: unavailable, getBySub: unavailable, bindSub: unavailable };
};

// Same shape again, for TABLE_CORE (unavailableCardStore's own reason: wsConnect/
// wsDisconnect never dispatch a golfer/crew/course route) — crewStore lives on the SAME core
// table as courseStore/golferStore (keys.ts's crewPk), so it shares TABLE_CORE's optionality
// rather than getting its own env var. (M8 Task 2/3 built this as a permanent STOPGAP that
// unconditionally threw; M8 Task 4 replaces that with the real createDynamoCrewStore below,
// wired the same optional way courseStore/golferStore already are.)
const unavailableCrewStore = (): CrewStore => {
  const unavailable = (): never => {
    throw new Error("buildApp: TABLE_CORE is not set for this entry — crew routes are HTTP-only (see swngStack.ts)");
  };
  return {
    put: unavailable,
    get: unavailable,
    listByGolfer: unavailable,
    putSeason: unavailable,
    getSeason: unavailable,
    listSeasons: unavailable,
    countsRound: unavailable,
  };
};

// Same shape again, for TABLE_PROJECTIONS (M7 Task 5: granted + env'd onto httpFn since Task
// 4, but unread by buildApp until now — only getMyRecord needs it; wsConnect/wsDisconnect
// never do). Realignment Task 13 widens the real set of callers (startRound/joinRound's own
// presence writes, getMyLiveRounds' own read) but the story is unchanged: every one of them is
// HTTP-only, so wsConnect/wsDisconnect still never reach this.
const unavailableProjectionStore = (): ProjectionStore => {
  const unavailable = (): never => {
    throw new Error("buildApp: TABLE_PROJECTIONS is not set for this entry — the record route is HTTP-only (see swngStack.ts)");
  };
  return {
    putLine: unavailable,
    listLines: unavailable,
    // Presence (realignment Task 13): real callers as of this task — ports/projectionStore.ts's
    // own doc comment.
    putLive: unavailable,
    deleteLive: unavailable,
    listLive: unavailable,
    // The crew ledger projection methods are gone (realignment Task 9): crew standings are
    // computed on read over the snapshots table (crews/getSeasonStandings), not stored here.
  };
};

// Same shape again, for TABLE_SNAPSHOTS (projection-realignment Task 2): only httpFn carries it
// (swngStack.ts), and only finalizeRound reads a snapshot back (its idempotent branch); wsConnect/
// wsDisconnect never dispatch finalize, so they get this stub. finalizeRound's atomic write path
// doesn't go through this store at all — it's the journal's snapshotsTableName that must be set,
// which is likewise absent for those entries (and unreached, since they never finalize).
const unavailableSnapshotStore = (): SnapshotStore => {
  const unavailable = (): never => {
    throw new Error("buildApp: TABLE_SNAPSHOTS is not set for this entry — finalize is HTTP-only (see swngStack.ts)");
  };
  return { get: unavailable, getMany: unavailable, page: unavailable };
};

export interface App {
  readonly dispatcher: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
  readonly registry: ConnectionRegistry;
  readonly tokens: TokenIssuer;
}

// Built ONCE at module scope by each entry (cold start), never re-instantiated per
// invocation (conventions §3) — every dependency this Lambda deployment needs, wired from
// env: TABLE_ROUNDS, TABLE_CONNECTIONS, TOKEN_SECRET, WS_ENDPOINT (apps/infra-cdk, M3 Task 5),
// plus TABLE_CORE (M6 Task 4), USER_POOL_ID/USER_POOL_CLIENT_ID, and TABLE_PROJECTIONS (M7
// Task 4/5), all OPTIONAL here — only httpFn's environment carries them (see
// unavailableCardStore/unavailableVerifier/unavailableGolferStore/
// unavailableProjectionStore above / swngStack.ts).
export const buildApp = (env: NodeJS.ProcessEnv): App => {
  const tableRounds = requireEnv(env, "TABLE_ROUNDS");
  const tableConnections = requireEnv(env, "TABLE_CONNECTIONS");
  const tableCore = env.TABLE_CORE; // optional — see unavailableCardStore above
  const tableProjections = env.TABLE_PROJECTIONS; // optional — see unavailableProjectionStore above
  const tableSnapshots = env.TABLE_SNAPSHOTS; // optional — see unavailableSnapshotStore above
  const userPoolId = env.USER_POOL_ID; // optional — see unavailableVerifier above
  const userPoolClientId = env.USER_POOL_CLIENT_ID; // optional, same reason
  const tokenSecret = requireEnv(env, "TOKEN_SECRET");
  const wsEndpoint = requireEnv(env, "WS_ENDPOINT");

  const clock = createSystemClock();
  const ids = createRandomIds();
  const logger = createConsoleLogger();

  const documentClient = createDocumentClient();
  // snapshotsTableName lets finalizeRound's append commit round-finalized + the settled snapshot
  // in one transaction (projection-realignment §2). Optional here — only httpFn carries
  // TABLE_SNAPSHOTS, and only finalize sets options.snapshot, so the other entries never trip
  // the "snapshot without a table" guard inside the journal.
  const journal = createDynamoEventJournal({ client: documentClient, tableName: tableRounds, snapshotsTableName: tableSnapshots });
  const store = createDynamoRoundStore({ client: documentClient, tableName: tableRounds });
  const snapshots = tableSnapshots !== undefined ? createDynamoSnapshotStore({ client: documentClient, tableName: tableSnapshots }) : unavailableSnapshotStore();
  const registry = createDynamoConnectionRegistry({ client: documentClient, tableName: tableConnections });
  const cardStore = tableCore !== undefined ? createDynamoCardStore({ client: documentClient, tableName: tableCore }) : unavailableCardStore();
  // golferStore lives on the SAME table as the card store (keys.ts's golferPk — the core
  // table), so it shares tableCore's optionality rather than getting its own env var.
  const golferStore = tableCore !== undefined ? createDynamoGolferStore({ client: documentClient, tableName: tableCore }) : unavailableGolferStore();
  // M8 Task 4: crewStore lives on the SAME core table too (keys.ts's crewPk) — see
  // unavailableCrewStore's own doc comment above.
  const crewStore = tableCore !== undefined ? createDynamoCrewStore({ client: documentClient, tableName: tableCore }) : unavailableCrewStore();
  const projectionStore =
    tableProjections !== undefined ? createDynamoProjectionStore({ client: documentClient, tableName: tableProjections }) : unavailableProjectionStore();
  const verifier =
    userPoolId !== undefined && userPoolClientId !== undefined
      ? createCognitoVerifier({ userPoolId, clientId: userPoolClientId })
      : unavailableVerifier();

  const managementClient = createManagementClient(wsEndpoint);
  const broadcast = createApiGatewayBroadcast({ client: managementClient, connections: registry, logger });

  const tokens = createHmacTokenIssuer({ secret: tokenSecret, clock });

  const useCases: UseCases = {
    // golferStore threaded through for the as-self get-or-create (golfers/ensureGolfer.ts):
    // accounts-only identity (spec §3) — the creator/joiner seat is always the caller's own
    // account golfer, minted on first touch if none exists yet.
    // projectionStore/logger (projection-realignment Task 13): every seated participant gets a
    // best-effort presence write (rounds/presence.ts) — the SAME projectionStore instance
    // getMyRecord/getMyRounds/getMyLiveRounds already share, and the SAME logger every other
    // use case in this table does. cardStore (course-cards spec §4): StartRound resolves
    // `command.course` by reference and freezes the CURRENT card itself — the SAME cardStore
    // instance createCourse/supersedeCard/getCourse/searchCourses already share below.
    startRound: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger, cardStore }),
    joinRound: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, projectionStore, logger }),
    addGame: addGame({ journal, broadcast, clock, ids }),
    recordScore: recordScore({ journal, broadcast }),
    finalizeRound: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    // projectionStore/logger (task-15): abandon clears each participant's LIVE presence pointer
    // itself — no snapshot is written, so the projector never runs the finalize-time deleteLive
    // loop for a scrapped round. Same projectionStore/logger instances startRound/joinRound share.
    abandonRound: abandonRound({ journal, broadcast, clock, ids, projectionStore, logger }),
    // accounts-only identity spec §4: a participant walks off — same journal/broadcast/clock/ids
    // instances the other participant round acts above already share.
    leaveRound: leaveRound({ journal, broadcast, clock, ids }),
    // spec 2026-07-20: mid-round course handicap correction — same journal/broadcast/clock/ids
    // instances the other participant round acts above already share.
    setHandicap: setHandicap({ journal, broadcast, clock, ids }),
    readEvents: readEvents({ journal }),
    peekRound: peekRound({ journal, store }),
    getShareLink: getShareLink({ tokens }),
    // snapshots (projection-realignment Task 6; navigation spec §6b dropped the golferStore/
    // crewStore authorization deps — any signed-in golfer may read now, so only "does a
    // snapshot exist" is left to check): the SAME instance finalize/crew use cases above share.
    getRoundArchive: getRoundArchive({ snapshots }),
    // journal/golferStore/tokens (architecture-realignment Task 14): the SAME journal/tokens
    // instances startRound/joinRound above already share, plus the SAME golferStore
    // startRound/joinRound above share. store (spec 2026-07-20 §2): the SAME createDynamoRoundStore
    // instance startRound/joinRound above already share — mint now reads the round's own join
    // code off it too.
    mintParticipantToken: mintParticipantToken({ journal, golferStore, tokens, store }),
    // Course-cards spec §4: createCourse/supersedeCard derive enteredBy from the account
    // (golferStore's own get-or-create), so they take the SAME golferStore startRound/joinRound
    // share; the two reads take only the cardStore.
    createCourse: createCourse({ cardStore, golferStore, idGenerator: ids, clock, logger }),
    supersedeCard: supersedeCard({ cardStore, golferStore, idGenerator: ids, clock, logger }),
    getCourse: getCourse({ cardStore }),
    searchCourses: searchCourses({ cardStore }),
    terminateGame: terminateGame({ journal, broadcast, clock, ids }),
    // idGenerator (accounts-only identity spec §2): GET /me now get-or-creates (ensureGolfer),
    // which mints a fresh golferId when the sub has none — the same `ids` every other minting use
    // case above shares.
    getMyGolfer: getMyGolfer({ golferStore, idGenerator: ids }),
    updateMyGolfer: updateMyGolfer({ golferStore, idGenerator: ids }),
    // clock (pre-prod hardening D4a): the handicap index is computed HERE, at read time, from
    // the SAME lines the response already carries — never a stored snapshot. The SAME system
    // clock every other use case above shares.
    getMyRecord: getMyRecord({ golferStore, projectionStore, clock }),
    // analytics spec 2026-07-21 §4: the SAME golferStore/projectionStore instances getMyRecord
    // above shares — get-or-nothing, filtered to one course.
    getMyCourseRecord: getMyCourseRecord({ golferStore, projectionStore }),
    getMyRounds: getMyRounds({ golferStore, projectionStore }),
    // journal (accounts-only identity spec §5): the live list derives each round's created-at from
    // its genesis at read time — the SAME journal every round use case above shares.
    getMyLiveRounds: getMyLiveRounds({ golferStore, projectionStore, journal }),
    // Navigation spec §6a: golferStore/projectionStore — the SAME instances getMyRecord above
    // shares (getGolfer runs the identical recordOf fold, just for a golferId off the path
    // instead of the caller's own sub).
    getGolfer: getGolfer({ golferStore, projectionStore }),
    // crew-scoreboard spec §2: createCrew now auto-opens the crew's first season (clock stamps
    // its window start) — the SAME system clock every other use case above shares.
    createCrew: createCrew({ crewStore, golferStore, ids, clock }),
    getCrew: getCrew({ crewStore, golferStore }),
    listMyCrews: listMyCrews({ crewStore, golferStore }),
    // Crew membership (invited in, accountable out): mintCrewInvite needs tokens (the SAME
    // TokenIssuer/hmacTokenIssuer instance every round-scoped route already shares — "never a
    // parallel signer") + clock (the 7-day stamp); peekCrewInvite/joinCrewByInvite need tokens
    // too, PLUS their own clock reading — hmacTokenIssuer's crew-invite verify() arm
    // deliberately does NOT gate on expiry itself (ports/tokenIssuer.ts's own doc comment on
    // CrewInviteClaims), so "expired" vs. "otherwise invalid" is these use cases' OWN Clock
    // comparison, not the issuer's.
    mintCrewInvite: mintCrewInvite({ crewStore, golferStore, tokenIssuer: tokens, clock }),
    peekCrewInvite: peekCrewInvite({ crewStore, tokenIssuer: tokens, clock }),
    joinCrewByInvite: joinCrewByInvite({ crewStore, golferStore, tokenIssuer: tokens, clock }),
    // Architecture-realignment Task 9: crew seasons + standings-on-read + leave — the SAME
    // crewStore/golferStore/snapshots/clock/ids instances the crew + finalize use cases above
    // already share (standings fold a window of snapshots on read, never a stored ledger — the
    // counting apparatus this comment used to describe is deleted whole, crew-scoreboard §2b).
    createSeason: createSeason({ crewStore, golferStore, ids, clock }),
    listSeasons: listSeasons({ crewStore, golferStore }),
    // Spec 2026-07-22 "the season is the record" §2: editing the end date IS the whole
    // lifecycle — the SAME crewStore/golferStore instances every other crew/season use case
    // above shares. updateCrew shares the same two deps too (no season lookup).
    updateSeason: updateSeason({ crewStore, golferStore }),
    updateCrew: updateCrew({ crewStore, golferStore }),
    // projectionStore (crew-scoreboard spec §3): ONE listLines query per roster member feeds the
    // scoreboard, the shared-round derivation, AND the index boundaries alike — the SAME
    // projectionStore instance getMyRecord above shares.
    getSeasonStandings: getSeasonStandings({ crewStore, golferStore, snapshots, projectionStore }),
    leaveCrew: leaveCrew({ crewStore, golferStore }),
    // Crew membership (invited in, accountable out — spec §1): the organizer's authority — the
    // SAME crewStore/golferStore instances leaveCrew above shares.
    removeCrewMember: removeCrewMember({ crewStore, golferStore }),
    transferOrganizer: transferOrganizer({ crewStore, golferStore }),
  };

  const dispatcher = createDispatcher(buildRoutes(useCases), tokens, verifier, logger);

  return { dispatcher, registry, tokens };
};

// --- Projector (M7 Task 4; projection-realignment Task 2): the DynamoDB Streams trigger on the
// snapshots table — every item there IS a finished round, so the stream is unfiltered ----------

export interface ProjectorApp {
  readonly handler: (event: DynamoDBStreamEvent) => Promise<void>;
}

// The stream-record loop, factored out from its DynamoDB wiring (buildProjector below) —
// `parseArchive` is deps-injected (rather than this calling adapters-dynamodb's
// parseSnapshotStreamImage directly) so compositionRoot.test.ts can drive the whole loop
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
      // A REMOVE carries no NEW_IMAGE and nothing to project — skip it, logged, never thrown.
      // "Snapshots are never deleted" stopped being an invariant the day the owner-sanctioned
      // beta scrap (scripts/scrapCourseAndRoundData.mjs, course-cards spec §9) deleted 1,080 of
      // them: each deletion emitted a REMOVE onto this stream, and treating those as poison
      // records blocked the shard for hours behind bisect+retry cycles (live incident,
      // 2026-07-15). INSERT/MODIFY records remain held to the full poison discipline below —
      // a missing/corrupt NEW_IMAGE on those still logs and rethrows.
      if (record.eventName === "REMOVE") {
        deps.logger.info("projector: skipping a REMOVE stream record (snapshot deletion — an operational scrap, nothing to project)", {
          eventId: record.eventID,
        });
        continue;
      }
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

// TABLE_PROJECTIONS + TABLE_CORE are the envs this entry needs (swngStack.ts) — TABLE_CORE
// because accounts-only identity (spec §7) has the projector read each participant's golfer row
// (the golfer store lives on the core table) to decide who is account-bound before projecting.
// Unlike buildApp, nothing here is shared with another entry, so there's no "optional var" story.
export const buildProjector = (env: NodeJS.ProcessEnv): ProjectorApp => {
  const tableProjections = requireEnv(env, "TABLE_PROJECTIONS");
  const tableCore = requireEnv(env, "TABLE_CORE");

  const logger = createConsoleLogger();
  const documentClient = createDocumentClient();
  const projectionStore = createDynamoProjectionStore({ client: documentClient, tableName: tableProjections });
  const golferStore = createDynamoGolferStore({ client: documentClient, tableName: tableCore });
  // No clock (pre-prod hardening D4a): the projector no longer computes or writes a handicap
  // index at all — it's a pure per-round line upsert, with nothing left needing a wall-clock read.
  const project = projectArchive({ projectionStore, golferStore, logger });

  return { handler: createProjectorHandler({ parseArchive: parseSnapshotStreamImage, project, logger }) };
};

// --- Rebuild (M7 Task 4; rewritten as a paged backfill in projection-realignment Task 5):
// manual-invoke only, replays every snapshot through the SAME projectArchive the stream trigger
// uses (rebuildProjections' own doc comment: "no forked math") ---------------------------------

// The handler's event/response IS the use case's input/output, verbatim (Task 5 brief) — an
// operator (or a future step-function/retry wrapper) invokes this with `{ cursor, maxSnapshots }`
// to resume a prior capped run, and reads `{ processed, cursor }` back to decide whether to
// invoke again. No shape translation happens in this composition layer.
export interface RebuildApp {
  readonly handler: (input?: { readonly cursor?: string; readonly maxSnapshots?: number }) => Promise<{ processed: number; cursor?: string }>;
}

// TABLE_SNAPSHOTS + TABLE_PROJECTIONS + TABLE_CORE (swngStack.ts's RebuildFunction env) — the
// paged backfill reads snapshots directly via SnapshotStore.page(), never the rounds table, and
// TABLE_CORE because it replays through the SAME projectArchive the stream trigger uses, which
// now reads each participant's golfer row (accounts-only identity spec §7) to skip non-account
// golfers.
export const buildRebuild = (env: NodeJS.ProcessEnv): RebuildApp => {
  const tableSnapshots = requireEnv(env, "TABLE_SNAPSHOTS");
  const tableProjections = requireEnv(env, "TABLE_PROJECTIONS");
  const tableCore = requireEnv(env, "TABLE_CORE");

  const logger = createConsoleLogger();
  const documentClient = createDocumentClient();
  const projectionStore = createDynamoProjectionStore({ client: documentClient, tableName: tableProjections });
  const snapshots = createDynamoSnapshotStore({ client: documentClient, tableName: tableSnapshots });
  const golferStore = createDynamoGolferStore({ client: documentClient, tableName: tableCore });

  // No clock (pre-prod hardening D4a): the replay goes through the SAME projectArchive the
  // stream trigger uses, which no longer computes or writes a handicap index at all.
  return { handler: rebuildProjections({ snapshots, projectionStore, golferStore, logger }) };
};
