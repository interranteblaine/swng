import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SwngStack } from "../lib/swngStack.js";

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

    it("swng-rounds-beta: pk/sk + gsi1 on joinCode, RETAIN", () => {
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
      });
      template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", Properties: Match.objectLike({ TableName: "swng-rounds-beta" }) });
    });

    it("swng-core-beta: pk/sk + gsi1 on gsi1pk/gsi1sk (INCLUDE name), RETAIN", () => {
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
        ]),
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["name"] },
          }),
        ],
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
    it("has exactly 3 Lambda functions", () => {
      template.resourceCountIs("AWS::Lambda::Function", 3);
    });

    it("every function is Node 20 with the four required env keys", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const entries = Object.values(functions);
      expect(entries.length).toBe(3);
      for (const fn of entries) {
        expect(fn.Properties.Runtime).toBe("nodejs20.x");
        const variables = fn.Properties.Environment.Variables;
        for (const key of ENV_KEYS) {
          expect(Object.keys(variables)).toContain(key);
        }
      }
    });

    it("every function has an explicit 15s timeout and 512MB memory (not CDK's 3s/128MB defaults)", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const entries = Object.values(functions);
      expect(entries.length).toBe(3);
      for (const fn of entries) {
        expect(fn.Properties.Timeout).toBe(15);
        expect(fn.Properties.MemorySize).toBe(512);
      }
    });

    // M6 Task 3: course routes are HTTP-only (no WS entry point ever touches the core
    // table), unlike TABLE_ROUNDS/TABLE_CONNECTIONS/WS_ENDPOINT above which every function
    // needs — so exactly one of the three functions (httpFn) should carry TABLE_CORE.
    it("exactly one function (http) carries TABLE_CORE", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withTableCore = Object.values(functions).filter((fn) => "TABLE_CORE" in (fn.Properties.Environment.Variables as Record<string, unknown>));
      expect(withTableCore).toHaveLength(1);
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

    it("wires all six HTTP routes", () => {
      const expectedRouteKeys = [
        "POST /rounds",
        "POST /rounds/join",
        "POST /rounds/{roundId}/games",
        "POST /rounds/{roundId}/scores",
        "POST /rounds/{roundId}/finalize",
        "GET /rounds/{roundId}/events",
      ];
      const routes = template.findResources("AWS::ApiGatewayV2::Route");
      const routeKeys = Object.values(routes).map((route) => route.Properties.RouteKey);
      for (const expected of expectedRouteKeys) {
        expect(routeKeys).toContain(expected);
      }
    });

    // Pins the total route count exactly (6 HTTP + $connect + $disconnect): the two tests
    // above each check membership, neither pins the count, so a stray extra route (or one
    // silently dropped) could pass both without this.
    it("has exactly 8 routes total (6 HTTP + $connect + $disconnect)", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Route", 8);
    });
  });

  describe("outputs", () => {
    it("outputs HttpApiUrl and WsApiUrl", () => {
      template.hasOutput("HttpApiUrl", {});
      template.hasOutput("WsApiUrl", {});
    });
  });
});
