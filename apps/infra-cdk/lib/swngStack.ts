import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AttributeType, BillingMode, Operation, ProjectionType, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { CfnStage, CorsHttpMethod, HttpApi, HttpMethod, WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnUserPoolClient, OAuthScope, UserPool, UserPoolClient, UserPoolDomain } from "aws-cdk-lib/aws-cognito";
import { Distribution, ResponseHeadersPolicy, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

// The live POC stacks (deployed pre-rebuild, still holding production-shaped data) are
// named InfraCdkStack-beta / InfraCdkStack-prod — see CLAUDE.md. Constructing a SwngStack
// under either name (or any InfraCdkStack* name) would let a routine `cdk deploy` silently
// replace or delete those resources instead of standing up the new swng-<stage> stack. This
// throws BEFORE `super()` runs, so it fails at construct time, not at deploy time.
const FORBIDDEN_ID = /^InfraCdkStack/;

export interface SwngStackProps extends StackProps {
  // Stage suffix for every resource name in this stack (table names, secret name, the
  // WebSocket stage). Defaults to "beta" — swng has no "prod" stack yet (M3 scope is beta
  // only; CLAUDE.md).
  readonly stage?: string;
}

// The dispatcher (packages/lambda/src/http/dispatch.ts) does its own method+path matching
// against event.rawPath, so API Gateway just needs to forward each of these to the `http`
// function — but the (34, as of architecture-realignment Task 13) routes are declared here
// explicitly (matching packages/lambda/src/http/routes.ts) rather than via a single $default
// catch-all, so the API's shape is visible in the CloudFormation template and the AWS
// console, not hidden inside the Lambda. Exported (not module-private) so
// test/routesParity.test.ts can pin this table against buildRoutes' own {method, path} set —
// infra depends on lambda, the correct direction, so that guard lives here rather than in
// packages/lambda.
export const HTTP_ROUTES: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }> = [
  { method: HttpMethod.POST, path: "/rounds" },
  { method: HttpMethod.POST, path: "/rounds/join" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/games" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/scores" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/finalize" },
  { method: HttpMethod.GET, path: "/rounds/{roundId}/events" },
  // M9 Task 3 (share): mints this round's immortal spectator link — participant-gated, same
  // tier as finalize/terminate above.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/share" },
  // Projection-realignment Task 6: the settled snapshot's own event log — "golfer"-gated
  // (routes.ts's own doc comment on why this differs from GET /rounds/{roundId}/events'
  // round-scoped "round-read" tier just above).
  { method: HttpMethod.GET, path: "/rounds/{roundId}/archive" },
  // M6 Task 4: peek + the course CRUD/search surface.
  { method: HttpMethod.GET, path: "/rounds/peek" },
  { method: HttpMethod.POST, path: "/courses" },
  { method: HttpMethod.POST, path: "/courses/{courseId}/tees" },
  { method: HttpMethod.POST, path: "/courses/{courseId}/verify" },
  { method: HttpMethod.GET, path: "/courses/{courseId}" },
  { method: HttpMethod.GET, path: "/courses" },
  // M7 Task 5: game/round termination + the golfer identity surface.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/games/{gameId}/terminate" },
  { method: HttpMethod.GET, path: "/me" },
  { method: HttpMethod.PUT, path: "/me" },
  { method: HttpMethod.POST, path: "/golfers/claim" },
  { method: HttpMethod.GET, path: "/me/record" },
  // Projection-realignment Task 6: "list my rounds" — same golfer tier as GET /me/record.
  { method: HttpMethod.GET, path: "/me/rounds" },
  // Projection-realignment Task 13: "your rounds, right now" — presence, not finalized
  // history. Same golfer tier.
  { method: HttpMethod.GET, path: "/me/rounds/live" },
  // M8 Task 4: crews + rounds played as yourself. POST /rounds and POST /rounds/join above
  // are unchanged PATHS — only their auth tier moved (routes.ts's own "optional-golfer" —
  // API Gateway forwards every method/path here identically regardless of auth tier, so this
  // table needs no edit for that part of the change.
  { method: HttpMethod.POST, path: "/rounds/{roundId}/players" },
  { method: HttpMethod.POST, path: "/crews" },
  { method: HttpMethod.POST, path: "/crews/join" },
  { method: HttpMethod.GET, path: "/me/crews" },
  { method: HttpMethod.GET, path: "/crews/{crewId}" },
  { method: HttpMethod.POST, path: "/crews/{crewId}/members" },
  { method: HttpMethod.PUT, path: "/crews/{crewId}/standing-game" },
  // Architecture-realignment Task 9: crew seasons + counted rounds + standings-on-read + leave.
  // GET /crews/{crewId}/records is GONE (the crew projection layer it read from is deleted).
  { method: HttpMethod.POST, path: "/crews/{crewId}/seasons" },
  { method: HttpMethod.GET, path: "/crews/{crewId}/seasons" },
  { method: HttpMethod.POST, path: "/crews/{crewId}/seasons/{seasonId}/rounds" },
  { method: HttpMethod.DELETE, path: "/crews/{crewId}/seasons/{seasonId}/rounds/{roundId}" },
  { method: HttpMethod.GET, path: "/crews/{crewId}/seasons/{seasonId}/standings" },
  { method: HttpMethod.POST, path: "/crews/{crewId}/leave" },
];

// M9 Task 5 (ops): the eight routes anyone can call with NO token at all — routes.ts's own
// `auth` column names exactly why each one is here. POST /rounds and POST /rounds/join are
// "optional-golfer" (an absent Bearer still proceeds anonymously); GET /rounds/peek is "none"
// (no participant exists yet to hold a token before joining, M6 Task 4); the five course routes
// are the whole CRUD/search surface, deliberately unauthenticated in v1 (same M6 Task 4 call).
// Every OTHER route requires a real participant/golfer token first — minting one is already a
// much higher bar than a bare HTTP call — so only these eight get the tighter per-route ceiling
// below. Cross-checked against HTTP_ROUTES itself in swngStack.test.ts (every entry here must
// also be a real route) so a typo'd path here fails loudly instead of silently throttling
// nothing.
export const ANON_THROTTLED_ROUTES: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }> = [
  { method: HttpMethod.POST, path: "/rounds" },
  { method: HttpMethod.POST, path: "/rounds/join" },
  { method: HttpMethod.GET, path: "/rounds/peek" },
  { method: HttpMethod.POST, path: "/courses" },
  { method: HttpMethod.POST, path: "/courses/{courseId}/tees" },
  { method: HttpMethod.POST, path: "/courses/{courseId}/verify" },
  { method: HttpMethod.GET, path: "/courses/{courseId}" },
  { method: HttpMethod.GET, path: "/courses" },
];

// packages/lambda/src/entries/*.ts — resolved relative to this file so bundling works
// whether CDK is invoked from apps/infra-cdk or the repo root.
const entryPath = (name: string): string => join(import.meta.dirname, "..", "..", "..", "packages", "lambda", "src", "entries", `${name}.ts`);

export class SwngStack extends Stack {
  constructor(scope: Construct, id: string, props: SwngStackProps = {}) {
    if (FORBIDDEN_ID.test(id)) {
      throw new Error(
        `SwngStack: id "${id}" collides with the live POC stack namespace (InfraCdkStack-*). ` +
          "Deploying under that name would touch — or delete — the POC's live resources. Use \"swng-<stage>\" instead.",
      );
    }
    super(scope, id, props);

    const stage = props.stage ?? "beta";

    // --- Tables (M3 plan / docs/architecture.md §3 persistence sketch) ---------------

    const roundsTable = new Table(this, "RoundsTable", {
      tableName: `swng-rounds-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // The event log is the source of truth for a round in flight — never delete this table
      // out from under a stack teardown.
      removalPolicy: RemovalPolicy.RETAIN,
      // M7 Task 4 added this stream to feed the ProjectorFunction (filtered to ARCHIVE items).
      // Snapshot realignment Task 1 moves that event source to the snapshots table below (its
      // stream needs no filter — every item there IS a finished round) — nothing in this stack
      // consumes this stream any longer, but removing it is not this task's call: the ARCHIVE
      // item itself still lives here until a later task's transactional finalize stops writing
      // it (spec §9/§11), so a consumer could plausibly still read it meanwhile. Left as a
      // harmless no-op property, not a table replacement, either way.
      stream: StreamViewType.NEW_IMAGE,
    });
    roundsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "joinCode", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Snapshot realignment Task 1 (docs/superpowers/specs/2026-07-12-projection-realignment-
    // design.md §1/§2/§11): "the atom" — one immutable item per finalized round, pk-only (no
    // sk: a key is an identity, time is an attribute — the plan's own Global Constraints rule
    // out a sort key ever embedding a timestamp here). A later task makes the finalize
    // transaction (round-finalized append + this table's put, ONE TransactWriteItems) the
    // sole writer; nothing else ever puts here. RETAIN + PITR mirror the rounds table's own
    // durability posture above — a finalized round is exactly as irreplaceable as the event
    // log it was settled from. The stream feeds ProjectorFunction below with NO filter: every
    // item on this table already IS a finished round, unlike the rounds table's own stream
    // (which mixed in every EVT#/OPID#/META record too, hence that one's now-unused ARCHIVE
    // filter — deleted outright below, not narrowed, per spec §2 "no filter, no branching").
    const snapshotsTable = new Table(this, "SnapshotsTable", {
      tableName: `swng-snapshots-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      stream: StreamViewType.NEW_IMAGE,
    });

    // The core table now backs courses (M6 Task 3: createDynamoCourseStore) — pk `COURSE#<id>`
    // / sk `COURSE`, one document per course, no separate event log (CourseStore's port
    // comment). gsi1 is the course-name search index: a single partition across every course
    // (gsi1pk fixed to one constant — adapters-dynamodb/src/keys.ts's courseGsi1pk — a
    // deliberate v1 choice; thousands of courses sit trivially inside one partition's limits,
    // and re-sharding is real future work only if beta telemetry ever shows it running hot),
    // sorted by the normalized name (gsi1sk) so search is one begins_with Query. Projected to
    // `name` only — courseId parses back out of the always-projected base-table `pk`, so the
    // full course document and its revision counter never leave the base table over the GSI.
    const coreTable = new Table(this, "CoreTable", {
      tableName: `swng-core-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    coreTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["name"],
    });
    // M7 Task 3/4: the sub→golfer lookup GolferStore.getBySub queries (createDynamoGolferStore
    // already queries this locally; this is the real CDK construct). gsi2pk/gsi2sk are set on
    // a golfer item only once claimed (keys.ts's golferGsi2pk/golferGsi2sk doc comment) —
    // ProjectionType.ALL because golfer items are small, unlike gsi1's course documents, so
    // there's no reason to pay INCLUDE's bookkeeping cost here.
    coreTable.addGlobalSecondaryIndex({
      indexName: "gsi2",
      partitionKey: { name: "gsi2pk", type: AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Projections (docs/architecture.md §6) — one history line per finalized round a golfer
    // played plus a running index snapshot (adapters-dynamodb/src/keys.ts). Provisioned since
    // M6; M7 Task 4 is the first task to actually grant access to it (below) and wire the
    // stream that feeds it (ProjectorFunction).
    const projectionsTable = new Table(this, "ProjectionsTable", {
      tableName: `swng-projections-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      // Snapshot realignment Task 1 / spec §5: presence rows (a golfer's currently-live rounds,
      // written in a later task) are self-expiring — TTL is provisioned now, forward of that
      // task, same idiom M7 Task 4 used granting httpFn TABLE_PROJECTIONS access before any
      // route read it. Golfer-record items (history lines, the index) never set `ttl`, so DynamoDB's
      // background sweep never touches them — TTL only deletes items that carry the attribute.
      timeToLiveAttribute: "ttl",
    });

    const connectionsTable = new Table(this, "ConnectionsTable", {
      tableName: `swng-connections-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // Pure WS fan-out state, rebuildable from nothing (clients just reconnect) — safe to
      // destroy on stack teardown, unlike the three tables above.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "roundId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // --- Identity (M7 Task 4; docs/architecture.md §3: "Cognito stays a dumb credential box
    // behind the IdentityProvider port") -------------------------------------------------

    const userPool = new UserPool(this, "UserPool", {
      userPoolName: `swng-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      // Self-sign-up with no phone/SMS setup in v1 — email is the only channel that can
      // actually prove account ownership here.
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Holds real users the moment beta has its first signed-in golfer — never destroy this
      // out from under a stack teardown (mirrors the rounds/core/projections tables above).
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The web app's origins, for both OAuth callback and logout redirects — a cdk context
    // list (`-c WEB_ORIGINS='["https://..."]'` or cdk.json) so a real deployed web app URL can
    // be added without a code change; defaults to just the local dev server so `cdk synth`
    // and this stack's own tests never depend on that context being set.
    const webOrigins = (this.node.tryGetContext("WEB_ORIGINS") as string[] | undefined) ?? ["http://localhost:5173"];

    const userPoolClient = new UserPoolClient(this, "UserPoolClient", {
      userPool,
      userPoolClientName: `swng-web-${stage}`,
      // SPA: the client runs entirely in the browser, so it can never keep a secret.
      generateSecret: false,
      authFlows: {
        // The real web app only ever uses the authorization-code+PKCE flow below —
        // USER_PASSWORD_AUTH exists solely so `pnpm e2e:beta` can mint a real ID token via
        // InitiateAuth without driving a browser through the hosted UI. M9 hardening item:
        // narrow or remove this once the e2e gate has another way to authenticate.
        userPassword: true,
      },
      oAuth: {
        // PKCE is implicit for a public client (no secret) using the authorization-code grant
        // — there's no separate CDK flag for it.
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        // Cognito requires an EXACT match against a registered callback URL — the web app
        // (apps/web/src/auth/authConfig.ts's redirectUri) always sends
        // `${origin}/auth/callback`, never the bare origin, so the bare origins alone here
        // would make every real Hosted-UI sign-in fail with redirect_mismatch.
        callbackUrls: webOrigins.map((origin) => `${origin}/auth/callback`),
        // Papercut 6 (M9 hardening): the app's signOut (apps/web/src/auth/useAuth.ts) now
        // redirects through Cognito's /logout endpoint to actually end the Hosted UI's own
        // session (clearing local tokens alone left it alive, so the next signIn() silently
        // resumed the same account) — `logout_uri` must EXACTLY match a registered value here,
        // same "Cognito requires an exact match" rule as callbackUrls above. authConfig.ts's
        // buildLogoutUrl always sends `${origin}/` (trailing slash, no path), not the bare
        // origin callbackUrls' own `/auth/callback` needs.
        logoutUrls: webOrigins.map((origin) => `${origin}/`),
      },
    });

    const userPoolDomain = new UserPoolDomain(this, "UserPoolDomain", {
      userPool,
      cognitoDomain: { domainPrefix: `swng-${stage}-${this.account}` },
    });

    // --- Participant-token signing secret ---------------------------------------------

    // Beta-grade: a CDK-generated secret whose plaintext is read at synth time via
    // `secretValue.unsafeUnwrap()` and baked directly into the Lambdas' environment. That
    // trades secret rotation (a redeploy is required to change it) for zero runtime
    // Secrets Manager calls / IAM plumbing — acceptable for a beta stack with no real
    // participant data at stake. M9 hardens this into a runtime lookup (SDK call or Lambda
    // extension) so the plaintext never lands in a CloudFormation template or Lambda
    // console view.
    const tokenSecret = new Secret(this, "TokenSecret", {
      secretName: `swng-token-secret-${stage}`,
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });

    // --- Lambda functions (packages/lambda/src/entries/*.ts) ---------------------------
    //
    // WS_ENDPOINT is a genuine circular dependency: every entry's composition root
    // (compositionRoot.ts) requires it unconditionally, but its value (the WebSocketStage's
    // callback URL) doesn't exist until the WebSocketApi/Stage below are constructed — and
    // that construction needs wsConnectFn/wsDisconnectFn as integration targets. Broken by
    // constructing the functions first without WS_ENDPOINT, then back-filling it with
    // `addEnvironment` once the stage exists (below).

    const sharedEnv = {
      TABLE_ROUNDS: roundsTable.tableName,
      TABLE_CONNECTIONS: connectionsTable.tableName,
      TOKEN_SECRET: tokenSecret.secretValue.unsafeUnwrap(),
    };

    const makeFunction = (name: string, entryName: string): NodejsFunction =>
      new NodejsFunction(this, name, {
        entry: entryPath(entryName),
        handler: "handler",
        runtime: Runtime.NODEJS_20_X,
        environment: sharedEnv,
        // Explicit, not CDK's 3s default: createDynamoEventJournal's append path can need
        // several sequential Query+TransactWrite round trips under a hot write burst (its own
        // full-jitter backoff can itself sleep close to 1s per collision), and the 3s default
        // was independently truncating in-flight retries before MAX_APPEND_ATTEMPTS would have
        // (task-6-report.md). 512MB matches the workload (JSON in/out, no heavy compute) while
        // giving a bit more CPU share than the 128MB default for esbuild-bundled cold starts.
        timeout: Duration.seconds(15),
        memorySize: 512,
      });

    const httpFn = makeFunction("HttpFunction", "http");
    const wsConnectFn = makeFunction("WsConnectFunction", "wsConnect");
    const wsDisconnectFn = makeFunction("WsDisconnectFunction", "wsDisconnect");

    // TABLE_CORE only goes to httpFn: the course routes (M6) are HTTP-only — wsConnect/
    // wsDisconnect never touch the core table, unlike TABLE_ROUNDS/TABLE_CONNECTIONS above
    // which every function needs (round broadcast / connection bookkeeping respectively).
    httpFn.addEnvironment("TABLE_CORE", coreTable.tableName);
    // M7 Task 4: TABLE_PROJECTIONS + the Cognito identifiers httpFn's "golfer" auth tier
    // (lambda/http/dispatch.ts) needs to build a real CognitoVerifier — wsConnect/
    // wsDisconnect never dispatch a golfer-tier route, same reasoning as TABLE_CORE above.
    // No golfer/record route reads projections yet (that lands in a later task), but the
    // grant + env land now so that task is route-wiring only, not another CDK change.
    httpFn.addEnvironment("TABLE_PROJECTIONS", projectionsTable.tableName);
    httpFn.addEnvironment("USER_POOL_ID", userPool.userPoolId);
    httpFn.addEnvironment("USER_POOL_CLIENT_ID", userPoolClient.userPoolClientId);
    // Snapshot realignment Task 1: forward-provisioned ahead of the transactional finalize (a
    // later task) that makes httpFn the snapshots table's sole writer — same "grant + env land
    // now so that task is route-wiring only" idiom as TABLE_PROJECTIONS above.
    httpFn.addEnvironment("TABLE_SNAPSHOTS", snapshotsTable.tableName);

    // ProjectorFunction (the snapshots table's stream, unfiltered — snapshot realignment Task
    // 1) and RebuildFunction (manual invoke only — no event source) are their own minimal
    // NodejsFunctions, not built via makeFunction above: neither needs TABLE_CONNECTIONS,
    // TOKEN_SECRET, or WS_ENDPOINT (they never broadcast or touch a participant token), so
    // giving them `sharedEnv` would leak table names/secrets into a Lambda console that has
    // no reason to see them.
    const projectorFn = new NodejsFunction(this, "ProjectorFunction", {
      entry: entryPath("projector"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      // TABLE_SNAPSHOTS is deliberately absent: the projector reads nothing by table name — a
      // later task's parseSnapshotStreamImage unmarshalls the archive straight out of the
      // stream record the event source below hands it.
      environment: { TABLE_PROJECTIONS: projectionsTable.tableName },
      timeout: Duration.seconds(15),
      memorySize: 512,
    });
    const rebuildFn = new NodejsFunction(this, "RebuildFunction", {
      entry: entryPath("rebuild"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      // Snapshot realignment Task 1: TABLE_ROUNDS is gone — the rebuild never touches the
      // rounds table again (a later task backfills by paging the snapshots table instead of
      // Scanning the rounds table for ARCHIVE items).
      environment: { TABLE_PROJECTIONS: projectionsTable.tableName, TABLE_SNAPSHOTS: snapshotsTable.tableName },
      // Longer than the other functions' fixed 15s budget on purpose: this replays every
      // snapshot in one invocation, not a single request — an operator-triggered job, not a
      // hot path.
      timeout: Duration.minutes(5),
      memorySize: 512,
    });

    // Snapshot realignment Task 1 / spec §2 ("no filter, no branching"): sourced from the
    // snapshots table's own stream now, not the rounds table's — every item there already IS a
    // finished round, so the ARCHIVE-only FilterCriteria this used to carry is deleted outright,
    // not narrowed.
    projectorFn.addEventSource(
      new DynamoEventSource(snapshotsTable, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 10,
      }),
    );

    // --- WebSocket API ($connect / $disconnect only — no $default route: every WS message
    // this system sends is server -> client broadcast, never client -> server) -----------

    const webSocketApi = new WebSocketApi(this, "WebSocketApi", {
      apiName: `swng-ws-${stage}`,
      connectRouteOptions: { integration: new WebSocketLambdaIntegration("WsConnectIntegration", wsConnectFn) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration("WsDisconnectIntegration", wsDisconnectFn) },
    });
    const webSocketStage = new WebSocketStage(this, "WebSocketStage", {
      webSocketApi,
      stageName: stage,
      autoDeploy: true,
    });

    // Now that the stage (and its callback URL) exists, complete every function's env.
    for (const fn of [httpFn, wsConnectFn, wsDisconnectFn]) {
      fn.addEnvironment("WS_ENDPOINT", webSocketStage.callbackUrl);
    }

    // --- HTTP API ------------------------------------------------------------------------

    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: `swng-http-${stage}`,
      corsPreflight: {
        allowOrigins: ["*"],
        // Every method HTTP_ROUTES uses must be allowed here too — a route whose method is
        // missing still answers curl, but a browser's preflight gets a 204 with NO
        // access-control-allow-* headers and the actual request is blocked (verified live
        // against beta, M7 Task 5). PUT joined for PUT /me; the stack test pins this list as
        // a superset of HTTP_ROUTES' own method set so the next new method can't ship
        // browser-dead.
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.DELETE],
        allowHeaders: ["content-type", "authorization"],
      },
    });
    const httpIntegration = new HttpLambdaIntegration("HttpIntegration", httpFn);
    for (const route of HTTP_ROUTES) {
      httpApi.addRoutes({ path: route.path, methods: [route.method], integration: httpIntegration });
    }

    // --- Throttling (M9 Task 5) -----------------------------------------------------------
    //
    // Abuse ceilings, not capacity planning: a real Saturday crew's whole round generates on
    // the order of 1 request/sec (a handful of golfers tapping scores between shots). 50 rps /
    // 100 burst on the stage default leaves a hundredfold headroom above that while still
    // bounding a runaway client or a scripted flood. The 8 anonymous-reachable routes
    // (ANON_THROTTLED_ROUTES above) get a tighter ceiling — no participant/golfer token to make
    // minting expensive first — at a tenth of the stage default: still ~5x a Saturday crew's own
    // rate, but nowhere near enough headroom for a script to mint thousands of rounds/courses a
    // minute.
    const STAGE_THROTTLE_RATE_LIMIT = 50;
    const STAGE_THROTTLE_BURST_LIMIT = 100;
    const ANON_ROUTE_THROTTLE_RATE_LIMIT = 5;
    const ANON_ROUTE_THROTTLE_BURST_LIMIT = 10;

    // apigatewayv2's L2 HttpApi/HttpStage constructs expose NO throttle knob anywhere on the
    // auto-created default stage — HttpApiProps carries no `throttle` field at all (only
    // `addStage`'s own HttpStageOptions does, and that's for a NEW stage this code doesn't
    // create; replacing the existing default stage with one built via addStage would change its
    // logical id, and therefore its physical resource — exactly what the deploy policy forbids).
    // The default stage's underlying CfnStage resource DOES support both `defaultRouteSettings`
    // (whole-stage default) and `routeSettings` (a "METHOD /path" -> {rate, burst} map — the
    // documented per-route mechanism, AWS::ApiGatewayV2::Stage's own RouteSettings property) —
    // so this reaches through the L2's own defaultChild (the L1 escape hatch) rather than
    // replacing the stage construct, keeping its logical id — and the already-deployed stage's
    // physical id — untouched.
    if (!httpApi.defaultStage) {
      throw new Error("HttpApi has no defaultStage — createDefaultStage must stay true for the throttle escape hatch below to apply");
    }
    const defaultStageResource = httpApi.defaultStage.node.defaultChild as CfnStage;
    // `defaultRouteSettings` is a strongly-typed `CfnStage.RouteSettingsProperty` — its own
    // camelCase properties (`throttlingRateLimit`/`throttlingBurstLimit`) go through a real
    // property mapper that PascalCases them into the template.
    defaultStageResource.defaultRouteSettings = {
      throttlingRateLimit: STAGE_THROTTLE_RATE_LIMIT,
      throttlingBurstLimit: STAGE_THROTTLE_BURST_LIMIT,
    };
    // `routeSettings`, by contrast, is typed `any` (CDK's own generated escape hatch for this
    // property — verified against aws-cdk-lib's generated mapper: RouteSettings goes through
    // `objectToCloudFormation`, which is a bare identity function, not a property mapper) — so
    // unlike defaultRouteSettings above, nothing here PascalCases nested keys automatically.
    // The exact CloudFormation property names (ThrottlingRateLimit/ThrottlingBurstLimit) must be
    // supplied directly, and the outer keys must be real route keys ("METHOD /path", matching
    // AWS::ApiGatewayV2::Route's own RouteKey format used elsewhere in this file).
    defaultStageResource.routeSettings = Object.fromEntries(
      ANON_THROTTLED_ROUTES.map((route) => [
        `${route.method} ${route.path}`,
        { ThrottlingRateLimit: ANON_ROUTE_THROTTLE_RATE_LIMIT, ThrottlingBurstLimit: ANON_ROUTE_THROTTLE_BURST_LIMIT },
      ]),
    );

    // --- Grants ---------------------------------------------------------------------------

    roundsTable.grantReadWriteData(httpFn);
    coreTable.grantReadWriteData(httpFn);
    connectionsTable.grantReadWriteData(httpFn);
    connectionsTable.grantReadWriteData(wsConnectFn);
    connectionsTable.grantReadWriteData(wsDisconnectFn);
    // Snapshot realignment Task 1: the finalize transaction (a later task) writes the snapshot
    // through httpFn — read+write, mirroring roundsTable's own grant above (httpFn also reads
    // a snapshot back for the archived-round view, another later task).
    snapshotsTable.grantReadWriteData(httpFn);
    // Only `http` broadcasts (adapters-apigateway's createApiGatewayBroadcast, wired in
    // compositionRoot.ts) — wsConnect/wsDisconnect never call PostToConnection.
    webSocketApi.grantManageConnections(httpFn);

    // M7 Task 4: the projections table's readers/writers. projectorFn's stream READ access
    // (GetRecords/DescribeStream/etc. on the snapshots table's stream, snapshot realignment
    // Task 1) is granted automatically by addEventSource above (DynamoEventSource.bind calls
    // table.grantStreamRead) — it needs no separate grant call here.
    projectionsTable.grantReadWriteData(projectorFn);
    projectionsTable.grantReadWriteData(rebuildFn);
    projectionsTable.grantReadWriteData(httpFn);
    // Snapshot realignment Task 1: rebuild now reads the snapshots table instead of the rounds
    // table (the rebuild never touches the rounds table again — its own TABLE_ROUNDS grant and
    // env are gone, not just narrowed).
    snapshotsTable.grantReadData(rebuildFn);

    // --- Alarms -> one SNS topic (M9 Task 5) -----------------------------------------------
    //
    // One topic, one email subscription — every alarm below fires into the SAME topic so the
    // owner gets one inbox to watch, not five. The email subscription itself needs a
    // confirmation click (SNS's own protocol) — that's a real human action after deploy, not
    // something this stack (or a deploy script) can complete on the owner's behalf.
    const alarmsTopic = new Topic(this, "AlarmsTopic", { topicName: `swng-alarms-${stage}` });
    alarmsTopic.addSubscription(new EmailSubscription("interrante.blaine@gmail.com"));

    // Every alarm constructed below is routed through this — wiring the SAME action everywhere
    // is what "all alarms -> one topic" means structurally, not just "they happen to share a
    // topic reference."
    const paged = (alarm: Alarm): Alarm => {
      alarm.addAlarmAction(new SnsAction(alarmsTopic));
      return alarm;
    };

    const FIVE_MINUTES = Duration.minutes(5);

    // Per-function Errors >= 1 over 5 minutes, for every one of the 5 functions — the first
    // signal of "something threw," before a human would otherwise notice via a support message
    // or a stalled projection.
    const alarmedFunctions: ReadonlyArray<readonly [string, NodejsFunction]> = [
      ["Http", httpFn],
      ["WsConnect", wsConnectFn],
      ["WsDisconnect", wsDisconnectFn],
      ["Projector", projectorFn],
      ["Rebuild", rebuildFn],
    ];
    for (const [name, fn] of alarmedFunctions) {
      paged(
        new Alarm(this, `${name}ErrorsAlarm`, {
          alarmDescription: `${name}Function: at least 1 error in 5 minutes`,
          metric: fn.metricErrors({ period: FIVE_MINUTES, statistic: "Sum" }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
      );
    }

    // HTTP API 5xx >= 5 over 5 minutes — httpApi.metricServerError() aggregates the documented
    // AWS/ApiGateway "5xx" metric (dimensioned by ApiId only, no Stage dimension) across every
    // stage of this API; there is exactly one (the default stage above), so this is unambiguous.
    paged(
      new Alarm(this, "HttpApi5xxAlarm", {
        alarmDescription: "HTTP API: at least 5 5xx responses in 5 minutes",
        metric: httpApi.metricServerError({ period: FIVE_MINUTES, statistic: "Sum" }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // Projector stream IteratorAge > 5 minutes — the projections table (golfer index/history)
    // is falling behind the snapshots table's own stream. aws-lambda's Function/NodejsFunction
    // class exposes metricErrors/metricDuration/metricThrottles but NO metricIteratorAge helper
    // (verified against function-base.d.ts) — this is the documented AWS/Lambda namespace
    // metric, dimensioned by FunctionName alone (unambiguous here: projectorFn has exactly one
    // stream event source, wired above).
    paged(
      new Alarm(this, "ProjectorIteratorAgeAlarm", {
        alarmDescription: "ProjectorFunction: stream IteratorAge over 5 minutes — the projector is falling behind the snapshots table's stream",
        metric: new Metric({
          namespace: "AWS/Lambda",
          metricName: "IteratorAge",
          dimensionsMap: { FunctionName: projectorFn.functionName },
          period: FIVE_MINUTES,
          statistic: "Maximum",
        }),
        threshold: FIVE_MINUTES.toMilliseconds(),
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // Rebuild Duration > 4 minutes — the 5-minute-timeout tripwire (rebuildFn's own CDK timeout,
    // set above): a full-table replay of every finalized round's projections that's still
    // running at 4 minutes is heading for a hard cutoff at 5, so the owner gets a page with a
    // minute of runway left to investigate rather than only learning about it from the timeout
    // itself (or a silently incomplete rebuild).
    paged(
      new Alarm(this, "RebuildDurationAlarm", {
        alarmDescription: "RebuildFunction: an invocation ran over 4 minutes — approaching its own 5-minute hard timeout",
        metric: rebuildFn.metricDuration({ period: FIVE_MINUTES, statistic: "Maximum" }),
        threshold: Duration.minutes(4).toMilliseconds(),
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // DynamoDB throttled-requests >= 1 over 5 minutes, on all 4 tables — PAY_PER_REQUEST tables
    // throttle far more rarely than provisioned ones, but a hot partition (e.g. one very active
    // round or a course-search spike on the shared gsi1 partition, core table's own doc comment
    // above) can still throttle; this is the earliest signal a golfer's own tap silently failed
    // to persist. metricThrottledRequestsForOperations builds ONE math expression summing a
    // per-operation metric each — CloudWatch caps a math-expression alarm at 10 individual
    // metrics, and the default `operations` (every Operation the enum knows, 14) blows past
    // that (confirmed against a real `cdk synth`: "Alarms on math expressions cannot contain
    // more than 10 individual metrics"). `THROTTLEABLE_OPERATIONS` below is the real, narrower
    // set adapters-dynamodb actually issues (grepped across packages/adapters-dynamodb/src's own
    // *Command construction — CreateTable/ListTables are admin/test-only, never a live runtime
    // path, so they're deliberately excluded), 8 operations, safely under the cap, shared
    // identically across all four tables below (a table that never issues one of these ops
    // simply reports 0 for that leg of the sum — harmless, and one shared list is simpler than
    // four hand-curated ones).
    const THROTTLEABLE_OPERATIONS: Operation[] = [
      Operation.GET_ITEM,
      Operation.PUT_ITEM,
      Operation.UPDATE_ITEM,
      Operation.DELETE_ITEM,
      Operation.QUERY,
      Operation.SCAN,
      Operation.BATCH_GET_ITEM,
      Operation.TRANSACT_WRITE_ITEMS,
    ];
    const alarmedTables: ReadonlyArray<readonly [string, Table]> = [
      ["Rounds", roundsTable],
      ["Core", coreTable],
      ["Snapshots", snapshotsTable],
      ["Projections", projectionsTable],
      ["Connections", connectionsTable],
    ];
    for (const [name, table] of alarmedTables) {
      paged(
        new Alarm(this, `${name}TableThrottledRequestsAlarm`, {
          alarmDescription: `${name}Table: at least 1 throttled request in 5 minutes`,
          metric: table.metricThrottledRequestsForOperations({ period: FIVE_MINUTES, operations: THROTTLEABLE_OPERATIONS }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
      );
    }

    // --- Hosted web (M9 Task 6): S3 + CloudFront, so the app is reachable from a phone -----
    //
    // The bucket holds only re-publishable Vite build output (apps/web/dist, synced by
    // scripts/publishWeb.mjs on every `pnpm publish:web:beta`) — never irreplaceable data,
    // unlike the tables/pool above which stay RETAIN. DESTROY + autoDeleteObjects is the
    // right removal policy here: the bucket is never empty in practice (a fresh sync always
    // repopulates it immediately), so RETAIN or bare DESTROY would either leak the bucket
    // forever or make `cdk destroy` fail outright on a non-empty bucket — autoDeleteObjects
    // is what actually makes "destroy this stack" work.
    const webBucket = new Bucket(this, "WebBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // The ONLY reader is CloudFront via Origin Access Control below — no public access, no
      // website-hosting endpoint.
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // The CSP's connect-src origins, read from this stack's own live constructs — never
    // hardcoded, so a redeploy that changes any of these (a new HTTP API domain, e.g.) can't
    // silently leave the CSP pointing at a stale origin. httpApi.apiEndpoint and
    // userPoolDomain.baseUrl() already carry `https://`; webSocketStage.url already carries
    // `wss://` (confirmed against the existing WsApiUrl output above / cdk-outputs.json) — none
    // need a scheme prefixed here.
    const contentSecurityPolicy = [
      "default-src 'self'",
      `connect-src 'self' ${httpApi.apiEndpoint} ${webSocketStage.url} ${userPoolDomain.baseUrl()}`,
      // No third-party script origin exists anywhere in this app (the load-bearing fact behind
      // M9's localStorage-token re-acceptance) — 'self' only, no CDN/analytics allowance.
      "script-src 'self'",
      // Tailwind emits inline <style> at runtime — style-src needs 'unsafe-inline' or the app
      // renders unstyled.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
    ].join("; ");

    const webResponseHeadersPolicy = new ResponseHeadersPolicy(this, "WebResponseHeadersPolicy", {
      responseHeadersPolicyName: `swng-web-csp-${stage}`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy, override: true },
      },
    });

    const distribution = new Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        // S3BucketOrigin.withOriginAccessControl creates a real Origin Access Control (the
        // modern replacement for the legacy Origin Access Identity) AND wires the bucket
        // policy that grants ONLY this distribution's OAC read access — no separate policy
        // wiring needed here.
        origin: S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: webResponseHeadersPolicy,
      },
      // SPA fallback: a client-side route with no matching S3 key (`/watch/:roundId`,
      // `/round/:id`, `/profile`, ...) surfaces from a private OAC-fronted bucket as 403 (S3's
      // "missing key" response through OAC is Access Denied, not 404) — so BOTH 403 and 404 map
      // to index.html with a 200, letting react-router's client-side routing take over instead
      // of the browser rendering a raw CloudFront error page.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // The distribution's domain is only known here — it's built from httpApi/webSocketStage
    // (constructed earlier, above), so it can't be folded into userPoolClient's ORIGINAL
    // callbackUrls/logoutUrls at construction time without a real circular dependency. Reached
    // through the L1 escape hatch instead (same idiom as the throttling section's CfnStage
    // reach-through above) to APPEND the CloudFront origin onto the SAME UserPoolClient
    // construct — unchanged logical id, an in-place property update (CallbackURLs/LogoutURLs
    // are mutable, non-replacing AWS::Cognito::UserPoolClient properties — the same fact M9
    // Task 2's own logoutUrls change already relied on), never a reconstruction. The existing
    // localhost entries stay untouched so dev keeps working.
    const cfnUserPoolClient = userPoolClient.node.defaultChild as CfnUserPoolClient;
    cfnUserPoolClient.callbackUrLs = [
      ...webOrigins.map((origin) => `${origin}/auth/callback`),
      `https://${distribution.distributionDomainName}/auth/callback`,
    ];
    cfnUserPoolClient.logoutUrLs = [...webOrigins.map((origin) => `${origin}/`), `https://${distribution.distributionDomainName}/`];

    // --- Outputs ----------------------------------------------------------------------

    new CfnOutput(this, "HttpApiUrl", { value: `${httpApi.apiEndpoint}/` });
    new CfnOutput(this, "WsApiUrl", { value: webSocketStage.url });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: userPoolDomain.baseUrl() });
    // scripts/publishWeb.mjs reads these two to sync apps/web/dist and invalidate the cache.
    new CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "WebUrl", { value: `https://${distribution.distributionDomainName}/` });
  }
}
