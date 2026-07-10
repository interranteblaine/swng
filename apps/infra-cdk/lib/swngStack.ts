import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { CorsHttpMethod, HttpApi, HttpMethod, WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { OAuthScope, UserPool, UserPoolClient, UserPoolDomain } from "aws-cdk-lib/aws-cognito";
import { FilterCriteria, FilterRule, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
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
// function — but the twelve routes are declared here explicitly (matching
// packages/lambda/src/http/routes.ts) rather than via a single $default catch-all, so the
// API's shape is visible in the CloudFormation template and the AWS console, not hidden
// inside the Lambda. Exported (not module-private) so test/routesParity.test.ts can pin
// this table against buildRoutes' own {method, path} set — infra depends on lambda, the
// correct direction, so that guard lives here rather than in packages/lambda.
export const HTTP_ROUTES: ReadonlyArray<{ readonly method: HttpMethod; readonly path: string }> = [
  { method: HttpMethod.POST, path: "/rounds" },
  { method: HttpMethod.POST, path: "/rounds/join" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/games" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/scores" },
  { method: HttpMethod.POST, path: "/rounds/{roundId}/finalize" },
  { method: HttpMethod.GET, path: "/rounds/{roundId}/events" },
  // M6 Task 4: peek + the course CRUD/search surface.
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

// Mirrors adapters-dynamodb/src/keys.ts's `archiveSk` constant by hand (M7 Task 4) —
// infra-cdk has no runtime dependency on that package (unlike HTTP_ROUTES' comment above
// about routes.ts, which IS pinned at runtime by routesParity.test.ts). Every round's archive
// item is written with sk fixed to this exact literal (createDynamoRoundStore.ts's
// putArchive), so the ProjectorFunction's event-source filter criteria below, matching on
// `dynamodb.Keys.sk.S`, restricts it to ARCHIVE images only — never a stray EVT#/META/OPID#
// record from the same table's stream.
const ARCHIVE_SK = "ARCHIVE";

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
      // The event log + archive are the source of truth for a round — never delete this
      // table out from under a stack teardown.
      removalPolicy: RemovalPolicy.RETAIN,
      // M7 Task 4: NEW_IMAGE feeds the ProjectorFunction below (filtered to ARCHIVE items
      // only) — an in-place update (adding a stream never changes the table's logical id or
      // physical resource, unlike a GSI addition it doesn't even need CloudFormation to
      // replace anything for).
      stream: StreamViewType.NEW_IMAGE,
    });
    roundsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "joinCode", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
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
        callbackUrls: webOrigins,
        logoutUrls: webOrigins,
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

    // ProjectorFunction (the rounds table's stream, filtered to ARCHIVE items) and
    // RebuildFunction (manual invoke only — no event source) are their own minimal
    // NodejsFunctions, not built via makeFunction above: neither needs TABLE_CONNECTIONS,
    // TOKEN_SECRET, or WS_ENDPOINT (they never broadcast or touch a participant token), so
    // giving them `sharedEnv` would leak table names/secrets into a Lambda console that has
    // no reason to see them.
    const projectorFn = new NodejsFunction(this, "ProjectorFunction", {
      entry: entryPath("projector"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      environment: { TABLE_PROJECTIONS: projectionsTable.tableName },
      timeout: Duration.seconds(15),
      memorySize: 512,
    });
    const rebuildFn = new NodejsFunction(this, "RebuildFunction", {
      entry: entryPath("rebuild"),
      handler: "handler",
      runtime: Runtime.NODEJS_20_X,
      environment: { TABLE_PROJECTIONS: projectionsTable.tableName, TABLE_ROUNDS: roundsTable.tableName },
      // Longer than the other functions' fixed 15s budget on purpose: this replays every
      // archive in the rounds table in one invocation (a full Scan plus one projectArchive
      // call per archive), not a single request — an operator-triggered job, not a hot path.
      timeout: Duration.minutes(5),
      memorySize: 512,
    });

    projectorFn.addEventSource(
      new DynamoEventSource(roundsTable, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        filters: [FilterCriteria.filter({ dynamodb: { Keys: { sk: { S: FilterRule.isEqual(ARCHIVE_SK) } } } })],
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
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ["content-type", "authorization"],
      },
    });
    const httpIntegration = new HttpLambdaIntegration("HttpIntegration", httpFn);
    for (const route of HTTP_ROUTES) {
      httpApi.addRoutes({ path: route.path, methods: [route.method], integration: httpIntegration });
    }

    // --- Grants ---------------------------------------------------------------------------

    roundsTable.grantReadWriteData(httpFn);
    coreTable.grantReadWriteData(httpFn);
    connectionsTable.grantReadWriteData(httpFn);
    connectionsTable.grantReadWriteData(wsConnectFn);
    connectionsTable.grantReadWriteData(wsDisconnectFn);
    // Only `http` broadcasts (adapters-apigateway's createApiGatewayBroadcast, wired in
    // compositionRoot.ts) — wsConnect/wsDisconnect never call PostToConnection.
    webSocketApi.grantManageConnections(httpFn);

    // M7 Task 4: the projections table's readers/writers. projectorFn's stream READ access
    // (GetRecords/DescribeStream/etc. on the rounds table's stream) is granted automatically
    // by addEventSource above (DynamoEventSource.bind calls table.grantStreamRead) — it needs
    // no separate grant call here.
    projectionsTable.grantReadWriteData(projectorFn);
    projectionsTable.grantReadWriteData(rebuildFn);
    projectionsTable.grantReadWriteData(httpFn);
    // Read-only: rebuild only Scans for archives, never writes the rounds table.
    roundsTable.grantReadData(rebuildFn);

    // --- Outputs ----------------------------------------------------------------------

    new CfnOutput(this, "HttpApiUrl", { value: `${httpApi.apiEndpoint}/` });
    new CfnOutput(this, "WsApiUrl", { value: webSocketStage.url });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: userPoolDomain.baseUrl() });
  }
}
