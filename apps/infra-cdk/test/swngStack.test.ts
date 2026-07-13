import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ANON_THROTTLED_ROUTES, HTTP_ROUTES, SwngStack } from "../lib/swngStack.js";

// One stack, synthesized once, asserted against many times — synthesis (which bundles all
// three Lambdas with esbuild) is the expensive part of this suite; sharing it across `it`
// blocks keeps the run fast without weakening any single assertion.
const template = Template.fromStack(new SwngStack(new App(), "swng-beta", { stage: "beta" }));

const ENV_KEYS = ["TABLE_ROUNDS", "TABLE_CONNECTIONS", "TOKEN_SECRET", "WS_ENDPOINT"];

// Resolves a resource's logical id dynamically (never hardcode one of CDK's own hashed ids,
// same idiom as the core/rounds-table logical-id pins above) — shared by the identity and
// hosted-web suites below, both of which need to point an assertion at a specific construct's
// own CloudFormation reference.
const findLogicalId = (resourceType: string, predicate?: (properties: Record<string, unknown>) => boolean): string => {
  const resources = template.findResources(resourceType);
  const entry = predicate ? Object.entries(resources).find(([, resource]) => predicate(resource.Properties)) : Object.entries(resources)[0];
  expect(entry, `no ${resourceType} resource found matching the predicate`).toBeDefined();
  return entry![0];
};

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
    // Snapshot realignment Task 1: the snapshots table joins rounds/core/projections/connections.
    it("has exactly 5 DynamoDB tables", () => {
      template.resourceCountIs("AWS::DynamoDB::Table", 5);
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

    // Snapshot realignment Task 1 / spec §3: the golfer record's presence rows (Task 13, later
    // in the plan) are self-expiring — TTL is provisioned now so that task is route/store
    // wiring only, not another CDK change (same forward-provisioning idiom M7 Task 4 used for
    // TABLE_PROJECTIONS on httpFn before any route read it).
    it("projections table has TTL enabled on 'ttl'", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-projections-beta",
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      });
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

    // Snapshot realignment Task 1 / spec §1+§11: the snapshots table is "the atom" — one
    // immutable item per finalized round, pk-only (no sk: a key is an identity, never a
    // timestamp — plan's own Global Constraints), RETAIN + PITR mirroring the rounds table's
    // own durability posture (a finalized round is exactly as irreplaceable as its own event
    // log). The stream feeds ProjectorFunction with NO filter (asserted in "event sources"
    // below) — every item on this table IS a finished round, unlike the rounds table's stream
    // which mixed in every EVT/OPID/META record too.
    it("swng-snapshots-beta: pk-only, stream, RETAIN, PITR", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-snapshots-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        StreamSpecification: { StreamViewType: "NEW_IMAGE" },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
      template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", Properties: Match.objectLike({ TableName: "swng-snapshots-beta" }) });
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

    // M9 Task 6: WebBucket's autoDeleteObjects (below) adds a 6th, CDK-MANAGED Lambda — the
    // singleton Custom::S3AutoDeleteObjects provider — which is not one of OUR 5 application
    // entry points (it carries no TABLE_*/WS_ENDPOINT env, a runtime CDK picks for us, not
    // NODEJS_20_X, and is never dispatched through packages/lambda at all). appFunctions()
    // scopes the tests below to the 5 that are ours; a separate test pins the real total of 6.
    const APP_FUNCTION_PREFIXES = [...ORIGINAL_FUNCTION_PREFIXES, "ProjectorFunction", "RebuildFunction"];
    const appFunctions = () => {
      const functions = template.findResources("AWS::Lambda::Function");
      return Object.entries(functions).filter(([id]) => APP_FUNCTION_PREFIXES.some((prefix) => id.startsWith(prefix)));
    };

    it("has exactly 5 application Lambda functions (http, wsConnect, wsDisconnect, projector, rebuild)", () => {
      expect(appFunctions()).toHaveLength(5);
    });

    it("has exactly 6 Lambda functions total (the 5 application functions + the CDK-managed WebBucket auto-delete-objects custom resource provider, M9 Task 6)", () => {
      template.resourceCountIs("AWS::Lambda::Function", 6);
    });

    it("every application function is Node 20 (the CDK-managed auto-delete-objects provider's runtime is CDK's own choice, not this stack's)", () => {
      const entries = appFunctions();
      expect(entries.length).toBe(5);
      for (const [, fn] of entries) {
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
    // `Environment?.Variables` (not a bare `.Environment.Variables`): the M9 Task 6 auto-
    // delete-objects Lambda (above) carries NO Environment property at all — a bare access
    // would throw TypeError on it rather than just correctly reporting "no TABLE_CORE here".
    it("exactly one function (http) carries TABLE_CORE", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withTableCore = Object.values(functions).filter((fn) => "TABLE_CORE" in ((fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>));
      expect(withTableCore).toHaveLength(1);
    });

    // M7 Task 4: httpFn (forward-provisioned ahead of the golfer/record routes), projectorFn,
    // and rebuildFn all need it — wsConnect/wsDisconnect never do (same TABLE_CORE-shaped
    // story as above).
    it("exactly three functions (http, projector, rebuild) carry TABLE_PROJECTIONS", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withTableProjections = Object.values(functions).filter(
        (fn) => "TABLE_PROJECTIONS" in ((fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>),
      );
      expect(withTableProjections).toHaveLength(3);
    });

    // Snapshot realignment Task 1: httpFn (the finalize transaction writes the snapshot) and
    // rebuildFn (the backfill reads from it, a later task) — projectorFn deliberately does
    // NOT get this env: its event source hands stream records straight to the invocation
    // payload (parseSnapshotStreamImage, a later task), so it never needs the table name to
    // issue its own read.
    it("exactly two functions (http, rebuild) carry TABLE_SNAPSHOTS", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withTableSnapshots = Object.values(functions).filter(
        (fn) => "TABLE_SNAPSHOTS" in ((fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>),
      );
      expect(withTableSnapshots).toHaveLength(2);
    });

    it("exactly one function (http) carries USER_POOL_ID/USER_POOL_CLIENT_ID", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withUserPool = Object.values(functions).filter((fn) => {
        const variables = (fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>;
        return "USER_POOL_ID" in variables && "USER_POOL_CLIENT_ID" in variables;
      });
      expect(withUserPool).toHaveLength(1);
    });

    // Snapshot realignment Task 1: unchanged by this task — the projector's event source moves
    // to the snapshots table's stream (below), but the FUNCTION's own env stays exactly
    // TABLE_PROJECTIONS (it reads nothing by table name; it upserts the projection its stream
    // record already carries the archive for).
    it("ProjectorFunction: 15s/512MB, TABLE_PROJECTIONS only (no TOKEN_SECRET/WS_ENDPOINT it has no use for)", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const id = Object.keys(functions).find((key) => key.startsWith("ProjectorFunction"));
      expect(id).toBeDefined();
      const fn = functions[id!]!;
      expect(fn.Properties.Timeout).toBe(15);
      expect(fn.Properties.MemorySize).toBe(512);
      expect(Object.keys(fn.Properties.Environment.Variables)).toEqual(["TABLE_PROJECTIONS"]);
    });

    // Snapshot realignment Task 1: TABLE_ROUNDS is GONE (the rebuild never touches the rounds
    // table again — it backfills from the snapshots table's own page() instead, a later task);
    // TABLE_SNAPSHOTS replaces it.
    it("RebuildFunction: a longer timeout than the request-shaped functions (a full-table replay, not a single request), TABLE_PROJECTIONS + TABLE_SNAPSHOTS only", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const id = Object.keys(functions).find((key) => key.startsWith("RebuildFunction"));
      expect(id).toBeDefined();
      const fn = functions[id!]!;
      expect(fn.Properties.Timeout).toBe(300);
      expect(fn.Properties.MemorySize).toBe(512);
      expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual(["TABLE_PROJECTIONS", "TABLE_SNAPSHOTS"]);
    });
  });

  describe("event sources", () => {
    it("has exactly one EventSourceMapping (ProjectorFunction — RebuildFunction is manual-invoke only)", () => {
      template.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
    });

    // Snapshot realignment Task 1: the event source moves from the rounds table (filtered to
    // ARCHIVE items, since that table's stream mixed in every EVT/OPID/META record too) to the
    // snapshots table's own stream, where every item IS a finished round — so the filter is
    // deleted outright, not narrowed (spec §2: "no filter, no branching").
    it("ProjectorFunction's event source: the snapshots table's stream, batch 10, TRIM_HORIZON, NO filter", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const snapshotsTableLogicalId = Object.keys(tables).find((id) => id.startsWith("SnapshotsTable"));
      expect(snapshotsTableLogicalId).toBeDefined();

      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        EventSourceArn: { "Fn::GetAtt": [snapshotsTableLogicalId, "StreamArn"] },
        BatchSize: 10,
        StartingPosition: "TRIM_HORIZON",
        FilterCriteria: Match.absent(),
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

    // Snapshot realignment Task 1: the rebuild reads the snapshots table now, not the rounds
    // table — same read-only shape as before (no write actions), new table. No GSIs on this
    // table, so Resource is a single Fn::GetAtt (the projections-table test's shape above),
    // not the core table's array-of-[tableArn, indexArns].
    it("rebuildFn's role has a read-only policy statement covering the snapshots table (no write actions)", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const snapshotsTableLogicalId = Object.entries(tables).find(([, table]) => table.Properties.TableName === "swng-snapshots-beta")?.[0];
      expect(snapshotsTableLogicalId).toBeDefined();

      // Resolve rebuildFn's role to find its policies
      const functions = template.findResources("AWS::Lambda::Function");
      const rebuildId = Object.keys(functions).find((id) => id.startsWith("RebuildFunction"));
      expect(rebuildId).toBeDefined();
      const roleRef = functions[rebuildId!]!.Properties.Role as { "Fn::GetAtt": [string, string] };
      const roleLogicalId = roleRef["Fn::GetAtt"][0];

      // Find the policy statement for the snapshots table
      const policies = template.findResources("AWS::IAM::Policy");
      const rebuildPolicies = Object.values(policies).filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId));
      expect(rebuildPolicies.length).toBeGreaterThan(0);

      // Find the statement that covers the snapshots table and assert it's read-only
      let foundStatement = false;
      for (const policy of rebuildPolicies) {
        const statements = (policy.Properties.PolicyDocument.Statement ?? []) as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>;
        for (const statement of statements) {
          const stmtResourceStr = JSON.stringify(statement.Resource);
          if (stmtResourceStr.includes(snapshotsTableLogicalId!)) {
            foundStatement = true;
            const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
            // Assert GetItem is present
            expect(actions).toContain("dynamodb:GetItem");
            // Assert no write actions
            const writeActions = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"];
            for (const writeAction of writeActions) {
              expect(actions).not.toContain(writeAction);
            }
          }
        }
      }
      expect(foundStatement, "snapshots table statement not found in rebuildFn's policies").toBe(true);
    });

    // httpFn's finalize transaction writes the snapshot (a later task) — read+write, same
    // no-GSI Resource shape as the read-only rebuildFn test just above.
    it("httpFn's role has a policy statement covering the snapshots table (read+write actions)", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      const snapshotsTableLogicalId = Object.entries(tables).find(([, table]) => table.Properties.TableName === "swng-snapshots-beta")?.[0];
      expect(snapshotsTableLogicalId).toBeDefined();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:PutItem"]),
              Resource: Match.objectLike({ "Fn::GetAtt": [snapshotsTableLogicalId, "Arn"] }),
            }),
          ]),
        }),
      });
    });

    // The grant is gone, not just the env var (brief: "REMOVE TABLE_ROUNDS env + its grant") —
    // resolves rebuildFn's OWN role, then asserts none of ITS policy statements mention the
    // rounds table at all (a stronger check than "no write action" above: rebuildFn should
    // have no relationship to this table whatsoever now).
    it("rebuildFn's role carries no policy statement covering the rounds table at all (the grant is gone, not just the env var)", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const rebuildId = Object.keys(functions).find((id) => id.startsWith("RebuildFunction"));
      expect(rebuildId).toBeDefined();
      const roleRef = functions[rebuildId!]!.Properties.Role as { "Fn::GetAtt": [string, string] };
      const roleLogicalId = roleRef["Fn::GetAtt"][0];

      const tables = template.findResources("AWS::DynamoDB::Table");
      const roundsTableLogicalId = Object.keys(tables).find((id) => id.startsWith("RoundsTable"));
      expect(roundsTableLogicalId).toBeDefined();

      const policies = template.findResources("AWS::IAM::Policy");
      const rebuildPolicies = Object.values(policies).filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId));
      expect(rebuildPolicies.length).toBeGreaterThan(0);
      for (const policy of rebuildPolicies) {
        expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain(roundsTableLogicalId);
      }
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
    // regression back to the bare origin fails here. LogoutURLs (M9 hardening, papercut 6) is
    // the origin WITH a trailing slash — authConfig.ts's buildLogoutUrl always sends
    // `${origin}/` as logout_uri, and Cognito's exact-match rule applies here too.
    it("has exactly one User Pool Client: no secret, authorization-code OAuth flow, USER_PASSWORD_AUTH enabled, callback URL is the bare origin + /auth/callback, logout URL is the origin + trailing slash", () => {
      template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        GenerateSecret: false,
        AllowedOAuthFlows: ["code"],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: Match.arrayWith(["openid", "email", "profile"]),
        CallbackURLs: Match.arrayWith(["http://localhost:5173/auth/callback"]),
        LogoutURLs: Match.arrayWith(["http://localhost:5173/"]),
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

    // M9 Task 6: the CloudFront origin is APPENDED onto the same UserPoolClient (resourceCountIs
    // above already pins "exactly one" — this is the SAME client, not a second one from a
    // replacement), reached through the L1 escape hatch since the distribution's domain isn't
    // known until after the HTTP/WS APIs the CSP depends on are built. The original localhost
    // entries (asserted above) MUST still be present too — dev must keep working.
    it("callback/logout URLs include BOTH localhost (dev) AND the CloudFront distribution origin, on the SAME client", () => {
      const distributionLogicalId = findLogicalId("AWS::CloudFront::Distribution");
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const props = Object.values(clients)[0]!.Properties as Record<string, unknown>;
      const callbackUrls = JSON.stringify(props.CallbackURLs);
      const logoutUrls = JSON.stringify(props.LogoutURLs);

      expect(callbackUrls).toContain("http://localhost:5173/auth/callback");
      expect(callbackUrls).toContain(distributionLogicalId);
      expect(callbackUrls).toContain("/auth/callback");

      expect(logoutUrls).toContain("http://localhost:5173/");
      expect(logoutUrls).toContain(distributionLogicalId);
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

    it("wires all thirty-five HTTP routes", () => {
      const expectedRouteKeys = [
        "POST /rounds",
        "POST /rounds/join",
        "POST /rounds/{roundId}/games",
        "POST /rounds/{roundId}/scores",
        "POST /rounds/{roundId}/finalize",
        "GET /rounds/{roundId}/events",
        // M9 Task 3 (share): mints this round's immortal spectator link.
        "POST /rounds/{roundId}/share",
        // Projection-realignment Task 6: the settled snapshot's own event log.
        "GET /rounds/{roundId}/archive",
        // Architecture-realignment Task 14: the participant-token re-mint.
        "POST /rounds/{roundId}/token",
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
        // Projection-realignment Task 6: "list my rounds".
        "GET /me/rounds",
        // Projection-realignment Task 13: "your rounds, right now" — presence.
        "GET /me/rounds/live",
        // M8 Task 4: crews + rounds played as yourself (POST /rounds, POST /rounds/join above
        // are unchanged route keys — only their auth tier moved).
        "POST /rounds/{roundId}/players",
        "POST /crews",
        "POST /crews/join",
        "GET /me/crews",
        "GET /crews/{crewId}",
        "POST /crews/{crewId}/members",
        "PUT /crews/{crewId}/standing-game",
        // Architecture-realignment Task 9: crew seasons + counted rounds + standings + leave
        // (GET /crews/{crewId}/records is gone — the crew projection layer it read is deleted).
        "POST /crews/{crewId}/seasons",
        "GET /crews/{crewId}/seasons",
        "POST /crews/{crewId}/seasons/{seasonId}/rounds",
        "DELETE /crews/{crewId}/seasons/{seasonId}/rounds/{roundId}",
        "GET /crews/{crewId}/seasons/{seasonId}/standings",
        "POST /crews/{crewId}/leave",
      ];
      const routes = template.findResources("AWS::ApiGatewayV2::Route");
      const routeKeys = Object.values(routes).map((route) => route.Properties.RouteKey);
      for (const expected of expectedRouteKeys) {
        expect(routeKeys).toContain(expected);
      }
    });

    // Pins the total route count exactly (35 HTTP + $connect + $disconnect): the two tests
    // above each check membership, neither pins the count, so a stray extra route (or one
    // silently dropped) could pass both without this.
    it("has exactly 37 routes total (35 HTTP + $connect + $disconnect)", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Route", 37);
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

  // M9 Task 5: HTTP API stage throttling — a stage-wide default plus a tighter per-route
  // ceiling on the anonymous-reachable routes (routes.ts's own auth column; ANON_THROTTLED_ROUTES
  // above names exactly which 8).
  describe("throttling (M9 Task 5)", () => {
    it("every ANON_THROTTLED_ROUTES entry is a real HTTP_ROUTES route (no typo'd path silently throttles nothing)", () => {
      for (const anonRoute of ANON_THROTTLED_ROUTES) {
        const isReal = HTTP_ROUTES.some((route) => route.method === anonRoute.method && route.path === anonRoute.path);
        expect(isReal, `${anonRoute.method} ${anonRoute.path} is not in HTTP_ROUTES`).toBe(true);
      }
    });

    it("the HTTP API's default stage carries a stage-wide default throttle of rate 50 / burst 100", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        StageName: "$default",
        DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      });
    });

    // Named anon routes get the tighter rate 5 / burst 10 ceiling — POST /rounds (an
    // "optional-golfer" route, anonymous-reachable) and GET /courses/{courseId} (a "none"-auth
    // course route) each pinned individually, plus a full-membership check below that every one
    // of the 8 keys is present with the same values (a single Match.objectLike per key would
    // pass even if the OTHER 7 routes were silently dropped from the map).
    it("POST /rounds carries the tighter per-route throttle (rate 5 / burst 10)", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        RouteSettings: Match.objectLike({ "POST /rounds": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 } }),
      });
    });

    it("GET /courses/{courseId} carries the tighter per-route throttle too (not just the round-entry routes)", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        RouteSettings: Match.objectLike({ "GET /courses/{courseId}": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 } }),
      });
    });

    it("all 8 anonymous-reachable routes carry the tighter throttle, and no others are present in RouteSettings", () => {
      const stages = template.findResources("AWS::ApiGatewayV2::Stage");
      const defaultStage = Object.values(stages).find((stage) => stage.Properties.StageName === "$default");
      expect(defaultStage).toBeDefined();
      const routeSettings = defaultStage!.Properties.RouteSettings as Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }>;
      const expectedKeys = ANON_THROTTLED_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
      expect(Object.keys(routeSettings).sort()).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        expect(routeSettings[key]).toEqual({ ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 });
      }
    });
  });

  // M9 Task 5: every alarm routes into the SAME SNS topic (the owner's one inbox), so this
  // suite checks the count once and the topic-wiring once across every alarm found, rather than
  // repeating the same AlarmActions assertion by hand for all 13.
  describe("alarms (M9 Task 5)", () => {
    it("has exactly 13 CloudWatch alarms (5 function errors + 1 HTTP 5xx + 1 IteratorAge + 1 Rebuild Duration + 5 table throttled-requests)", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 13);
    });

    it("every alarm's AlarmActions targets the one AlarmsTopic (no alarm silently rings nowhere)", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      const topicLogicalId = Object.keys(topics).find((id) => id.startsWith("AlarmsTopic"));
      expect(topicLogicalId).toBeDefined();

      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const alarmEntries = Object.entries(alarms);
      expect(alarmEntries.length).toBe(13);
      for (const [, alarm] of alarmEntries) {
        expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicLogicalId }]);
      }
    });

    it("every one of the 5 functions has its own Errors >= 1 (5 min) alarm", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const errorAlarms = Object.values(alarms).filter((alarm) => alarm.Properties.MetricName === "Errors" && alarm.Properties.Namespace === "AWS/Lambda");
      expect(errorAlarms).toHaveLength(5);
      for (const alarm of errorAlarms) {
        expect(alarm.Properties.Threshold).toBe(1);
        expect(alarm.Properties.Period).toBe(300);
        expect(alarm.Properties.Statistic).toBe("Sum");
        expect(alarm.Properties.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
      }
    });

    it("the HTTP API 5xx alarm: AWS/ApiGateway 5xx, threshold 5, 5-minute period", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/ApiGateway",
        MetricName: "5xx",
        Statistic: "Sum",
        Period: 300,
        Threshold: 5,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });

    it("the projector IteratorAge alarm: AWS/Lambda IteratorAge, threshold 300000ms (5 minutes), strictly greater-than", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/Lambda",
        MetricName: "IteratorAge",
        Statistic: "Maximum",
        Threshold: 300_000,
        ComparisonOperator: "GreaterThanThreshold",
      });
    });

    it("the rebuild Duration alarm: AWS/Lambda Duration, threshold 240000ms (4 minutes) — the 5-minute-timeout tripwire", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/Lambda",
        MetricName: "Duration",
        Statistic: "Maximum",
        Threshold: 240_000,
        ComparisonOperator: "GreaterThanThreshold",
      });
    });

    it("all 5 tables get a throttled-requests math-expression alarm (threshold 1, summed across the real operations adapters-dynamodb issues)", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const throttleAlarms = Object.values(alarms).filter((alarm) =>
        (alarm.Properties.AlarmDescription as string | undefined)?.includes("throttled request"),
      );
      expect(throttleAlarms).toHaveLength(5);
      for (const alarm of throttleAlarms) {
        expect(alarm.Properties.Threshold).toBe(1);
        expect(alarm.Properties.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
        // A math-expression alarm carries `Metrics`, not a bare `MetricName` — pinning this
        // rules out a future edit accidentally swapping in a single-metric (non-summed) alarm.
        expect(Array.isArray(alarm.Properties.Metrics)).toBe(true);
      }
    });
  });

  // M9 Task 5: one SNS topic, one email subscription to the plan's flagged owner address — the
  // subscription itself needs a confirmation click after deploy (SNS's own protocol), which is
  // a real human action, not something this stack (or a deploy script) can complete.
  describe("SNS alarms topic (M9 Task 5)", () => {
    it("has exactly one SNS topic named swng-alarms-beta", () => {
      template.resourceCountIs("AWS::SNS::Topic", 1);
      template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "swng-alarms-beta" });
    });

    it("has exactly one email subscription to interrante.blaine@gmail.com, targeting the alarms topic", () => {
      template.resourceCountIs("AWS::SNS::Subscription", 1);
      const topics = template.findResources("AWS::SNS::Topic");
      const topicLogicalId = Object.keys(topics).find((id) => id.startsWith("AlarmsTopic"));
      expect(topicLogicalId).toBeDefined();
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "interrante.blaine@gmail.com",
        TopicArn: { Ref: topicLogicalId },
      });
    });
  });

  // M9 Task 6: S3 + CloudFront so the app is reachable from a phone.
  describe("hosted web (S3 + CloudFront, M9 Task 6)", () => {
    it("has exactly one CloudFront distribution with index.html as the default root object", () => {
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({ DefaultRootObject: "index.html" }),
      });
    });

    // SPA fallback: a client-side route with no matching S3 key (/watch/:roundId, /round/:id,
    // /profile, ...) surfaces from a private OAC-fronted bucket as 403 (S3's "missing key"
    // response through OAC is Access Denied, not 404) — BOTH must map to index.html with a 200
    // so react-router's client routing takes over instead of a raw CloudFront error page.
    it("SPA fallback: both 403 and 404 map to /index.html with a 200", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: Match.arrayWith([
            { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" },
            { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" },
          ]),
        }),
      });
    });

    it("uses Origin Access Control (OAC), never the legacy Origin Access Identity (OAI)", () => {
      template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
      template.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    });

    it("the web bucket blocks all public access — CloudFront's OAC is the only reader", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    // Unlike the RETAIN tables/pool pinned above: this bucket holds only re-publishable Vite
    // build output, never irreplaceable data, so DESTROY (rather than a table/pool's RETAIN) is
    // the correct removal policy — pinned here so a future edit can't silently change that.
    it("the web bucket's removal policy is DESTROY (re-publishable build output, unlike the RETAIN tables/pool above)", () => {
      template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    });

    it("the response headers policy's CSP carries the full directive set, with connect-src built from THIS stack's own httpApi/webSocketApi/userPoolDomain tokens (not hardcoded)", () => {
      const httpApiLogicalId = findLogicalId("AWS::ApiGatewayV2::Api", (properties) => properties.ProtocolType === "HTTP");
      const wsApiLogicalId = findLogicalId("AWS::ApiGatewayV2::Api", (properties) => properties.ProtocolType === "WEBSOCKET");
      const userPoolDomainLogicalId = findLogicalId("AWS::Cognito::UserPoolDomain");

      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policyEntries = Object.values(policies);
      expect(policyEntries).toHaveLength(1);
      const securityHeaders = policyEntries[0]!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
      expect(securityHeaders.ContentSecurityPolicy.Override).toBe(true);

      // Stringified rather than matched structurally: the CSP is a compound Fn::Join of
      // literal fragments and per-construct tokens, and a literal-region assumption here would
      // make this test depend on how the STACK ITSELF resolves `Stack.region` (a real stack
      // deploy — bin/infra-cdk.ts — pins it to a literal, but a construct with no explicit env,
      // like this suite's own `template` above, resolves it to the AWS::Region pseudo
      // parameter instead) — a distinction this test has no reason to care about. Checking
      // that each real construct's OWN logical id appears somewhere in the rendered value is a
      // direct, resolution-agnostic proof that the CSP was built from live stack tokens.
      const rendered = JSON.stringify(securityHeaders.ContentSecurityPolicy.ContentSecurityPolicy);
      expect(rendered).toContain("default-src 'self'; connect-src 'self' ");
      expect(rendered).toContain(httpApiLogicalId);
      expect(rendered).toContain(" wss://");
      expect(rendered).toContain(wsApiLogicalId);
      expect(rendered).toContain(userPoolDomainLogicalId);
      expect(rendered).toContain(".auth.");
      expect(rendered).toContain("amazoncognito.com; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
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

    it("outputs WebBucketName, DistributionId, and WebUrl (scripts/publishWeb.mjs's own inputs)", () => {
      template.hasOutput("WebBucketName", {});
      template.hasOutput("DistributionId", {});
      template.hasOutput("WebUrl", {});
    });
  });
});
