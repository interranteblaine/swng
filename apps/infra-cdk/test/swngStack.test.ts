import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { archiveSk } from "@swng/adapters-dynamodb";
import { ARCHIVE_SK, HTTP_ROUTES, SwngStack } from "../lib/swngStack.js";

// One stack, synthesized once, asserted against many times — synthesis (which bundles all
// three Lambdas with esbuild) is the expensive part of this suite; sharing it across `it`
// blocks keeps the run fast without weakening any single assertion.
const template = Template.fromStack(new SwngStack(new App(), "swng-beta", { stage: "beta" }));

const ENV_KEYS = ["TABLE_ROUNDS", "TABLE_CONNECTIONS", "TOKEN_SECRET", "WS_ENDPOINT"];

describe("SwngStack", () => {
  describe("guard against the live POC stack namespace", () => {
    it("throws when constructed under an InfraCdkStack* id", () => {
      const app = new App();
      expect(() => new SwngStack(app, "InfraCdkStack-beta")).toThrow(/InfraCdkStack/);
    });

    it("throws for InfraCdkStack-prod too (prefix match, not exact match)", () => {
      const app = new App();
      expect(() => new SwngStack(app, "InfraCdkStack-prod")).toThrow(/InfraCdkStack/);
    });

    it("does not throw for the real swng-<stage> id", () => {
      const app = new App();
      expect(() => new SwngStack(app, "swng-beta", { stage: "beta" })).not.toThrow();
    });
  });

  describe("tables", () => {
    it("has exactly 4 DynamoDB tables", () => {
      template.resourceCountIs("AWS::DynamoDB::Table", 4);
    });

    it("swng-rounds-beta: pk/sk + gsi1 on joinCode, RETAIN, stream NEW_IMAGE", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-rounds-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "joinCode", AttributeType: "S" },
        ]),
        GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "gsi1", KeySchema: [{ AttributeName: "joinCode", KeyType: "HASH" }] })],
        // M7 Task 4: feeds ProjectorFunction (below).
        StreamSpecification: { StreamViewType: "NEW_IMAGE" },
      });
      template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", Properties: Match.objectLike({ TableName: "swng-rounds-beta" }) });
    });

    // M7 Task 4 brief: adding a stream to an already-provisioned table must be an in-place
    // update, never a replacement — same regression class, and same guard idiom, as the core
    // table's own logical-id pin below (M6 Task 3's lesson, applied here for the first time
    // the rounds table itself changes since its creation).
    it("the rounds table's logical id is unchanged (still derived from construct id \"RoundsTable\") — no table replacement", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const roundsTableLogicalId = Object.keys(tables).find((id) => id.startsWith("RoundsTable"));
      expect(roundsTableLogicalId).toBeDefined();
      expect(tables[roundsTableLogicalId!]?.Properties.TableName).toBe("swng-rounds-beta");
    });

    it("swng-core-beta: pk/sk + gsi1 on gsi1pk/gsi1sk (INCLUDE name) + gsi2 on gsi2pk/gsi2sk (ALL), RETAIN", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-core-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
          { AttributeName: "gsi2pk", AttributeType: "S" },
          { AttributeName: "gsi2sk", AttributeType: "S" },
        ]),
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["name"] },
          }),
          // M7 Task 4: the sub→golfer lookup GolferStore.getBySub queries.
          Match.objectLike({
            IndexName: "gsi2",
            KeySchema: [
              { AttributeName: "gsi2pk", KeyType: "HASH" },
              { AttributeName: "gsi2sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ]),
      });
      template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", Properties: Match.objectLike({ TableName: "swng-core-beta" }) });
    });

    // M6 Task 3 brief: adding a GSI to an already-provisioned table must be an in-place
    // update, never a replacement — a changed logical id would make CloudFormation delete
    // and recreate the table (data loss for a RETAIN table's live beta data too, since a
    // brand-new physical resource starts empty). Pinning the exact logical id "CoreTable"
    // (the construct id `new Table(this, "CoreTable", ...)` unchanged from before this task)
    // is the guard against that regression.
    it("the core table's logical id is unchanged (still derived from construct id \"CoreTable\") — no table replacement", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      // CDK derives each resource's CloudFormation logical id from its construct id plus a
      // stable address hash (`new Table(this, "CoreTable", ...)`) — so this id changing means
      // either the construct id or its position in the tree changed, either of which
      // CloudFormation treats as a brand-new resource (delete + recreate) rather than an
      // update to the existing one.
      const coreTableLogicalId = Object.keys(tables).find((id) => id.startsWith("CoreTable"));
      expect(coreTableLogicalId).toBeDefined();
      expect(tables[coreTableLogicalId!]?.Properties.TableName).toBe("swng-core-beta");
    });

    it("swng-projections-beta: pk/sk only, RETAIN", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-projections-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        // Same rationale as swng-core-beta above: pins "pk/sk only" for real.
        GlobalSecondaryIndexes: Match.absent(),
      });
      template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", Properties: Match.objectLike({ TableName: "swng-projections-beta" }) });
    });

    it("swng-connections-beta: pk only + gsi1 on roundId, DESTROY", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-connections-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "roundId", AttributeType: "S" },
        ]),
        GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "gsi1", KeySchema: [{ AttributeName: "roundId", KeyType: "HASH" }] })],
      });
      template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Delete", Properties: Match.objectLike({ TableName: "swng-connections-beta" }) });
    });
  });

  describe("functions", () => {
    // findResources keys every result by its synthesized logical id (a construct-id-derived
    // hash) — this resolves the ORIGINAL three functions (http/wsConnect/wsDisconnect) by
    // their pinned construct-id prefixes, same idiom as the core/rounds table logical-id
    // pins above, so the two tests below that used to iterate "every function" can still mean
    // exactly that trio now that ProjectorFunction/RebuildFunction exist alongside them with a
    // deliberately different env/timeout shape.
    const ORIGINAL_FUNCTION_PREFIXES = ["HttpFunction", "WsConnectFunction", "WsDisconnectFunction"];
    const originalFunctions = () => {
      const functions = template.findResources("AWS::Lambda::Function");
      return Object.entries(functions).filter(([id]) => ORIGINAL_FUNCTION_PREFIXES.some((prefix) => id.startsWith(prefix)));
    };

    it("has exactly 5 Lambda functions (http, wsConnect, wsDisconnect, projector, rebuild)", () => {
      template.resourceCountIs("AWS::Lambda::Function", 5);
    });

    it("every function is Node 20", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const entries = Object.values(functions);
      expect(entries.length).toBe(5);
      for (const fn of entries) {
        expect(fn.Properties.Runtime).toBe("nodejs20.x");
      }
    });

    it("http/wsConnect/wsDisconnect each carry the four required env keys", () => {
      const entries = originalFunctions();
      expect(entries.length).toBe(3);
      for (const [, fn] of entries) {
        const variables = fn.Properties.Environment.Variables;
        for (const key of ENV_KEYS) {
          expect(Object.keys(variables)).toContain(key);
        }
      }
    });

    it("http/wsConnect/wsDisconnect each have an explicit 15s timeout and 512MB memory (not CDK's 3s/128MB defaults)", () => {
      const entries = originalFunctions();
      expect(entries.length).toBe(3);
      for (const [, fn] of entries) {
        expect(fn.Properties.Timeout).toBe(15);
        expect(fn.Properties.MemorySize).toBe(512);
      }
    });

    // M6 Task 3: course routes are HTTP-only (no WS entry point ever touches the core
    // table), unlike TABLE_ROUNDS/TABLE_CONNECTIONS/WS_ENDPOINT above which every function
    // needs — so exactly one of the five functions (httpFn) should carry TABLE_CORE.
    it("exactly one function (http) carries TABLE_CORE", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withTableCore = Object.values(functions).filter((fn) => "TABLE_CORE" in (fn.Properties.Environment.Variables as Record<string, unknown>));
      expect(withTableCore).toHaveLength(1);
    });

    // M7 Task 4: httpFn (forward-provisioned ahead of the golfer/record routes), projectorFn,
    // and rebuildFn all need it — wsConnect/wsDisconnect never do (same TABLE_CORE-shaped
    // story as above).
    it("exactly three functions (http, projector, rebuild) carry TABLE_PROJECTIONS", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withTableProjections = Object.values(functions).filter(
        (fn) => "TABLE_PROJECTIONS" in (fn.Properties.Environment.Variables as Record<string, unknown>),
      );
      expect(withTableProjections).toHaveLength(3);
    });

    it("exactly one function (http) carries USER_POOL_ID/USER_POOL_CLIENT_ID", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withUserPool = Object.values(functions).filter((fn) => {
        const variables = fn.Properties.Environment.Variables as Record<string, unknown>;
        return "USER_POOL_ID" in variables && "USER_POOL_CLIENT_ID" in variables;
      });
      expect(withUserPool).toHaveLength(1);
    });

    it("ProjectorFunction: 15s/512MB, TABLE_PROJECTIONS only (no TOKEN_SECRET/WS_ENDPOINT it has no use for)", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const id = Object.keys(functions).find((key) => key.startsWith("ProjectorFunction"));
      expect(id).toBeDefined();
      const fn = functions[id!]!;
      expect(fn.Properties.Timeout).toBe(15);
      expect(fn.Properties.MemorySize).toBe(512);
      expect(Object.keys(fn.Properties.Environment.Variables)).toEqual(["TABLE_PROJECTIONS"]);
    });

    it("RebuildFunction: a longer timeout than the request-shaped functions (a full-table replay, not a single request), TABLE_PROJECTIONS + TABLE_ROUNDS only", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const id = Object.keys(functions).find((key) => key.startsWith("RebuildFunction"));
      expect(id).toBeDefined();
      const fn = functions[id!]!;
      expect(fn.Properties.Timeout).toBe(300);
      expect(fn.Properties.MemorySize).toBe(512);
      expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual(["TABLE_PROJECTIONS", "TABLE_ROUNDS"]);
    });
  });

  describe("event sources", () => {
    it("has exactly one EventSourceMapping (ProjectorFunction — RebuildFunction is manual-invoke only)", () => {
      template.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
    });

    it("ProjectorFunction's event source: the rounds table's stream, batch 10, TRIM_HORIZON, filtered to ARCHIVE items", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const roundsTableLogicalId = Object.keys(tables).find((id) => id.startsWith("RoundsTable"));
      expect(roundsTableLogicalId).toBeDefined();

      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        EventSourceArn: { "Fn::GetAtt": [roundsTableLogicalId, "StreamArn"] },
        BatchSize: 10,
        StartingPosition: "TRIM_HORIZON",
        FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { Keys: { sk: { S: ["ARCHIVE"] } } } }) }] },
      });
    });

    it("the event source mapping targets ProjectorFunction, never RebuildFunction", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const projectorId = Object.keys(functions).find((id) => id.startsWith("ProjectorFunction"));
      expect(projectorId).toBeDefined();

      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", { FunctionName: { Ref: projectorId } });
    });
  });

  describe("grants", () => {
    // grantReadWriteData(httpFn) (M6 Task 3 brief) attaches an IAM::Policy statement whose
    // Resource covers the core table (and, per CDK's own convention for a table with GSIs,
    // its indexes) — pinned by resolving the core table's actual logical id from the
    // synthesized template rather than hard-coding CDK's hashed id, which is an
    // implementation detail this test shouldn't need to know.
    it("httpFn's role has a policy statement covering the core table (read+write actions)", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const coreTableLogicalId = Object.entries(tables).find(([, table]) => table.Properties.TableName === "swng-core-beta")?.[0];
      expect(coreTableLogicalId).toBeDefined();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:PutItem"]),
              Resource: Match.arrayWith([Match.objectLike({ "Fn::GetAtt": Match.arrayWith([coreTableLogicalId]) })]),
            }),
          ]),
        }),
      });
    });

    // M7 Task 4: projectorFn/rebuildFn/httpFn's projections-table access — same resolve-the-
    // real-logical-id idiom as the core table test above.
    it("projectorFn's role has a policy statement covering the projections table (read+write actions)", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const projectionsTableLogicalId = Object.entries(tables).find(([, table]) => table.Properties.TableName === "swng-projections-beta")?.[0];
      expect(projectionsTableLogicalId).toBeDefined();

      // Unlike the core table (which has GSIs, so grantReadWriteData's Resource is an array
      // of [tableArn, indexArns]), the projections table has none — CDK's Resource here is a
      // single Fn::GetAtt, not wrapped in an array, so this can't reuse the core table test's
      // `Match.arrayWith` shape for Resource.
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:PutItem"]),
              Resource: Match.objectLike({ "Fn::GetAtt": [projectionsTableLogicalId, "Arn"] }),
            }),
          ]),
        }),
      });
    });

    // Read-only: rebuild only Scans for archives (createDynamoArchiveSource), never writes
    // the rounds table — so its policy should carry a read action (Scan) but not a write one
    // (PutItem would mean grantReadWriteData was used here by mistake).
    it("rebuildFn's role has a read-only policy statement covering the rounds table (no write actions)", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const roundsTableLogicalId = Object.keys(tables).find((id) => id.startsWith("RoundsTable"));
      expect(roundsTableLogicalId).toBeDefined();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:Scan"]),
              Resource: Match.arrayWith([Match.objectLike({ "Fn::GetAtt": Match.arrayWith([roundsTableLogicalId]) })]),
            }),
          ]),
        }),
      });
    });
  });

  describe("identity (Cognito, M7 Task 4)", () => {
    it("has exactly one User Pool: email sign-in, self-sign-up on, RETAIN", () => {
      template.resourceCountIs("AWS::Cognito::UserPool", 1);
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        UserPoolName: "swng-beta",
        // CDK's own translation of signInAliases: { email: true } — email IS the username.
        UsernameAttributes: ["email"],
        AutoVerifiedAttributes: ["email"],
        AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: false }), // self-sign-up on
      });
      template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain" });
    });

    // CallbackURLs must carry the exact path the web app redirects to (authConfig.ts's
    // redirectUri = `${origin}/auth/callback`) — Cognito requires an EXACT match, so a bare
    // origin here would make every real Hosted-UI sign-in fail with redirect_mismatch. This
    // pin asserts the full `/auth/callback` URL, not just a substring/origin match, so a
    // regression back to the bare origin fails here. LogoutURLs stays the bare origin: the
    // app's signOut (useAuth.ts) never redirects through Cognito's /logout endpoint.
    it("has exactly one User Pool Client: no secret, authorization-code OAuth flow, USER_PASSWORD_AUTH enabled, callback URL is the bare origin + /auth/callback, logout URL is the bare origin", () => {
      template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        GenerateSecret: false,
        AllowedOAuthFlows: ["code"],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: Match.arrayWith(["openid", "email", "profile"]),
        CallbackURLs: Match.arrayWith(["http://localhost:5173/auth/callback"]),
        LogoutURLs: Match.arrayWith(["http://localhost:5173"]),
        // M9 hardening item (why-comment in swngStack.ts): e2e-gate JWT minting via
        // InitiateAuth, alongside the real web app's authorization-code+PKCE flow above.
        ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"]),
      });
    });

    it("has exactly one User Pool Domain: Cognito prefix domain swng-<stage>-<account>", () => {
      template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
      template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: { "Fn::Join": ["", ["swng-beta-", { Ref: "AWS::AccountId" }]] },
      });
    });
  });

  describe("APIs", () => {
    it("has an HTTP API", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
    });

    it("has a WEBSOCKET API", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "WEBSOCKET" });
    });

    it("has a WebSocket stage named beta", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", { StageName: "beta" });
    });

    it("wires $connect and $disconnect routes", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$connect" });
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$disconnect" });
    });

    it("wires all seventeen HTTP routes", () => {
      const expectedRouteKeys = [
        "POST /rounds",
        "POST /rounds/join",
        "POST /rounds/{roundId}/games",
        "POST /rounds/{roundId}/scores",
        "POST /rounds/{roundId}/finalize",
        "GET /rounds/{roundId}/events",
        "GET /rounds/peek",
        "POST /courses",
        "POST /courses/{courseId}/tees",
        "POST /courses/{courseId}/verify",
        "GET /courses/{courseId}",
        "GET /courses",
        // M7 Task 5: game/round termination + the golfer identity surface.
        "POST /rounds/{roundId}/games/{gameId}/terminate",
        "GET /me",
        "PUT /me",
        "POST /golfers/claim",
        "GET /me/record",
      ];
      const routes = template.findResources("AWS::ApiGatewayV2::Route");
      const routeKeys = Object.values(routes).map((route) => route.Properties.RouteKey);
      for (const expected of expectedRouteKeys) {
        expect(routeKeys).toContain(expected);
      }
    });

    // Pins the total route count exactly (17 HTTP + $connect + $disconnect): the two tests
    // above each check membership, neither pins the count, so a stray extra route (or one
    // silently dropped) could pass both without this.
    it("has exactly 19 routes total (17 HTTP + $connect + $disconnect)", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Route", 19);
    });

    // M7 Task 5: PUT /me shipped, and the live preflight check against beta showed a route
    // method missing from the CORS allow-list is browser-dead (the preflight 204 carries NO
    // access-control-allow-* headers, so the browser blocks the actual request) while still
    // answering curl — the exact kind of gap no unit test caught. Pinned as a superset check
    // against HTTP_ROUTES itself, not a hand-typed list, so the NEXT route bringing a new
    // method fails here instead of in a browser against deployed beta.
    it("the HTTP API's CORS allow-methods covers every method HTTP_ROUTES uses", () => {
      const apis = template.findResources("AWS::ApiGatewayV2::Api");
      const httpApi = Object.values(apis).find((api) => api.Properties.ProtocolType === "HTTP");
      expect(httpApi).toBeDefined();
      const allowMethods = httpApi!.Properties.CorsConfiguration.AllowMethods as string[];
      const routeMethods = [...new Set(HTTP_ROUTES.map((route) => route.method as string))];
      for (const method of routeMethods) {
        expect(allowMethods).toContain(method);
      }
    });
  });

  // M7 Task 5 rider: closes the drift risk the file's own ARCHIVE_SK comment names — a
  // future rename of keys.ts's `archiveSk` (the projector's event-source filter target) with
  // no matching update here would silently starve the projector (its filter would never
  // match a real archive item), and nothing would catch it without this pin.
  describe("ARCHIVE_SK parity (M7 Task 5 rider)", () => {
    it("ARCHIVE_SK matches adapters-dynamodb's own archiveSk constant exactly", () => {
      expect(ARCHIVE_SK).toBe(archiveSk);
    });
  });

  describe("outputs", () => {
    it("outputs HttpApiUrl and WsApiUrl", () => {
      template.hasOutput("HttpApiUrl", {});
      template.hasOutput("WsApiUrl", {});
    });

    it("outputs UserPoolId, UserPoolClientId, and HostedUiDomain", () => {
      template.hasOutput("UserPoolId", {});
      template.hasOutput("UserPoolClientId", {});
      template.hasOutput("HostedUiDomain", {});
    });
  });
});
