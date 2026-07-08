import { join } from "node:path";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb";
import { CorsHttpMethod, HttpApi, HttpMethod, WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Runtime } from "aws-cdk-lib/aws-lambda";
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
// function — but the six routes are declared here explicitly (matching
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
      // The event log + archive are the source of truth for a round — never delete this
      // table out from under a stack teardown.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    roundsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "joinCode", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Neither of the next two tables is read/written by any M3 Lambda yet — core entities
    // and projections land in a later milestone (docs/architecture.md §6) — but the stack
    // shape is fixed by this task's brief, so they're provisioned now rather than added as
    // a migration later. No construct is assigned to a variable: nothing in this file grants
    // access to them yet, and a future milestone that adds a reader/writer will look them up
    // by construct id at that point.
    new Table(this, "CoreTable", {
      tableName: `swng-core-${stage}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new Table(this, "ProjectionsTable", {
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
      });

    const httpFn = makeFunction("HttpFunction", "http");
    const wsConnectFn = makeFunction("WsConnectFunction", "wsConnect");
    const wsDisconnectFn = makeFunction("WsDisconnectFunction", "wsDisconnect");

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
    connectionsTable.grantReadWriteData(httpFn);
    connectionsTable.grantReadWriteData(wsConnectFn);
    connectionsTable.grantReadWriteData(wsDisconnectFn);
    // Only `http` broadcasts (adapters-apigateway's createApiGatewayBroadcast, wired in
    // compositionRoot.ts) — wsConnect/wsDisconnect never call PostToConnection.
    webSocketApi.grantManageConnections(httpFn);

    // --- Outputs ----------------------------------------------------------------------

    new CfnOutput(this, "HttpApiUrl", { value: `${httpApi.apiEndpoint}/` });
    new CfnOutput(this, "WsApiUrl", { value: webSocketStage.url });
  }
}
