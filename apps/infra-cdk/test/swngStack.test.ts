import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ANON_THROTTLED_ROUTES, HTTP_ROUTES, SwngStack } from "../lib/swngStack.js";

// One stack, synthesized once, asserted against many times — synthesis (which bundles all
// three Lambdas with esbuild) is the expensive part of this suite; sharing it across `it`
// blocks keeps the run fast without weakening any single assertion.
const template = Template.fromStack(
  new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-beta", { stage: "beta" }),
);

// Task 4: TOKEN_SECRET_ARN, not TOKEN_SECRET — the secret's ARN rides in the env now, never
// its plaintext value. Prod-readiness Arc B Task 2: STAGE joins the shared set — it labels the
// EMF metrics' Stage dimension for the same three sharedEnv consumers.
const ENV_KEYS = ["TABLE_ROUNDS", "TABLE_CONNECTIONS", "TOKEN_SECRET_ARN", "WS_ENDPOINT", "STAGE"];

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

    it("swng-rounds-beta: pk/sk + gsi1 on joinCode, RETAIN, stream NEW_IMAGE, PITR, deletion protection", () => {
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
        // Prod-readiness hardening Task 7: the event log is the source of truth for a round in
        // flight — PITR (non-deprecated PointInTimeRecoverySpecification form) and deletion
        // protection are both in-place-modifiable, never a replacement.
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
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

    it("swng-core-beta: pk/sk + gsi1 on gsi1pk/gsi1sk (INCLUDE name) + gsi2 on gsi2pk/gsi2sk (ALL), RETAIN, PITR, deletion protection", () => {
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
        // Prod-readiness hardening Task 7: courses + golfer identity are as irreplaceable as
        // the round log itself.
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
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

    it("swng-projections-beta: pk/sk only, RETAIN, deletion protection, no PITR (rebuildable from snapshots)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-projections-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        // Same rationale as swng-core-beta above: pins "pk/sk only" for real.
        GlobalSecondaryIndexes: Match.absent(),
        // Prod-readiness hardening Task 7: deletion protection guards against an accidental
        // teardown, but PITR is deliberately withheld — this table is a rebuild away from the
        // snapshots table's own PITR-backed history (rebuildProjections), so paying for a
        // second continuous-backup stream here would be redundant durability.
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: Match.absent(),
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

    it("swng-connections-beta: pk only + gsi1 on roundId, DESTROY, no deletion protection, no PITR (rebuildable WS state)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-connections-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "roundId", AttributeType: "S" },
        ]),
        GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "gsi1", KeySchema: [{ AttributeName: "roundId", KeyType: "HASH" }] })],
        // Prod-readiness hardening Task 7: pins the intentional asymmetry against the four
        // RETAIN tables above — pure WS fan-out state, rebuildable from nothing, never gets
        // deletion protection or PITR.
        DeletionProtectionEnabled: Match.absent(),
        PointInTimeRecoverySpecification: Match.absent(),
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
    it("swng-snapshots-beta: pk-only, stream, RETAIN, PITR, deletion protection", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "swng-snapshots-beta",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        StreamSpecification: { StreamViewType: "NEW_IMAGE" },
        // Prod-readiness hardening Task 7: migrated from the deprecated boolean
        // `pointInTimeRecovery: true` to this non-deprecated form — a template no-op (both
        // render this identical CFN block; the assertion below was already green before the
        // migration and stays green after it).
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
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

    // M9 Task 6: WebBucket's autoDeleteObjects adds a 6th, CDK-MANAGED Lambda — the singleton
    // Custom::S3AutoDeleteObjects provider — which is not one of our 5 application entry points.
    // Arc B Task 5: the ops dashboard's Logs Insights widget reads `httpFn.logGroup`. This
    // template is built with the `@aws-cdk/aws-lambda:useCdkManagedLogGroup` context flag on
    // (matching cdk.json, which a real `cdk synth`/`cdk deploy` always loads), so every
    // application function already gets its own CDK-managed `AWS::Logs::LogGroup` at
    // construction time and `.logGroup` never falls back to the legacy `Custom::LogRetention`
    // mechanism — the count here matches the real deployed stack exactly.
    it("has exactly 6 Lambda functions total (5 application functions + the CDK-managed WebBucket auto-delete-objects custom resource provider, M9 Task 6)", () => {
      template.resourceCountIs("AWS::Lambda::Function", 6);
    });

    it("every application function is Node 20 (the CDK-managed auto-delete-objects provider's runtime is CDK's own choice, not this stack's)", () => {
      const entries = appFunctions();
      expect(entries.length).toBe(5);
      for (const [, fn] of entries) {
        expect(fn.Properties.Runtime).toBe("nodejs20.x");
      }
    });

    it("http/wsConnect/wsDisconnect each carry the five required env keys", () => {
      const entries = originalFunctions();
      expect(entries.length).toBe(3);
      for (const [, fn] of entries) {
        const variables = fn.Properties.Environment.Variables;
        for (const key of ENV_KEYS) {
          expect(Object.keys(variables)).toContain(key);
        }
      }
    });

    // Task 4: the plaintext delivery path is GONE from the template, not just deprioritized —
    // TOKEN_SECRET_ARN is a plain CloudFormation Ref to the Secret resource (resolved at
    // deploy time to the secret's ARN string, never its value), and no function's env carries
    // a "TOKEN_SECRET" key — plaintext OR a `{{resolve:secretsmanager:...}}` dynamic
    // reference — anywhere in the synthesized template at all.
    it("http/wsConnect/wsDisconnect's TOKEN_SECRET_ARN is a Ref to the secret, never a plaintext value or a dynamic reference; TOKEN_SECRET (the value key) is gone", () => {
      const secrets = template.findResources("AWS::SecretsManager::Secret");
      const secretLogicalId = Object.keys(secrets).find((id) => id.startsWith("TokenSecret"));
      expect(secretLogicalId).toBeDefined();

      const entries = originalFunctions();
      expect(entries.length).toBe(3);
      for (const [, fn] of entries) {
        const variables = fn.Properties.Environment.Variables as Record<string, unknown>;
        expect(variables).not.toHaveProperty("TOKEN_SECRET");
        expect(variables["TOKEN_SECRET_ARN"]).toEqual({ Ref: secretLogicalId });
        // A dynamic reference (the OTHER way CDK can resolve a secret into a string) never
        // appears anywhere in this key's value — Ref is a template-time pointer, not the
        // secret's value baked in at synth.
        expect(JSON.stringify(variables["TOKEN_SECRET_ARN"])).not.toContain("resolve:secretsmanager");
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

    // Accounts-only identity (spec §7): three functions carry TABLE_CORE now — httpFn (its whole
    // golfer/course/crew surface), plus projectorFn and rebuildFn, which read each participant's
    // golfer row (on the core table) to project only account-bound golfers. wsConnect/wsDisconnect
    // still never touch it. `Environment?.Variables` (not a bare `.Environment.Variables`): the M9
    // Task 6 auto-delete-objects Lambda carries NO Environment property at all — a bare access
    // would throw TypeError on it rather than just correctly reporting "no TABLE_CORE here".
    it("exactly three functions (http, projector, rebuild) carry TABLE_CORE", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const withTableCore = Object.values(functions).filter((fn) => "TABLE_CORE" in ((fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>));
      expect(withTableCore).toHaveLength(3);
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

    // Accounts-only identity (spec §7): the projector reads golfer rows on the core table to
    // project only account-bound golfers, so its env is TABLE_PROJECTIONS + TABLE_CORE now (still
    // no TOKEN_SECRET/WS_ENDPOINT it has no use for). Its event source (the snapshots stream) is
    // unchanged — the archive rides in the stream record, not read by table name.
    it("ProjectorFunction: 15s/512MB, TABLE_PROJECTIONS + TABLE_CORE (no TOKEN_SECRET/WS_ENDPOINT it has no use for)", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const id = Object.keys(functions).find((key) => key.startsWith("ProjectorFunction"));
      expect(id).toBeDefined();
      const fn = functions[id!]!;
      expect(fn.Properties.Timeout).toBe(15);
      expect(fn.Properties.MemorySize).toBe(512);
      expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual(["TABLE_CORE", "TABLE_PROJECTIONS"]);
    });

    // Snapshot realignment Task 1: TABLE_ROUNDS is GONE (the rebuild backfills from the snapshots
    // table's own page() instead). Accounts-only identity (spec §7): TABLE_CORE joins TABLE_SNAPSHOTS
    // + TABLE_PROJECTIONS — the replay goes through the SAME projectArchive that reads golfer rows.
    it("RebuildFunction: a longer timeout than the request-shaped functions (a full-table replay, not a single request), TABLE_PROJECTIONS + TABLE_SNAPSHOTS + TABLE_CORE", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      const id = Object.keys(functions).find((key) => key.startsWith("RebuildFunction"));
      expect(id).toBeDefined();
      const fn = functions[id!]!;
      expect(fn.Properties.Timeout).toBe(300);
      expect(fn.Properties.MemorySize).toBe(512);
      expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual(["TABLE_CORE", "TABLE_PROJECTIONS", "TABLE_SNAPSHOTS"]);
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

    // D4b (pre-prod hardening spec): a deterministically-throwing stream record must not block
    // its shard for 24h and then vanish with its batchmates — bisect isolates the poison
    // record, bounded retries hand it to the DLQ instead of retrying for a full day.
    it("the projector event source bisects on error, bounds retries, and dead-letters to SQS", () => {
      const queues = template.findResources("AWS::SQS::Queue");
      const dlqLogicalId = Object.keys(queues).find((id) => id.startsWith("ProjectorDlq"));
      expect(dlqLogicalId).toBeDefined();

      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        BisectBatchOnFunctionError: true,
        MaximumRetryAttempts: 10,
        DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": [dlqLogicalId, "Arn"] } } },
      });
    });

    // The DLQ message is stream METADATA (shard + sequence range), not the record payload — the
    // queue is a signal + bookmark, never a replay source (recovery is fix-the-bug then re-drive
    // via rebuildProjections). 14-day retention just needs to outlive a normal investigation.
    it("ProjectorDlq: named swng-projector-dlq-beta, 14-day retention", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "swng-projector-dlq-beta",
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
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
      // of [tableArn, indexArns]), the projections table has none — CDK still wraps the lone
      // Fn::GetAtt in a single-element array (aws-cdk-lib >=2.260: Resource is always an
      // array, GSIs or not), so this asserts a one-element `Match.arrayWith` rather than a
      // bare object.
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:PutItem"]),
              Resource: Match.arrayWith([Match.objectLike({ "Fn::GetAtt": [projectionsTableLogicalId, "Arn"] })]),
            }),
          ]),
        }),
      });
    });

    // Snapshot realignment Task 1: the rebuild reads the snapshots table now, not the rounds
    // table — same read-only shape as before (no write actions), new table. No GSIs on this
    // table, so Resource is a single Fn::GetAtt wrapped in a one-element array (aws-cdk-lib
    // >=2.260: Resource is always an array, GSIs or not) — the projections-table test's shape
    // above, not the core table's array-of-[tableArn, indexArns].
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

      // Find the statement(s) that cover the snapshots table and assert read-only. aws-cdk-lib
      // >=2.260 splits a table grant's stream-read actions (GetRecords/GetShardIterator) into
      // their OWN statement, separate from the CRUD-read statement (GetItem/Query/Scan/...) —
      // same total permissions as before, just laid out across two statements instead of one.
      // So: assert no write action on ANY statement covering this table (stronger — covers
      // both statements), but only require GetItem on the CRUD statement, not the stream-only
      // one.
      let foundStatement = false;
      for (const policy of rebuildPolicies) {
        const statements = (policy.Properties.PolicyDocument.Statement ?? []) as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>;
        for (const statement of statements) {
          const stmtResourceStr = JSON.stringify(statement.Resource);
          if (stmtResourceStr.includes(snapshotsTableLogicalId!)) {
            const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
            // Assert no write actions on any statement touching this table.
            const writeActions = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"];
            for (const writeAction of writeActions) {
              expect(actions).not.toContain(writeAction);
            }
            // The CRUD-read statement (not the stream-only one) is the one that must carry
            // GetItem — that's the statement this test is actually pinning.
            if (actions.includes("dynamodb:GetItem")) foundStatement = true;
          }
        }
      }
      expect(foundStatement, "snapshots table CRUD-read statement not found in rebuildFn's policies").toBe(true);
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
              Resource: Match.arrayWith([Match.objectLike({ "Fn::GetAtt": [snapshotsTableLogicalId, "Arn"] })]),
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

    // Task 4: httpFn/wsConnectFn/wsDisconnectFn are the only three functions that call
    // buildApp (compositionRoot.ts) — grantRead(fn) narrows secretsmanager:GetSecretValue to
    // exactly their roles, same resolve-the-real-logical-id idiom as the table tests above.
    it("httpFn/wsConnectFn/wsDisconnectFn each have a secretsmanager:GetSecretValue policy statement on the token secret", () => {
      const secrets = template.findResources("AWS::SecretsManager::Secret");
      const secretLogicalId = Object.keys(secrets).find((id) => id.startsWith("TokenSecret"));
      expect(secretLogicalId).toBeDefined();

      const functions = template.findResources("AWS::Lambda::Function");
      for (const prefix of ["HttpFunction", "WsConnectFunction", "WsDisconnectFunction"]) {
        const fnId = Object.keys(functions).find((id) => id.startsWith(prefix));
        expect(fnId, `${prefix} not found`).toBeDefined();
        const roleRef = functions[fnId!]!.Properties.Role as { "Fn::GetAtt": [string, string] };
        const roleLogicalId = roleRef["Fn::GetAtt"][0];

        const policies = template.findResources("AWS::IAM::Policy");
        const rolePolicies = Object.values(policies).filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId));
        expect(rolePolicies.length, `${prefix} has no policies at all`).toBeGreaterThan(0);

        let found = false;
        for (const policy of rolePolicies) {
          const statements = (policy.Properties.PolicyDocument.Statement ?? []) as Array<{ Action?: string | string[]; Resource?: unknown }>;
          for (const statement of statements) {
            const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
            if (actions.includes("secretsmanager:GetSecretValue") && JSON.stringify(statement.Resource).includes(secretLogicalId!)) {
              found = true;
            }
          }
        }
        expect(found, `${prefix}'s role has no secretsmanager:GetSecretValue statement on the token secret`).toBe(true);
      }
    });

    // projectorFn/rebuildFn never call buildApp and never carry TOKEN_SECRET_ARN in their env
    // (swngStack.ts's own comment on their minimal NodejsFunctions above) — this asserts the
    // grant is absent too, not just unread, the same "the grant is gone, not just the env var"
    // shape as the rounds-table test just above.
    it("projectorFn/rebuildFn carry no secretsmanager:GetSecretValue policy at all", () => {
      const functions = template.findResources("AWS::Lambda::Function");
      for (const prefix of ["ProjectorFunction", "RebuildFunction"]) {
        const fnId = Object.keys(functions).find((id) => id.startsWith(prefix));
        expect(fnId, `${prefix} not found`).toBeDefined();
        const roleRef = functions[fnId!]!.Properties.Role as { "Fn::GetAtt": [string, string] };
        const roleLogicalId = roleRef["Fn::GetAtt"][0];

        const policies = template.findResources("AWS::IAM::Policy");
        const rolePolicies = Object.values(policies).filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId));
        for (const policy of rolePolicies) {
          expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain("secretsmanager:GetSecretValue");
        }
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

    // Managed login v2, branded from @swng/brand (2026-07-23). The domain renders the managed-login
    // pages; the pool must be on Essentials (managed login requires it); the branding style paints
    // them swng — light mode + a FORM_LOGO wordmark, not Cognito's blue defaults.
    it("turns the domain on to Managed Login v2 and the pool onto the Essentials plan", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolDomain", { ManagedLoginVersion: 2 });
      template.hasResourceProperties("AWS::Cognito::UserPool", { UserPoolTier: "ESSENTIALS" });
    });

    it("provisions one swng branding style: light mode + a FORM_LOGO svg, not Cognito defaults", () => {
      template.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 1);
      template.hasResourceProperties("AWS::Cognito::ManagedLoginBranding", {
        UseCognitoProvidedValues: false,
        Settings: Match.objectLike({
          categories: Match.objectLike({ global: Match.objectLike({ colorSchemeMode: "LIGHT" }) }),
        }),
        Assets: Match.arrayWith([Match.objectLike({ Category: "FORM_LOGO", Extension: "SVG" })]),
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

    it("wires all thirty-nine HTTP routes (38 + GET /me/courses/{courseId}/record — the all-time analytics read, GET /crews/{crewId}/records, is deleted whole, spec 2026-07-22 §4)", () => {
      const expectedRouteKeys = [
        "POST /rounds",
        "POST /rounds/join",
        "POST /rounds/{roundId}/games",
        "POST /rounds/{roundId}/scores",
        "POST /rounds/{roundId}/finalize",
        // task-15: scrap a round — a terminal event that produces no snapshot.
        "POST /rounds/{roundId}/abandon",
        // accounts-only identity spec §4: a participant walks off (self-only, participant-gated).
        "POST /rounds/{roundId}/leave",
        // spec 2026-07-30 §2: any participant sets any participant's strokes (score-for-anyone,
        // participant-gated).
        "POST /rounds/{roundId}/strokes",
        "GET /rounds/{roundId}/events",
        // M9 Task 3 (share): mints this round's immortal spectator link.
        "POST /rounds/{roundId}/share",
        // Projection-realignment Task 6: the settled snapshot's own event log.
        "GET /rounds/{roundId}/archive",
        // Architecture-realignment Task 14: the participant-token re-mint.
        "POST /rounds/{roundId}/token",
        "GET /rounds/peek",
        // Course-cards spec §4: the M6 add-tee/verify routes are gone — one whole-card
        // supersession (PUT /courses/{courseId}) replaces both.
        "POST /courses",
        "PUT /courses/{courseId}",
        "GET /courses/{courseId}",
        "GET /courses",
        // M7 Task 5: game/round termination + the golfer identity surface.
        "POST /rounds/{roundId}/games/{gameId}/terminate",
        "GET /me",
        "PUT /me",
        "GET /me/record",
        // Analytics spec 2026-07-21 §4: "your record here" — filtered to one course.
        "GET /me/courses/{courseId}/record",
        // Projection-realignment Task 6: "list my rounds".
        "GET /me/rounds",
        // Projection-realignment Task 13: "your rounds, right now" — presence.
        "GET /me/rounds/live",
        // Navigation spec §6a: the golfer page's read — any signed-in golfer, not self-scoped.
        "GET /golfers/{golferId}",
        // M8 Task 4: crews (POST /rounds, POST /rounds/join above are unchanged route keys —
        // accounts-only identity spec §3 only moved their auth tier). Crew membership
        // (invited in, accountable out): POST /crews/{crewId}/members (add-by-id) is gone;
        // POST /crews/{crewId}/invites (mint) and POST /crews/peek (the "none"-auth preview)
        // replace it.
        "POST /crews",
        "POST /crews/join",
        "POST /crews/peek",
        "GET /me/crews",
        "GET /crews/{crewId}",
        // Spec 2026-07-22 "the season is the record" §2: the crew name is editable.
        "PUT /crews/{crewId}",
        "POST /crews/{crewId}/invites",
        // Architecture-realignment Task 9: crew seasons + counted rounds + standings + leave.
        "POST /crews/{crewId}/seasons",
        "GET /crews/{crewId}/seasons",
        // Spec 2026-07-22 "the season is the record" §2: editing the end date IS the whole
        // lifecycle — this ONE PUT replaces the deleted close/reopen verbs.
        "PUT /crews/{crewId}/seasons/{seasonId}",
        "GET /crews/{crewId}/seasons/{seasonId}/standings",
        "POST /crews/{crewId}/leave",
        // Crew membership (invited in, accountable out — spec §1): the organizer's authority.
        "DELETE /crews/{crewId}/members/{golferId}",
        "POST /crews/{crewId}/transfer",
      ];
      const routes = template.findResources("AWS::ApiGatewayV2::Route");
      const routeKeys = Object.values(routes).map((route) => route.Properties.RouteKey);
      for (const expected of expectedRouteKeys) {
        expect(routeKeys).toContain(expected);
      }
    });

    // Pins the total route count exactly (39 HTTP + $connect + $disconnect): the two tests
    // above each check membership, neither pins the count, so a stray extra route (or one
    // silently dropped) could pass both without this.
    it("has exactly 41 routes total (39 HTTP + $connect + $disconnect)", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Route", 41);
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

    // Prod-readiness hardening Arc A, Task 6: CORS scoped off "*" to the real web origins.
    // localhost:4173 is GATE-CRITICAL — `pnpm e2e:field` (a close-out gate) serves the built web
    // app from `vite preview` on this exact port (apps/web/playwright.config.ts) and calls the
    // deployed beta API cross-origin; omitting it here fails that gate on CORS. The raw
    // cloudfront.net URL (the legacy direct-access origin, M9 Task 6) must also survive scoping.
    it("the HTTP API's CORS allowOrigins is the scoped web-origin set — dev, the e2e:field preview port, and cloudfront.net — never '*'", () => {
      const apis = template.findResources("AWS::ApiGatewayV2::Api");
      const httpApi = Object.values(apis).find((api) => api.Properties.ProtocolType === "HTTP");
      expect(httpApi).toBeDefined();
      const allowOrigins = httpApi!.Properties.CorsConfiguration.AllowOrigins as string[];
      expect(allowOrigins).not.toContain("*");
      expect(allowOrigins).toContain("http://localhost:5173");
      expect(allowOrigins).toContain("http://localhost:4173");
      expect(allowOrigins).toContain("https://d5qqgppnyb7y1.cloudfront.net");
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

    // The tightened routes get the tighter rate 5 / burst 10 ceiling — POST /rounds (golfer-gated
    // now but kept in the set as an abuse-sensitive round-entry route) and GET /courses/{courseId}
    // (a "none"-auth course route) each pinned individually, plus a full-membership check below
    // that every one of the 8 keys is present with the same values (a single Match.objectLike would
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

    it("all 8 tightened routes carry the tighter throttle, and no others are present in RouteSettings", () => {
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
  // repeating the same AlarmActions assertion by hand for all of them. Prod-readiness Arc B
  // Task 4 reworked the set (3 retained: IteratorAge + DLQ depth + Rebuild duration; reshaped:
  // HTTP 5xx; added: HTTP p95 latency + WAF blocked + signup spike). Task 6 (outbox-drain arc)
  // added an 8th: LateScoreRefused.
  describe("alarms (M9 Task 5, D4b, Arc B Task 4)", () => {
    it("has exactly 8 CloudWatch alarms (3 retained: IteratorAge + DLQ depth + Rebuild duration; reshaped: HTTP 5xx; added: HTTP p95 latency + WAF blocked + signup spike + late score refused)", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 8);
    });

    it("every alarm's AlarmActions targets the one AlarmsTopic (no alarm silently rings nowhere)", () => {
      const topics = template.findResources("AWS::SNS::Topic");
      const topicLogicalId = Object.keys(topics).find((id) => id.startsWith("AlarmsTopic"));
      expect(topicLogicalId).toBeDefined();

      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const alarmEntries = Object.entries(alarms);
      expect(alarmEntries.length).toBe(8);
      for (const [, alarm] of alarmEntries) {
        expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicLogicalId }]);
      }
    });

    it("the HTTP API 5xx alarm: AWS/ApiGateway 5xx, threshold 10, 2 of 3 five-minute windows", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/ApiGateway",
        MetricName: "5xx",
        Statistic: "Sum",
        Period: 300,
        Threshold: 10,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });

    it("the HTTP API p95-latency alarm: AWS/ApiGateway Latency, p95, > 3000ms, 2 of 3", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/ApiGateway",
        MetricName: "Latency",
        ExtendedStatistic: "p95",
        Threshold: 3000,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        ComparisonOperator: "GreaterThanThreshold",
      });
    });

    it("the WAF blocked-requests alarm: a math expression over AWS/WAFV2 BlockedRequests, threshold 100", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const waf = Object.values(alarms).filter((a) =>
        (a.Properties.AlarmDescription as string | undefined)?.includes("blocked"),
      );
      expect(waf).toHaveLength(1);
      expect(waf[0]!.Properties.Threshold).toBe(100);
      expect(Array.isArray(waf[0]!.Properties.Metrics)).toBe(true); // math expression → Metrics[]
    });

    it("the signup-spike alarm: swng namespace Signups, threshold 50", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "swng",
        MetricName: "Signups",
        Statistic: "Sum",
        Threshold: 50,
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

    it("alarms on any late score refused — a played score missing from a settled archive", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "swng",
        MetricName: "LateScoreRefused",
        Statistic: "Sum",
        Period: 900,
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });

    // D4b: a non-empty DLQ means a poisoned snapshots-stream record needs a human — page on
    // ANY depth above zero, not a batch-sized threshold, since one message already means the
    // fix-then-rebuildProjections cycle above is needed.
    it("a non-empty projector DLQ pages: threshold 0, strictly greater-than, description mentions the DLQ", () => {
      // Metric identity pinned too (the file's own single-metric bar, same as the
      // IteratorAge/Duration alarms above): a future edit repointing this alarm at a
      // different metric — or a Sum where a gauge needs Maximum — must fail here, not
      // page-silently-never in production.
      template.hasResourceProperties(
        "AWS::CloudWatch::Alarm",
        Match.objectLike({
          AlarmDescription: Match.stringLikeRegexp("DLQ"),
          Namespace: "AWS/SQS",
          MetricName: "ApproximateNumberOfMessagesVisible",
          Statistic: "Maximum",
          Threshold: 0,
          ComparisonOperator: "GreaterThanThreshold",
        }),
      );
    });
  });

  describe("stage-vs-route deploy ordering (crew membership's POST /crews/peek incident)", () => {
    // RouteSettings names routes by KEY string, not CloudFormation ref, so nothing implicit
    // orders the stage update after route creation — the first deploy that added a brand-new
    // route to ANON_THROTTLED_ROUTES wedged the stack in UPDATE_ROLLBACK_FAILED when the
    // stage's settings named a route that didn't exist yet. This pins the structural fix: the
    // HTTP default stage declares DependsOn on EVERY route resource, so its settings can never
    // apply before the routes they name exist.
    it("the HTTP default stage DependsOn every HTTP route resource", () => {
      const routes = template.findResources("AWS::ApiGatewayV2::Route");
      const stages = template.findResources("AWS::ApiGatewayV2::Stage");
      const httpStageEntry = Object.entries(stages).find(([, stage]) => stage.Properties.StageName === "$default");
      expect(httpStageEntry, "no $default HTTP stage found").toBeDefined();
      const dependsOn: readonly string[] = httpStageEntry![1].DependsOn ?? [];
      // Every HTTP-API route (routes whose ApiId resolves to the HttpApi) must appear; the
      // WebSocket routes belong to a different api/stage pair and are not required here. The
      // HTTP route count is HTTP_ROUTES.length, so requiring that many route ids in DependsOn
      // pins full coverage without hardcoding a single hashed logical id.
      const httpRouteIds = Object.keys(routes).filter((id) => id.startsWith("HttpApi"));
      expect(httpRouteIds.length).toBe(HTTP_ROUTES.length);
      for (const id of httpRouteIds) {
        expect(dependsOn, `stage missing DependsOn ${id}`).toContain(id);
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

    // Task 6: the CSP grows two directives beyond what M9 Task 6 shipped — clickjacking
    // defense-in-depth (frame-ancestors, redundant with the FrameOptions header below by
    // design — belt and suspenders) and a base-uri lockdown against injected <base> retargeting.
    it("the CSP includes frame-ancestors 'none' and base-uri 'self'", () => {
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policyEntries = Object.values(policies);
      expect(policyEntries).toHaveLength(1);
      const securityHeaders = policyEntries[0]!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
      const rendered = JSON.stringify(securityHeaders.ContentSecurityPolicy.ContentSecurityPolicy);
      expect(rendered).toContain("frame-ancestors 'none'");
      expect(rendered).toContain("base-uri 'self'");
    });

    // Task 6: before this, the response headers policy carried ONLY the CSP — HSTS, nosniff,
    // a referrer policy, and frame-options were simply absent from every response CloudFront
    // served. Each new header's exact rendered CFN shape is pinned (not just "is present"), the
    // same discipline the rest of this suite applies to every other CDK prop mapping.
    it("the response headers policy carries HSTS, X-Content-Type-Options nosniff, a referrer policy, and frameOptions DENY", () => {
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policyEntries = Object.values(policies);
      expect(policyEntries).toHaveLength(1);
      const securityHeaders = policyEntries[0]!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;

      // 365 days in seconds — CloudFront's StrictTransportSecurity.AccessControlMaxAgeSec is a
      // raw number, not a Duration token, once synthesized.
      expect(securityHeaders.StrictTransportSecurity).toMatchObject({
        AccessControlMaxAgeSec: 365 * 24 * 60 * 60,
        IncludeSubdomains: true,
        Override: true,
      });
      expect(securityHeaders.ContentTypeOptions).toEqual({ Override: true });
      expect(securityHeaders.ReferrerPolicy).toEqual({
        ReferrerPolicy: "strict-origin-when-cross-origin",
        Override: true,
      });
      expect(securityHeaders.FrameOptions).toEqual({ FrameOption: "DENY", Override: true });
    });
  });

  // Prod-readiness hardening Arc A, Task 5: AWS WAF rate-limiting on the head of the abuse
  // chain — account creation (Cognito) and the web edge (CloudFront). TWO DISTINCT WebACLs are
  // required, not one: CloudFront is a CLOUDFRONT-scope resource wired via the Distribution's own
  // `webAclId` prop (a CloudFront ACL is never attached via an association); a Cognito user pool
  // is a REGIONAL WAF resource, wired via a real AWS::WAFv2::WebACLAssociation — a CLOUDFRONT-scope
  // ACL cannot associate to a user pool, and a REGIONAL-scope ACL cannot be a distribution's
  // webAclId. Both carry the same IP rate-based rule (RATE_LIMIT_PER_5MIN in swngStack.ts — a
  // generous, adjustable ceiling vs. a real crew's ~1 rps).
  describe("WAF rate-limiting (Task 5, prod-readiness hardening Arc A)", () => {
    it("has exactly two WebACLs: one CLOUDFRONT-scope, one REGIONAL-scope, each with an IP rate-based rule limiting to 2000 per 5 min", () => {
      template.resourceCountIs("AWS::WAFv2::WebACL", 2);

      for (const scope of ["CLOUDFRONT", "REGIONAL"]) {
        template.hasResourceProperties("AWS::WAFv2::WebACL", {
          Scope: scope,
          DefaultAction: { Allow: {} },
          Rules: Match.arrayWith([
            Match.objectLike({
              Name: "RateLimit",
              Priority: 0,
              Action: { Block: {} },
              Statement: Match.objectLike({
                RateBasedStatement: Match.objectLike({ AggregateKeyType: "IP", Limit: 2000 }),
              }),
            }),
          ]),
        });
      }
    });

    // CloudWatch metric names must be unique per ACL — a collision would silently merge two
    // ACLs' metrics into one CloudWatch series. These are also the exact names the next arc
    // (Arc B's abuse-shape alarm) reads.
    it("the two WebACLs (and their rate rules) carry distinct, stage-suffixed metric names", () => {
      const acls = template.findResources("AWS::WAFv2::WebACL");
      const entries = Object.values(acls);
      expect(entries).toHaveLength(2);

      const aclMetricNames = entries.map((acl) => (acl.Properties.VisibilityConfig as { MetricName: string }).MetricName);
      expect(new Set(aclMetricNames).size).toBe(2);
      expect(aclMetricNames.sort()).toEqual(["swng-waf-cf-beta", "swng-waf-cognito-beta"]);

      const ruleMetricNames = entries.map((acl) => {
        const rules = acl.Properties.Rules as Array<{ VisibilityConfig: { MetricName: string } }>;
        expect(rules).toHaveLength(1);
        return rules[0]!.VisibilityConfig.MetricName;
      });
      expect(new Set(ruleMetricNames).size).toBe(2);
      expect(ruleMetricNames.sort()).toEqual(["swng-waf-cf-rate-beta", "swng-waf-cognito-rate-beta"]);
    });

    it("the CloudFront WebACL is wired onto the distribution via WebACLId (never a WebACLAssociation)", () => {
      const acls = template.findResources("AWS::WAFv2::WebACL");
      const cfAclLogicalId = Object.entries(acls).find(([, acl]) => acl.Properties.Scope === "CLOUDFRONT")?.[0];
      expect(cfAclLogicalId).toBeDefined();

      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({ WebACLId: { "Fn::GetAtt": [cfAclLogicalId, "Arn"] } }),
      });
    });

    it("the REGIONAL WebACL is associated with the Cognito user pool via a real WebACLAssociation", () => {
      const acls = template.findResources("AWS::WAFv2::WebACL");
      const regionalAclLogicalId = Object.entries(acls).find(([, acl]) => acl.Properties.Scope === "REGIONAL")?.[0];
      expect(regionalAclLogicalId).toBeDefined();

      const userPoolLogicalId = findLogicalId("AWS::Cognito::UserPool");

      template.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
      template.hasResourceProperties("AWS::WAFv2::WebACLAssociation", {
        ResourceArn: { "Fn::GetAtt": [userPoolLogicalId, "Arn"] },
        WebACLArn: { "Fn::GetAtt": [regionalAclLogicalId, "Arn"] },
      });
    });
  });

  describe("ops dashboard (Arc B)", () => {
    it("creates exactly one dashboard named swng-ops-<stage>", () => {
      template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
      template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
        DashboardName: Match.stringLikeRegexp("swng-ops-beta"),
      });
    });

    // DashboardBody does NOT synthesize as a plain string here: several widgets reference real
    // constructs (httpApi's ApiId, projectorFn's FunctionName, projectorDlq's QueueName,
    // httpFn.logGroup's LogGroupName) — genuine unresolved CloudFormation tokens at synth time
    // — so CDK renders the whole property as `{ "Fn::Join": ["", [...]] }`, splitting literal
    // JSON fragments around each `Ref`/`Fn::GetAtt`. `Match.stringLikeRegexp` only accepts a
    // literal string actual value (verified against aws-cdk-lib's StringLikeRegexpMatch, which
    // records a type-mismatch failure and never coerces an object), so it can't be pointed at
    // DashboardBody directly the way the business-only widgets (no token references) could.
    // Stringifying the whole (structurally real) synthesized value and asserting the literal
    // metric name / query text still appears preserves the same intent — the dashboard really
    // does carry these — without asserting a shape the correct implementation can't produce.
    it("the dashboard body references the business metrics and the DAU query", () => {
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const body = JSON.stringify(Object.values(dashboards)[0]!.Properties.DashboardBody);
      expect(body).toMatch(/RoundsCreated/);
      expect(body).toMatch(/activeGolfers/);
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

// Task D-T1 (docs/.../task-D-T1-brief.md): beta.swng.golf — the optional `web` prop. This is a
// SECOND, deliberate `Template.fromStack` (the file's own comment on `template` above flags
// synthesis as this suite's expensive part specifically because it's normally shared across
// every `it`) — the `web` prop changes cert/alias/Cognito-URL output in ways that would either
// contaminate the shared prop-less `template` above or require every one of ITS assertions to
// branch on a prop it was built to prove is byte-identical without. Paying synth once more here,
// scoped to this one describe, keeps that proof intact: `template` above (and the rest of the
// file) stays completely unmodified, and its continued green run IS the "absent web prop ⇒
// byte-identical synth" pin the plan calls for.
describe("SwngStack with a configured web domain (Task D-T1: beta.swng.golf)", () => {
  const WEB_BETA = { domainName: "beta.swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" };
  const webTemplate = Template.fromStack(
    new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-beta", { stage: "beta", web: WEB_BETA }),
  );

  // Same resolve-the-real-logical-id idiom as `findLogicalId` above, generalized over which
  // template it queries (that helper is closed over the shared prop-less `template`).
  const findLogicalIdIn = (tpl: Template, resourceType: string, predicate?: (properties: Record<string, unknown>) => boolean): string => {
    const resources = tpl.findResources(resourceType);
    const entry = predicate ? Object.entries(resources).find(([, resource]) => predicate(resource.Properties)) : Object.entries(resources)[0];
    expect(entry, `no ${resourceType} resource found matching the predicate`).toBeDefined();
    return entry![0];
  };

  // Global Constraints: the POC's existing issued cert for beta.swng.golf is NOT reused — this
  // stack mints its own, independent of the POC's lifecycle. DNS validation against the pinned
  // zone; ACM's validation CNAME is per-account-per-domain identical to the one the POC's own
  // cert already satisfies, so this cert validates with no new manual DNS step.
  it("mints its own ACM certificate for beta.swng.golf, DNS-validated in the pinned zone", () => {
    webTemplate.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    webTemplate.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "beta.swng.golf",
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: "beta.swng.golf", HostedZoneId: "Z00936512AJC1HGD9M7B7" }],
    });
  });

  it("the distribution's Aliases carries beta.swng.golf and its ViewerCertificate references the minted certificate", () => {
    const certLogicalId = findLogicalIdIn(webTemplate, "AWS::CertificateManager::Certificate");
    webTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["beta.swng.golf"],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: { Ref: certLogicalId } }),
      }),
    });
  });

  // The distribution's own logical id must not change even once the web prop is set — an id
  // change would replace the resource (a new physical distribution, a new cloudfront.net URL),
  // which the plan's own Global Constraints forbids (other docs/tests reference the existing
  // cloudfront.net URL as a stable fact).
  it("the distribution's construct id is still \"WebDistribution\" (in-place alias/cert update, never a replacement)", () => {
    const distributions = webTemplate.findResources("AWS::CloudFront::Distribution");
    expect(Object.keys(distributions).some((id) => id.startsWith("WebDistribution"))).toBe(true);
    webTemplate.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("Route 53 A and AAAA alias records for beta.swng.golf. target the distribution, in the pinned hosted zone", () => {
    const distributionLogicalId = findLogicalIdIn(webTemplate, "AWS::CloudFront::Distribution");
    const sharedProps = {
      AliasTarget: Match.objectLike({ DNSName: { "Fn::GetAtt": [distributionLogicalId, "DomainName"] } }),
      HostedZoneId: "Z00936512AJC1HGD9M7B7",
      Name: "beta.swng.golf.",
    };
    webTemplate.hasResourceProperties("AWS::Route53::RecordSet", { ...sharedProps, Type: "A" });
    webTemplate.hasResourceProperties("AWS::Route53::RecordSet", { ...sharedProps, Type: "AAAA" });
    webTemplate.resourceCountIs("AWS::Route53::RecordSet", 2);
  });

  // Additive, not a swap: dev (localhost) and the existing cloudfront.net origin (M9 Task 6)
  // must both keep working once the custom domain is added — the SAME UserPoolClient, one more
  // pair of entries in the same L1 arrays.
  it("Cognito callback/logout URLs gain the domain's entries ALONGSIDE the distribution-domain and localhost entries", () => {
    webTemplate.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    const clients = webTemplate.findResources("AWS::Cognito::UserPoolClient");
    const props = Object.values(clients)[0]!.Properties as Record<string, unknown>;
    const callbackUrls = JSON.stringify(props.CallbackURLs);
    const logoutUrls = JSON.stringify(props.LogoutURLs);
    const distributionLogicalId = findLogicalIdIn(webTemplate, "AWS::CloudFront::Distribution");

    expect(callbackUrls).toContain("http://localhost:5173/auth/callback");
    expect(callbackUrls).toContain(distributionLogicalId);
    expect(callbackUrls).toContain("https://beta.swng.golf/auth/callback");

    expect(logoutUrls).toContain("http://localhost:5173/");
    expect(logoutUrls).toContain(distributionLogicalId);
    expect(logoutUrls).toContain("https://beta.swng.golf/");
  });

  it("outputs WebDomainUrl when a web domain is configured", () => {
    webTemplate.hasOutput("WebDomainUrl", { Value: "https://beta.swng.golf/" });
  });

  // Task 6: the custom domain's own origin joins the HTTP API's CORS allow-list too — cycle-free,
  // since it's built from `props.web.domainName` (a plain string), never
  // `distribution.distributionDomainName` (see swngStack.ts's own comment on why that reference
  // would be a real circular dependency). Dev and cloudfront.net stay present alongside it.
  it("the HTTP API's CORS allowOrigins also includes https://beta.swng.golf when a web domain is configured", () => {
    const apis = webTemplate.findResources("AWS::ApiGatewayV2::Api");
    const httpApi = Object.values(apis).find((api) => api.Properties.ProtocolType === "HTTP");
    expect(httpApi).toBeDefined();
    const allowOrigins = httpApi!.Properties.CorsConfiguration.AllowOrigins as string[];
    expect(allowOrigins).not.toContain("*");
    expect(allowOrigins).toContain("https://beta.swng.golf");
    expect(allowOrigins).toContain("http://localhost:5173");
    expect(allowOrigins).toContain("http://localhost:4173");
    expect(allowOrigins).toContain("https://d5qqgppnyb7y1.cloudfront.net");
  });
});

describe("stage config knobs (Arc C — prod hardening)", () => {
  // extraWebOrigins can't be [] here: the app client's OAuth flows are always on, and
  // callbackUrls comes straight from webOrigins.map(...) at UserPoolClient construction — CDK's
  // own UserPoolClient constructor rejects an empty callbackUrls list for a codeGrant client
  // (CallbackUrlEmptyCodeGrant) before synth even runs. A real prod deploy would supply its own
  // real origin(s) here (or lean on `web`'s domain, which lands on the SAME construct later via
  // an L1 patch, too late to satisfy this constructor-time check) — never an empty list with no
  // domain at all. A placeholder prod-shaped origin exercises the knob without hitting that.
  const hardened = Template.fromStack(
    new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-hardened", {
      stage: "hardened",
      userPasswordAuth: false,
      extraWebOrigins: ["https://hardened.example.com"],
      extraCorsOrigins: [],
    }),
  );
  it("drops ALLOW_USER_PASSWORD_AUTH from the app client when userPasswordAuth is false", () => {
    const clients = hardened.findResources("AWS::Cognito::UserPoolClient");
    const flows = Object.values(clients)[0]!.Properties.ExplicitAuthFlows as string[];
    expect(flows).not.toContain("ALLOW_USER_PASSWORD_AUTH");
  });
  it("carries no localhost or beta-cloudfront origin in the app client callback URLs", () => {
    const clients = hardened.findResources("AWS::Cognito::UserPoolClient");
    const callbacks = JSON.stringify(Object.values(clients)[0]!.Properties.CallbackURLs);
    expect(callbacks).not.toContain("localhost");
    expect(callbacks).not.toContain("d5qqgppnyb7y1");
  });
});

describe("SwngStack prod config (Arc C)", () => {
  const prod = Template.fromStack(
    new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-prod", {
      stage: "prod",
      web: { domainName: "swng.golf", hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" },
      userPasswordAuth: false,
      extraWebOrigins: [],
      extraCorsOrigins: [],
      passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      poolDeletionProtection: true,
      preventUserExistenceErrors: true,
    }),
  );
  it("app client has no ALLOW_USER_PASSWORD_AUTH", () => {
    const flows = Object.values(prod.findResources("AWS::Cognito::UserPoolClient"))[0]!.Properties.ExplicitAuthFlows as string[];
    expect(flows).not.toContain("ALLOW_USER_PASSWORD_AUTH");
  });
  it("pool has an explicit password policy (minLength 8) and deletion protection", () => {
    prod.hasResourceProperties("AWS::Cognito::UserPool", {
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 8, RequireNumbers: true, RequireSymbols: false }) },
      DeletionProtection: "ACTIVE",
    });
  });
  it("callback URLs include swng.golf and exclude localhost + beta cloudfront", () => {
    const callbacks = JSON.stringify(Object.values(prod.findResources("AWS::Cognito::UserPoolClient"))[0]!.Properties.CallbackURLs);
    expect(callbacks).toContain("https://swng.golf/auth/callback");
    expect(callbacks).not.toContain("localhost");
    expect(callbacks).not.toContain("d5qqgppnyb7y1");
  });
  it("pins PreventUserExistenceErrors to ENABLED on the app client", () => {
    const client = Object.values(prod.findResources("AWS::Cognito::UserPoolClient"))[0]!;
    expect(client.Properties.PreventUserExistenceErrors).toBe("ENABLED");
  });
});
