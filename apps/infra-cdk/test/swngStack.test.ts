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

    it("swng-core-beta: pk/sk only, RETAIN", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-core-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      });
      template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", Properties: Match.objectLike({ TableName: "swng-core-beta" }) });
    });

    it("swng-projections-beta: pk/sk only, RETAIN", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-projections-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
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
  });

  describe("outputs", () => {
    it("outputs HttpApiUrl and WsApiUrl", () => {
      template.hasOutput("HttpApiUrl", {});
      template.hasOutput("WsApiUrl", {});
    });
  });
});
