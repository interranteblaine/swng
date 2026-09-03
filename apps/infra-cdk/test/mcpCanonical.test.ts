import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  CALLBACK_PATH,
  CIMD_FETCH_FAILED,
  CONSENT_SUBMIT_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
  readScopeOf,
  writeScopeOf,
} from "@swng/lambda";
import { STAGE_CONFIG } from "../bin/infra-cdk.js";
import { SwngStack } from "../lib/swngStack.js";

// ---------------------------------------------------------------------------------------------
// The CANONICAL drift guard (swng-speaks-mcp design §4.3 / §8).
//
// `CANONICAL` is ONE string playing three roles: the MCP endpoint URL, the Cognito resource
// server identifier, and the PRM `resource`. The stack derives all of them from one expression,
// which is exactly why an equality test inside the stack would be unfalsifiable — `X === X` has
// no edit that turns it red.
//
// So this file types the canonical URI OUT IN FULL, once, and asserts it against the SYNTHESIZED
// TEMPLATE — the artifact a deploy actually produces. Every assertion below therefore bridges two
// independently authored places (this literal vs. the stack's derivation), which is the only
// shape of guard that can fail. Drift here is not a loud failure at deploy: per spec §4.2 F2 a
// `resource` that doesn't name a registered resource server still yields an authorization code,
// and that code is unredeemable with an ordinary `invalid_grant` pointing nowhere near the cause.
// ---------------------------------------------------------------------------------------------

const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const MCP_HOST = "mcp.beta.swng.golf";

// The same zone the web domain already lives in (bin/infra-cdk.ts's STAGE_CONFIG) — imported by
// the stack, never created by it.
const MCP_BETA = { domainName: MCP_HOST, hostedZoneId: "Z00936512AJC1HGD9M7B7", zoneName: "swng.golf" };

const template = Template.fromStack(
  new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-beta", {
    stage: "beta",
    mcp: MCP_BETA,
  }),
);

// Resolves a resource's logical id (never hardcode one of CDK's own hashed ids) — the same idiom
// swngStack.test.ts uses.
// Index a synthesized resource BY LOGICAL ID and narrow in one step. `findResources` returns a
// plain record, so every `[id]` lookup is `possibly undefined` to tsc — and the sites that used
// to index directly either carried that type into a property access or reached for `!`, which
// ASSERTS the very presence this file exists to VERIFY. Throwing here names the id, so a resource
// that genuinely disappears from the template fails as "no AWS::DynamoDB::Table with logical id X"
// rather than as a downstream "Cannot read properties of undefined" pointing at the wrong line.
// `Properties` is named because every caller reads it; the index signature carries the
// template's other top-level keys (`DeletionPolicy`, `UpdateReplacePolicy`) as `unknown`, so a
// caller states the shape it expects at the point it reads one, rather than this helper
// pretending to know every resource's schema.
type SynthesizedResource = { readonly Properties: Record<string, unknown>; readonly [key: string]: unknown };

const resourceById = (resourceType: string, logicalId: string): SynthesizedResource => {
  const resource: unknown = template.findResources(resourceType)[logicalId];
  if (resource === undefined) throw new Error(`no ${resourceType} with logical id ${logicalId} in the template`);
  // Checked, not asserted: `findResources` is typed `{ [key: string]: any }`, so claiming the
  // shape without looking would be the cast this repo rules out. Both failures name what is
  // missing, which is the whole value of reading the template by id in the first place.
  if (typeof resource !== "object" || resource === null || !("Properties" in resource)) {
    throw new Error(`${resourceType} ${logicalId} has no Properties block`);
  }
  return resource as SynthesizedResource;
};

const findLogicalId = (resourceType: string, predicate: (properties: Record<string, unknown>) => boolean): string => {
  const entry = Object.entries(template.findResources(resourceType)).find(([, resource]) => predicate(resource.Properties));
  expect(entry, `no ${resourceType} resource found matching the predicate`).toBeDefined();
  return entry![0];
};

const environmentOf = (logicalIdPrefix: RegExp): Record<string, unknown> => {
  const entry = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) => logicalIdPrefix.test(id));
  expect(entry, `no AWS::Lambda::Function with a logical id matching ${logicalIdPrefix}`).toBeDefined();
  return (entry![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};

// Every route key on the MCP API specifically — the stack has TWO HTTP APIs, and an assertion
// that read them together would pass on a route wired to the wrong one.
const mcpRouteKeys = (): string[] => {
  const apiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-mcp-beta");
  return Object.values(template.findResources("AWS::ApiGatewayV2::Route"))
    .filter((route) => (route.Properties.ApiId as { Ref?: string } | undefined)?.Ref === apiId)
    .map((route) => route.Properties.RouteKey as string);
};

// ---------------------------------------------------------------------------------------------
// WIRING, not properties (fix round 1, Important 3).
//
// Every assertion above this line reads ONE resource's properties. That is blind to the thing a
// CloudFormation template mostly IS — which resource points at which. Twelve mutations, each
// verified to change the synthesized template, passed all 26 of this file's original assertions:
// both IAM grants moved onto the other function, the whole CORS block deleted, both
// MCP_CLIENT_IDs pointed at the WEB app client, `POST /mcp` integrated to mcpAuth, all eight
// OAuth routes integrated to mcp, and the stage throttle removed. Every one of those deploys
// clean and is wrong in the account.
//
// The helpers below walk the references the template actually encodes, so a test can name the
// relationship instead of the property.
// ---------------------------------------------------------------------------------------------

// A route key -> the logical id of the Lambda it really invokes. Two hops, because that is how
// CloudFormation spells it: the route's `Target` names an integration by Ref, and the
// integration's `IntegrationUri` embeds an `Fn::GetAtt` on the function.
const functionIdForRouteKey = (routeKey: string): string => {
  const apiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-mcp-beta");
  const route = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).find(
    (r) => (r.Properties.ApiId as { Ref?: string } | undefined)?.Ref === apiId && r.Properties.RouteKey === routeKey,
  );
  expect(route, `no route on the MCP API with key ${routeKey}`).toBeDefined();

  const target = route!.Properties.Target as { "Fn::Join": [string, unknown[]] };
  const integrationRef = target["Fn::Join"][1].find((part): part is { Ref: string } => typeof part === "object" && part !== null && "Ref" in part);
  expect(integrationRef, `route ${routeKey} does not target an integration by Ref`).toBeDefined();

  const integration = resourceById("AWS::ApiGatewayV2::Integration", integrationRef!.Ref);
  expect(integration, `route ${routeKey} targets an integration that is not in the template`).toBeDefined();

  // Recurse for the function ARN rather than matching a fixed shape. `IntegrationUri` has two
  // spellings — a bare `Fn::GetAtt` and an `Fn::Join` embedding one inside the full apigateway ARN
  // — and which one CDK emits is an implementation detail of the integration construct, not
  // something this file should encode. (Honest note, re-review Minor I: every call site here
  // filters to the MCP API, whose integrations all use the bare form, so the join case is
  // unreached today. It is generality, not a guard against an observed hazard.)
  const functionArnGetAtt = (node: unknown): string | undefined => {
    if (Array.isArray(node)) return node.map(functionArnGetAtt).find((id) => id !== undefined);
    if (typeof node !== "object" || node === null) return undefined;
    const entries = Object.entries(node as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (key === "Fn::GetAtt" && Array.isArray(value) && value[1] === "Arn" && typeof value[0] === "string") return value[0];
      const nested = functionArnGetAtt(value);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const functionId = functionArnGetAtt(integration.Properties.IntegrationUri);
  expect(functionId, `the integration for ${routeKey} does not invoke a function by Fn::GetAtt`).toBeDefined();
  expect(template.findResources("AWS::Lambda::Function")[functionId!], `${routeKey} points at ${functionId}, which is not a Lambda function`).toBeDefined();
  return functionId!;
};

// The inline policy attached to ONE function's role — found through the role's own logical id
// rather than the policy's, so this never hardcodes one of CDK's hashes.
const policyStatementsFor = (roleIdPrefix: RegExp): Array<Record<string, unknown>> => {
  const roleId = Object.keys(template.findResources("AWS::IAM::Role")).find((id) => roleIdPrefix.test(id));
  expect(roleId, `no AWS::IAM::Role with a logical id matching ${roleIdPrefix}`).toBeDefined();
  // EVERY policy attached to the role, not the first one found (re-review, Minor J): CDK emits one
  // inline policy per role today, but a second would silently fall outside a `.find()` and any
  // "this function cannot reach X" assertion built on it would go quietly blind.
  const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
    (p.Properties.Roles as Array<{ Ref?: string }>).some((r) => r.Ref === roleId),
  );
  expect(policies.length, `no AWS::IAM::Policy attached to ${roleId}`).toBeGreaterThan(0);
  return policies.flatMap((p) => (p.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement);
};

// Does any statement in `statements` reach `resourceLogicalId`, by Ref or by Fn::GetAtt? Compared
// against the serialized statement so both spellings and any nesting are covered.
const grants = (statements: Array<Record<string, unknown>>, actionPrefix: string, resourceLogicalId: string): boolean =>
  statements.some((statement) => {
    // `Effect` is load-bearing and was ignored here (re-review 2, Important 4): an explicit DENY on
    // the very table a positive assertion names satisfied "mcp can reach the rounds table" while
    // the deployed function could reach nothing. A statement with no Effect defaults to Allow.
    if ((statement.Effect ?? "Allow") !== "Allow") return false;
    const actions = Array.isArray(statement.Action) ? (statement.Action as string[]) : [String(statement.Action)];
    if (!actions.some((action) => action.startsWith(actionPrefix))) return false;
    return JSON.stringify(statement.Resource).includes(`"${resourceLogicalId}"`);
  });

describe("the MCP canonical URI, read off the synthesized template", () => {
  it("the Cognito resource server identifier IS the MCP endpoint URL", () => {
    // Measured, spec F2: a `resource` that doesn't name a registered resource server yields an
    // authorization code that cannot be redeemed — and the token endpoint reports an ordinary
    // invalid_grant, pointing nowhere near this mismatch.
    template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
      Identifier: CANONICAL,
      Scopes: Match.arrayWith([
        Match.objectLike({ ScopeName: "read", ScopeDescription: Match.anyValue() }),
        Match.objectLike({ ScopeName: "write", ScopeDescription: Match.anyValue() }),
      ]),
    });
  });

  it("the mcp function is told the same string, under the name its own code reads", () => {
    // entries/mcp.ts:127 reads MCP_RESOURCE. The plan's task text said MCP_CANONICAL; the code
    // shipped first and is right. A stack that set the plan's name would kill this Lambda inside
    // requireEnv on its first invocation, on a live stack.
    expect(environmentOf(/^McpFunction/).MCP_RESOURCE).toBe(CANONICAL);
  });

  it("the mcpAuth function is told the same string", () => {
    expect(environmentOf(/^McpAuthFunction/).MCP_RESOURCE).toBe(CANONICAL);
  });

  it("the custom domain serves that host", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", { DomainName: MCP_HOST });
    template.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: MCP_HOST });
  });

  it("the domain is mapped to the MCP API's own stage at the root (no mapping key)", () => {
    const apiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-mcp-beta");
    const mapping = Object.values(template.findResources("AWS::ApiGatewayV2::ApiMapping")).find(
      (m) => (m.Properties.ApiId as { Ref?: string } | undefined)?.Ref === apiId,
    );
    expect(mapping, "no ApiMapping pointing at the MCP API").toBeDefined();
    expect(mapping!.Properties.ApiMappingKey).toBeUndefined();
  });

  it("an A record claims that host in the imported zone", () => {
    template.hasResourceProperties("AWS::Route53::RecordSet", { Name: `${MCP_HOST}.`, Type: "A" });
  });

  it("POST <the canonical's own path> is a real route on the MCP API", () => {
    expect(mcpRouteKeys()).toContain(`POST ${new URL(CANONICAL).pathname}`);
  });

  it("the mcp app client has its own managed login branding", () => {
    // Measured, spec F6: without one the sign-in page renders "Login pages unavailable" and no
    // form — a symptom naming nothing that leads to the cause.
    template.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 2);
    const clientId = findLogicalId("AWS::Cognito::UserPoolClient", (p) => p.ClientName === "swng-mcp-beta");
    const brandings = Object.values(template.findResources("AWS::Cognito::ManagedLoginBranding"));
    expect(brandings.map((b) => (b.Properties.ClientId as { Ref?: string } | undefined)?.Ref)).toContain(clientId);
  });
});

describe("the MCP API's routes", () => {
  // Ten explicit route keys and no catch-all. mcpAuth dispatches on the NORMALIZED pathname, so
  // `POST /authorize/../token` reaches handleToken; explicit route keys make that unreachable at
  // the gateway. `ANY /{proxy+}` would hand every traversal-shaped path straight to the switch.
  const EXPECTED = [
    "GET /.well-known/oauth-authorization-server",
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/mcp",
    "GET /authorize",
    // Fix round 1, Important 2: 405 is a SPECIFIED signal at this one path. The SDK's
    // `legacy: "stateless"` leg answers GET with 405 to say "no SSE stream here", and
    // @modelcontextprotocol/client returns cleanly on exactly that status and throws on anything
    // else. Unrouted, the gateway's own 404 arrives instead and every 2025-era connection carries
    // a transport error. The three OAuth endpoints stay method-pinned: nothing in OAuth gives a
    // wrong-verb 405 any protocol meaning.
    "GET /mcp",
    "GET /oauth/callback",
    "POST /mcp",
    "POST /oauth/consent",
    "POST /register",
    "POST /token",
  ];

  it("declares exactly the ten surfaces, explicitly", () => {
    expect([...mcpRouteKeys()].sort()).toEqual(EXPECTED);
  });

  it("has no catch-all and no ANY-method route", () => {
    // Fix round 1, Minor 7: a for-loop over an empty list asserts nothing and passes. Pin the
    // count first, so "no catch-all" can never be satisfied by "no routes at all".
    expect(mcpRouteKeys()).toHaveLength(EXPECTED.length);
    for (const key of mcpRouteKeys()) {
      expect(key).not.toContain("{proxy+}");
      expect(key).not.toContain("$default");
      expect(key.startsWith("ANY ")).toBe(false);
    }
  });
});

describe("who is wired to whom (the relationships a property assertion cannot see)", () => {
  const mcpOAuthTableId = (): string => findLogicalId("AWS::DynamoDB::Table", (p) => p.TableName === "swng-mcp-oauth-beta");
  const mcpClientSecretId = (): string => findLogicalId("AWS::SecretsManager::Secret", (p) => p.Name === "swng-mcp-client-secret-beta");
  const mcpAppClientId = (): string => findLogicalId("AWS::Cognito::UserPoolClient", (p) => String(p.ClientName ?? "").includes("mcp"));

  it("the canonical path is served by the mcp function, on BOTH its methods", () => {
    expect(functionIdForRouteKey("POST /mcp")).toMatch(/^McpFunction/);
    expect(functionIdForRouteKey("GET /mcp")).toMatch(/^McpFunction/);
  });

  it("every one of the eight OAuth surfaces is served by mcpAuth, not by mcp", () => {
    // Integrated to the wrong function these all still deploy: the routes exist, the methods are
    // right, and every request reaches a handler that has never heard of the path.
    // Compare the path EXACTLY: `/.well-known/oauth-protected-resource/mcp` also ends with the
    // canonical pathname, so an `endsWith` filter silently drops a route from the check.
    const canonicalPath = new URL(CANONICAL).pathname;
    const oauthKeys = mcpRouteKeys().filter((key) => key.slice(key.indexOf(" ") + 1) !== canonicalPath);
    expect(oauthKeys).toHaveLength(8);
    for (const key of oauthKeys) {
      expect(functionIdForRouteKey(key), `${key} is not served by mcpAuth`).toMatch(/^McpAuthFunction/);
    }
  });

  it("the OAuth mediation table is mcpAuth's alone — mcp cannot touch it", () => {
    const tableId = mcpOAuthTableId();
    expect(grants(policyStatementsFor(/^McpAuthFunctionServiceRole/), "dynamodb:", tableId)).toBe(true);
    expect(grants(policyStatementsFor(/^McpFunctionServiceRole/), "dynamodb:", tableId)).toBe(false);
  });

  it("the app-client secret is mcpAuth's alone — mcp cannot read it", () => {
    // mcp legitimately reads a DIFFERENT secret (the composition root's token secret), so an
    // assertion that merely counted secretsmanager statements would pass on the swap.
    const secretId = mcpClientSecretId();
    expect(grants(policyStatementsFor(/^McpAuthFunctionServiceRole/), "secretsmanager:", secretId)).toBe(true);
    expect(grants(policyStatementsFor(/^McpFunctionServiceRole/), "secretsmanager:", secretId)).toBe(false);
  });

  it("both functions are told the MCP app client, never the web one", () => {
    // Pointed at the web client this deploys clean and then fails at the far end of a browser
    // sign-in: the web client has no custom scopes and issues no resource-bound token, so
    // /authorize's Cognito leg refuses and the verifier would reject anything that did come back.
    const clientId = mcpAppClientId();
    for (const prefix of [/^McpFunction/, /^McpAuthFunction/]) {
      expect(environmentOf(prefix).MCP_CLIENT_ID).toEqual({ Ref: clientId });
    }
  });

  it("the MCP API's own stage carries the throttle, and CORS admits the one header every call sends", () => {
    const apiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-mcp-beta");
    const stage = Object.values(template.findResources("AWS::ApiGatewayV2::Stage")).find(
      (s) => (s.Properties.ApiId as { Ref?: string } | undefined)?.Ref === apiId,
    );
    expect(stage, "the MCP API has no stage of its own").toBeDefined();
    expect(stage!.Properties.DefaultRouteSettings).toMatchObject({ ThrottlingBurstLimit: expect.any(Number), ThrottlingRateLimit: expect.any(Number) });

    // `*` does not cover Authorization — the Fetch Standard defines it as a CORS non-wildcard
    // request-header name precisely to exclude it. Deleting the CORS block entirely, or trimming
    // it back to ["*"], deploys clean and breaks every browser-hosted client on every
    // authenticated call.
    const cors = resourceById("AWS::ApiGatewayV2::Api", apiId).Properties.CorsConfiguration as { AllowHeaders?: string[] } | undefined;
    expect(cors, "the MCP API has no CORS configuration").toBeDefined();
    expect(cors!.AllowHeaders).toContain("authorization");
    expect(cors!.AllowHeaders).toContain("*");
  });
});

// The logical id of the one resource matching a predicate, shaped as the template would Ref it.
const refTo = (resourceType: string, predicate: (properties: Record<string, unknown>) => boolean): { Ref: string } => ({
  Ref: findLogicalId(resourceType, predicate),
});

const tableRef = (nameFragment: string): { Ref: string } => refTo("AWS::DynamoDB::Table", (p) => String(p.TableName).includes(nameFragment));

describe("what the first fix round's own falsification set did not test", () => {
  // -------------------------------------------------------------------------------------------
  // Re-review of fix round 1. My own falsification set tested the ten mutations my new assertions
  // caught, which is the shape a self-graded check always takes: the review's table had TWELVE
  // rows and four were never converted into mutations at all (#4 allowOrigins narrowed, #5
  // exposeHeaders dropped, #8 COGNITO_DOMAIN pointed at the canonical URI, #12 the table set to
  // RETAIN) — all four still passed. The rest of this block closes those, plus five more
  // survivors the re-review found by mutating past my list.
  // -------------------------------------------------------------------------------------------

  it("CORS is asserted in FULL — every field, because each one alone breaks a browser client", () => {
    const apiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-mcp-beta");
    const cors = resourceById("AWS::ApiGatewayV2::Api", apiId).Properties.CorsConfiguration as {
      AllowOrigins?: string[];
      AllowMethods?: string[];
      AllowHeaders?: string[];
      ExposeHeaders?: string[];
      MaxAge?: number;
    };
    expect(cors, "the MCP API has no CORS configuration").toBeDefined();
    // Narrowed to the web's own origin (review row #4) every browser-hosted client 403s: they are
    // hosted anywhere, which is the entire point of the client class spec §7 serves.
    expect(cors.AllowOrigins).toEqual(["*"]);
    expect(cors.AllowMethods).toEqual(expect.arrayContaining(["GET", "POST"]));
    expect(cors.AllowHeaders).toEqual(expect.arrayContaining(["*", "authorization"]));
    // Dropped (review row #5), the 401's WWW-Authenticate is unreadable from a browser — and that
    // header IS the discovery entry point, so the client has nowhere to go and no way to say why.
    expect(cors.ExposeHeaders).toEqual(expect.arrayContaining(["WWW-Authenticate"]));
    // Re-review 2, Minor 5: `toBeGreaterThan(0)` accepted one second — un-making this round's own
    // production change while passing the very test written to protect it. A brand-new any-number
    // assertion, in the commit that fixed "asserted as any number". Pin the value.
    expect(cors.MaxAge).toBe(600);
  });

  it("EVERY environment variable on both functions, as a whole set — not a sample", () => {
    // Re-review 2, Importants 1 and 2. The version this replaces pinned three values by EXAMPLE,
    // and one of those by SUBSTRING. Eight of mcp's eleven stayed key-only: a bogus USER_POOL_ID
    // (every request 401s forever) passed, TABLE_PROJECTIONS pointed at the snapshots table
    // passed, and COGNITO_DOMAIN + "/oauth2" still "contained amazoncognito.com" while every
    // sign-in 404s at Cognito.
    //
    // The finding named a CLASS, so the answer is the whole set rather than more examples:
    // `toEqual` on the entire environment object. A swapped value fails, and so does a NEW
    // variable nobody thought to assert — which no list of individual expectations can do.
    const mcpClient = refTo("AWS::Cognito::UserPoolClient", (p) => String(p.ClientName ?? "").includes("mcp"));

    expect(environmentOf(/^McpFunction/)).toEqual({
      STAGE: "beta",
      MCP_RESOURCE: CANONICAL,
      MCP_CLIENT_ID: mcpClient,
      USER_POOL_ID: refTo("AWS::Cognito::UserPool", (p) => p.UserPoolName !== undefined),
      TABLE_ROUNDS: tableRef("rounds"),
      TABLE_CORE: tableRef("core"),
      TABLE_PROJECTIONS: tableRef("projections"),
      TABLE_SNAPSHOTS: tableRef("snapshots"),
      TABLE_CONNECTIONS: tableRef("connections"),
      TOKEN_SECRET_ARN: refTo("AWS::SecretsManager::Secret", (p) => p.Name === "swng-token-secret-beta"),
      WS_ENDPOINT: expect.objectContaining({ "Fn::Join": expect.anything() }),
    });

    expect(environmentOf(/^McpAuthFunction/)).toEqual({
      MCP_RESOURCE: CANONICAL,
      TABLE_MCP_OAUTH: tableRef("mcp-oauth"),
      MCP_CLIENT_ID: mcpClient,
      MCP_CLIENT_SECRET_ARN: refTo("AWS::SecretsManager::Secret", (p) => p.Name === "swng-mcp-client-secret-beta"),
      // The hosted-UI origin EXACTLY — nothing appended. The region stays an unresolved `Ref`
      // because this stack is synthesized without an env; `cdk synth` against the real account
      // renders the same expression as `us-east-1`.
      COGNITO_DOMAIN: {
        "Fn::Join": [
          "",
          ["https://", refTo("AWS::Cognito::UserPoolDomain", (p) => p.Domain !== undefined), ".auth.", { Ref: "AWS::Region" }, ".amazoncognito.com"],
        ],
      },
    });
  });

  it("both functions carry the size and timeout the two-Lambda split exists to give them", () => {
    // Re-review 2, Minor 7: mcpAuth's 1024 MB / 15 s is the entire stated reason it is a separate
    // function from mcp, and nothing asserted it — 128 MB / 3 s passed, which is a cold-start
    // timeout on a human-interactive sign-in hop.
    const propsOf = (prefix: RegExp): Record<string, unknown> => {
      const entry = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) => prefix.test(id));
      expect(entry, `no AWS::Lambda::Function matching ${prefix}`).toBeDefined();
      return entry![1].Properties as Record<string, unknown>;
    };
    expect(propsOf(/^McpAuthFunction/)).toMatchObject({ MemorySize: 1024, Timeout: 15 });
    expect(propsOf(/^McpFunction/)).toMatchObject({ MemorySize: 512, Timeout: 15 });
  });

  it("neither MCP role carries a managed policy beyond basic execution", () => {
    // Re-review 2, Important 3: the wildcard guard below reads INLINE policies only, so attaching
    // `AmazonDynamoDBFullAccess` as a MANAGED policy handed mcp the OAuth table's live codes and
    // held tokens while all three "mcp cannot touch it" assertions stayed green. Both roles already
    // carry a ManagedPolicyArns entry, so this was a door standing open, not a hypothetical.
    for (const prefix of [/^McpFunctionServiceRole/, /^McpAuthFunctionServiceRole/]) {
      const roleId = Object.keys(template.findResources("AWS::IAM::Role")).find((id) => prefix.test(id));
      expect(roleId, `no AWS::IAM::Role matching ${prefix}`).toBeDefined();
      const arns = resourceById("AWS::IAM::Role", roleId!).Properties.ManagedPolicyArns as unknown[];
      expect(arns, `${roleId} carries more than basic execution`).toHaveLength(1);
      expect(JSON.stringify(arns)).toContain("AWSLambdaBasicExecutionRole");
    }
  });

  it("mcp keeps the grants its tool surface actually needs", () => {
    // Re-review Important B: every grant assertion so far was NEGATIVE ("mcp cannot reach the
    // OAuth store"), so deleting a grant mcp DOES need passed. Each of these kills a tool call on
    // its first invocation, in the account, with a green suite.
    const statements = policyStatementsFor(/^McpFunctionServiceRole/);
    const tokenSecretId = findLogicalId("AWS::SecretsManager::Secret", (p) => p.Name === "swng-token-secret-beta");
    expect(grants(statements, "secretsmanager:", tokenSecretId), "mcp cannot read the token secret").toBe(true);
    for (const table of ["rounds", "core", "snapshots", "projections", "connections"]) {
      const id = findLogicalId("AWS::DynamoDB::Table", (p) => String(p.TableName).includes(table));
      expect(grants(statements, "dynamodb:", id), `mcp cannot reach the ${table} table`).toBe(true);
    }
    expect(
      statements.some((st) => JSON.stringify(st.Action).includes("execute-api:ManageConnections")),
      "mcp cannot broadcast a score write to the crew's open sockets",
    ).toBe(true);
  });

  it("neither MCP function holds a wildcard resource", () => {
    // Re-review Minor F: `grants()` matches by logical id, so a `Resource: "*"` statement would
    // hand mcp the OAuth table's live codes and held tokens while BOTH "mcp cannot touch it"
    // assertions above still passed. Least privilege has to be asserted directly.
    for (const prefix of [/^McpFunctionServiceRole/, /^McpAuthFunctionServiceRole/]) {
      for (const statement of policyStatementsFor(prefix)) {
        expect(statement.Resource, `a wildcard resource on ${prefix}`).not.toBe("*");
      }
    }
  });

  it("the MCP host resolves to the MCP API's own domain, never the web distribution", () => {
    // Re-review Important D: the stack builds this record eleven lines below the web's, and a
    // verbatim copy-paste points mcp.beta.swng.golf at the CloudFront distribution serving the
    // SPA. DNS resolves, TLS terminates, and every MCP request gets the web app's index.html.
    const record = Object.values(template.findResources("AWS::Route53::RecordSet")).find((r) => r.Properties.Name === `${MCP_HOST}.`);
    expect(record, `no Route 53 record for ${MCP_HOST}`).toBeDefined();
    const mcpDomainId = Object.keys(template.findResources("AWS::ApiGatewayV2::DomainName"))[0];
    expect(JSON.stringify(record!.Properties.AliasTarget)).toContain(mcpDomainId);
    expect(JSON.stringify(record!.Properties.AliasTarget)).not.toContain("Distribution");
  });

  it("every MCP alarm actually notifies, including the CIMD one that exists to page on an outage", () => {
    // Re-review Important E: Addendum H1's whole point is that the uniform 400 hides a total
    // egress outage, so the alarm is the only thing left that can say so. An alarm with no actions
    // is a dashboard nobody is looking at.
    const alarms = Object.entries(template.findResources("AWS::CloudWatch::Alarm")).filter(([id]) => /^Mcp/.test(id));
    expect(alarms.length, "no MCP alarms at all").toBeGreaterThanOrEqual(3);
    for (const [id, alarm] of alarms) {
      expect(alarm.Properties.AlarmActions, `${id} notifies nobody`).toBeDefined();
      expect((alarm.Properties.AlarmActions as unknown[]).length, `${id} notifies nobody`).toBeGreaterThan(0);
      expect(alarm.Properties.OKActions, `${id} never says it recovered`).toBeDefined();
    }
  });

  it("the OAuth store is DESTROY, so a beta wipe does not strand it", () => {
    // Review row #12. Low consequence and still true: beta is wiped deliberately and often, and
    // RETAIN leaves an orphan table holding real authorization codes behind.
    const tableId = findLogicalId("AWS::DynamoDB::Table", (p) => p.TableName === "swng-mcp-oauth-beta");
    expect(resourceById("AWS::DynamoDB::Table", tableId).DeletionPolicy).toBe("Delete");
  });

  it("the throttle carries the stack's own numbers, not merely some number", () => {
    // Re-review Minor G: `expect.any(Number)` accepts a 1-request-per-second ceiling, which is a
    // self-inflicted outage that passes as "throttled".
    const apiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-mcp-beta");
    const httpApiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-http-beta");
    const settingsFor = (id: string): unknown =>
      Object.values(template.findResources("AWS::ApiGatewayV2::Stage")).find((st) => (st.Properties.ApiId as { Ref?: string })?.Ref === id)
        ?.Properties.DefaultRouteSettings;
    // Pinned against the EXISTING API's stage rather than a literal: they read the same two
    // constants, so this fails if the MCP stage drifts from them without hardcoding either.
    expect(settingsFor(apiId)).toEqual(settingsFor(httpApiId));
  });

  it("the MCP app client declares its auth flows rather than inheriting Cognito's default", () => {
    // Re-review Minor H: the line that fixed this in the previous round had no test and reverted
    // invisibly. Refresh is the only flow this client should offer; the authorization-code flow is
    // governed by AllowedOAuthFlows, not by this list.
    const clientId = findLogicalId("AWS::Cognito::UserPoolClient", (p) => String(p.ClientName ?? "").includes("mcp"));
    expect(resourceById("AWS::Cognito::UserPoolClient", clientId).Properties.ExplicitAuthFlows).toEqual(["ALLOW_REFRESH_TOKEN_AUTH"]);
  });
});

describe("the two functions' environments (every one is a hard requireEnv — a missing var is a cold-start crash)", () => {
  it("mcp carries what entries/mcp.ts and buildApp both require", () => {
    const env = environmentOf(/^McpFunction/);
    for (const key of ["MCP_RESOURCE", "USER_POOL_ID", "MCP_CLIENT_ID", "TABLE_CORE", "TABLE_PROJECTIONS", "TABLE_SNAPSHOTS", "TABLE_ROUNDS", "TABLE_CONNECTIONS", "TOKEN_SECRET_ARN", "WS_ENDPOINT", "STAGE"]) {
      expect(Object.keys(env), `mcp is missing ${key}`).toContain(key);
    }
  });

  it("mcpAuth carries its five, and NOT the composition root's own", () => {
    const env = environmentOf(/^McpAuthFunction/);
    for (const key of ["MCP_RESOURCE", "TABLE_MCP_OAUTH", "COGNITO_DOMAIN", "MCP_CLIENT_ID", "MCP_CLIENT_SECRET_ARN"]) {
      expect(Object.keys(env), `mcpAuth is missing ${key}`).toContain(key);
    }
    // The two-Lambda split (spec §3.4) exists to keep this entry's cold start inside Claude's
    // 10-second discovery budget: it builds no App, so it needs none of buildApp's vars.
    expect(Object.keys(env)).not.toContain("TOKEN_SECRET_ARN");
    expect(Object.keys(env)).not.toContain("WS_ENDPOINT");
  });
});

describe("the confidential app client and its secret", () => {
  it("the app client is confidential, code-flow, and bound to the two custom scopes", () => {
    const resourceServerId = findLogicalId("AWS::Cognito::UserPoolResourceServer", (p) => p.Identifier === CANONICAL);
    const client = template.findResources("AWS::Cognito::UserPoolClient", { Properties: Match.objectLike({ ClientName: "swng-mcp-beta" }) });
    const properties = Object.values(client)[0]?.Properties as Record<string, unknown> | undefined;
    expect(properties, "no swng-mcp-beta app client").toBeDefined();
    expect(properties!.GenerateSecret).toBe(true);
    expect(properties!.AllowedOAuthFlows).toEqual(["code"]);
    expect(properties!.AllowedOAuthFlowsUserPoolClient).toBe(true);
    // The scopes render as Fn::Join over the resource server's own Ref, so they cannot drift from
    // the identifier they must belong to (spec F5: a custom scope that doesn't belong to the
    // requested resource fails /authorize with invalid_request).
    const scopes = JSON.stringify(properties!.AllowedOAuthScopes);
    expect(scopes).toContain(resourceServerId);
    expect(scopes).toContain("/read");
    expect(scopes).toContain("/write");
  });

  it("the client secret Cognito generated is the one mcpAuth reads from Secrets Manager", () => {
    const clientId = findLogicalId("AWS::Cognito::UserPoolClient", (p) => p.ClientName === "swng-mcp-beta");
    const secretId = findLogicalId(
      "AWS::SecretsManager::Secret",
      (p) => JSON.stringify(p.SecretString ?? "").includes(clientId) && JSON.stringify(p.SecretString ?? "").includes("ClientSecret"),
    );
    // The ARN, never the value — the same delivery rule TOKEN_SECRET_ARN follows.
    expect(environmentOf(/^McpAuthFunction/).MCP_CLIENT_SECRET_ARN).toEqual({ Ref: secretId });
    const policies = template.findResources("AWS::IAM::Policy");
    const grants = Object.values(policies).filter((policy) =>
      JSON.stringify(policy.Properties.PolicyDocument).includes("secretsmanager:GetSecretValue"),
    );
    expect(grants.some((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(secretId)), "no GetSecretValue grant on the MCP client secret").toBe(true);
  });
});

describe("the OAuth mediation store", () => {
  it("is a pk-only, TTL-swept table of its own", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "swng-mcp-oauth-beta",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("mcpAuth can read AND write it (every handler takes, rotates or retires an item)", () => {
    const tableId = findLogicalId("AWS::DynamoDB::Table", (p) => p.TableName === "swng-mcp-oauth-beta");
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((policy) => {
      const document = JSON.stringify(policy.Properties.PolicyDocument);
      return document.includes(tableId) && document.includes("dynamodb:UpdateItem");
    });
    expect(policies.length, "no read/write grant on the OAuth store").toBeGreaterThan(0);
  });
});

describe("observability the MCP surfaces would otherwise lack", () => {
  it("has 5xx and p95 alarms on the MCP API, like the existing one", () => {
    // Named one at a time, on the metric each actually reads: a count alone passes on two alarms
    // watching the same thing, and an alarm dimensioned on the WEB api would satisfy any test
    // that didn't resolve this api's own logical id first.
    const apiId = findLogicalId("AWS::ApiGatewayV2::Api", (p) => p.Name === "swng-mcp-beta");
    const onThisApi = Object.values(template.findResources("AWS::CloudWatch::Alarm")).filter((alarm) =>
      JSON.stringify(alarm.Properties.Dimensions ?? []).includes(apiId),
    );
    const metrics = onThisApi.map((alarm) => `${alarm.Properties.MetricName as string} ${(alarm.Properties.ExtendedStatistic ?? alarm.Properties.Statistic) as string}`);
    expect(metrics).toContain("5xx Sum");
    expect(metrics).toContain("Latency p95");
    // Both notify on return-to-OK: "it recovered on its own" is information the owner wants for a
    // sustained HTTP alarm (the existing API's own two make the same call).
    for (const alarm of onThisApi) expect(alarm.Properties.OKActions, "an MCP API alarm that never says it recovered").toBeDefined();
  });

  it("a CIMD fetch failure is counted and alarmed — the uniform 400 hides a total egress outage", () => {
    // Task 19 made every CIMD fetch failure answer ONE uniform 400 and moved that class off
    // console.error, so a resolver/egress outage is byte-identical to one client's typo: nothing
    // pages. The response must stay uniform, so the signal has to come from the infrastructure.
    template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: '"client metadata document could not be fetched"',
      MetricTransformations: [Match.objectLike({ MetricName: "McpCimdFetchFailures-beta", MetricNamespace: "swng" })],
    });
    // On mcpAuth's OWN log group. A filter reading any other function's logs is a filter that
    // matches nothing forever, and every assertion above would still pass.
    const [logGroupId] = Object.keys(template.findResources("AWS::Logs::LogGroup")).filter((id) => /^McpAuthFunctionLogGroup/.test(id));
    expect(logGroupId, "no CDK-managed log group for the mcpAuth function").toBeDefined();
    const filter = Object.values(template.findResources("AWS::Logs::MetricFilter"))[0];
    expect(filter?.Properties.LogGroupName).toEqual({ Ref: logGroupId });
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")).filter((alarm) => alarm.Properties.MetricName === "McpCimdFetchFailures-beta");
    expect(alarms.length, "the CIMD failure metric has no alarm on it").toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Parity with the code that actually SERVES these paths.
//
// WHY THE STACK RETYPES THESE RATHER THAN IMPORTING THEM (corrected in fix round 1, Minor 1 —
// the original claim here, that a synth CANNOT import a workspace package, was simply false:
// swngStack.ts already imports @swng/brand at synth time). The real reasons are narrower and
// still hold: importing @swng/lambda's barrel would drag the composition root, every adapter and
// the AWS SDK into the synth process to read a few strings; and `cdk deploy` runs bin/infra-cdk.ts
// with no build step, so that import would put a LOAD-BEARING value — the callback URL Cognito
// matches exactly — behind a possibly-stale `dist`. A stale brand colour is cosmetic; a stale
// callback path strands a signed-in golfer on a 404. So the stack declares its own literals and
// THIS pins them, exactly as routesParity.test.ts already pins HTTP_ROUTES against buildRoutes.
//
// WHAT THIS GUARD ACTUALLY REACHES (fix round 1, Minor 2): the imports above resolve to
// @swng/lambda's BUILT `dist`, so a rename in its source reddens these tests only after that
// package is rebuilt. `pnpm validate` builds before it tests, so the gate genuinely holds where it
// counts — but `vitest` alone, run against a stale `dist`, will not see the drift.
//
// This is the third time in this arc that a literal typed in two places with nothing coupling
// them turned out to be a defect (redirect_uri's two caps, the metadata/router endpoint paths).
// Renaming CALLBACK_PATH must not leave a green suite and a browser leg that 404s with the
// golfer already signed in.
// ---------------------------------------------------------------------------------------------

describe("the route table matches the paths packages/lambda actually serves", () => {
  it("every mcpAuth route key is one of paths.ts's own constants (plus RFC 9728's resource-suffixed form)", () => {
    const served = [
      PROTECTED_RESOURCE_METADATA_PATH,
      `${PROTECTED_RESOURCE_METADATA_PATH}${new URL(CANONICAL).pathname}`,
      AUTHORIZATION_SERVER_METADATA_PATH,
      REGISTER_PATH,
      AUTHORIZE_PATH,
      CALLBACK_PATH,
      CONSENT_SUBMIT_PATH,
      TOKEN_PATH,
    ].sort();
    const routed = mcpRouteKeys()
      .map((key) => key.slice(key.indexOf(" ") + 1))
      .filter((path) => path !== new URL(CANONICAL).pathname)
      .sort();
    expect(routed).toEqual(served);
  });

  it("the scopes Cognito registers are the two the authorization server actually asks for", () => {
    // Measured F5: Cognito refuses /authorize outright ("custom scopes requested for
    // resource-binding must be assigned to the resource being requested") when the scope the AS
    // requests is not one this resource server declares. The scope NAME lives in the stack and the
    // full scope STRING is built in authorize.ts — two files, one fact.
    const resourceServer = Object.values(template.findResources("AWS::Cognito::UserPoolResourceServer"))[0];
    const registered = (resourceServer?.Properties.Scopes as { ScopeName: string }[]).map((scope) => `${CANONICAL}/${scope.ScopeName}`).sort();
    expect(registered).toEqual([readScopeOf(CANONICAL), writeScopeOf(CANONICAL)].sort());
  });

  it("the Cognito app client's callback URL is the path the callback route serves", () => {
    // Cognito matches this EXACTLY: a drift here strands the golfer mid-flow, signed in, on a
    // gateway 404 — with `redirect_mismatch` if they are lucky and nothing at all if they are not.
    const client = template.findResources("AWS::Cognito::UserPoolClient", { Properties: Match.objectLike({ ClientName: "swng-mcp-beta" }) });
    expect(Object.values(client)[0]?.Properties.CallbackURLs).toEqual([`https://${MCP_HOST}${CALLBACK_PATH}`]);
  });

  it("the CIMD alarm counts the message clients.ts actually logs", () => {
    // The metric filter is a string match against a log line. If clients.ts renames its fixed
    // network-failure message, the filter silently matches nothing forever and the alarm — the
    // ONLY signal that swng's egress is down rather than one client being wrong — never fires
    // again, with no test failing anywhere else.
    const filter = Object.values(template.findResources("AWS::Logs::MetricFilter"))[0];
    expect(filter?.Properties.FilterPattern).toBe(`"${CIMD_FETCH_FAILED}"`);
  });
});

describe("STAGE_CONFIG (bin/infra-cdk.ts) — where the deployed values actually come from", () => {
  const stageConfig = (stage: string) => {
    const config = STAGE_CONFIG[stage];
    expect(config, `no STAGE_CONFIG entry for ${stage}`).toBeDefined();
    return config!;
  };

  it("beta carries the MCP config, in the same zone the web domain already uses", () => {
    const beta = stageConfig("beta");
    expect(beta.mcp).toEqual({ domainName: MCP_HOST, hostedZoneId: beta.web?.hostedZoneId, zoneName: "swng.golf" });
  });

  it("prod carries none — beta only in this arc, so prod still synthesizes byte-identical", () => {
    expect(stageConfig("prod").mcp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The gate itself. swngStack.test.ts's shared prop-less template already pins the table/function/
// route/alarm/branding COUNTS, so a leak in any of those fails there — but a leaked resource
// server, secret, certificate or metric filter would slip past every one of them, and prod ships
// from exactly this prop-less shape (spec §10.4). If this describe ever fails, the gate leaked
// and the fix is the gate, not the test.
// ---------------------------------------------------------------------------------------------

describe("a stage with no mcp prop gets no MCP anything", () => {
  const bare = Template.fromStack(new SwngStack(new App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } }), "swng-beta", { stage: "beta" }));

  it("renders none of the resource types the MCP block introduces", () => {
    bare.resourceCountIs("AWS::Cognito::UserPoolResourceServer", 0);
    bare.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    bare.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 0);
    bare.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    bare.resourceCountIs("AWS::Logs::MetricFilter", 0);
    // The token-signing secret is the only one a stage without MCP has.
    bare.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });

  it("mentions the MCP host nowhere in the whole template", () => {
    expect(JSON.stringify(bare.toJSON())).not.toContain("mcp");
  });
});
