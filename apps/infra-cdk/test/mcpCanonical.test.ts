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

  const integration = template.findResources("AWS::ApiGatewayV2::Integration")[integrationRef!.Ref];
  expect(integration, `route ${routeKey} targets an integration that is not in the template`).toBeDefined();

  // `IntegrationUri` comes in two spellings depending on how the integration was constructed —
  // a bare `Fn::GetAtt` (what the MCP API's integrations emit) or an `Fn::Join` that embeds one
  // inside the full apigateway ARN (what the existing HTTP and WebSocket APIs emit). Matching one
  // shape only would silently skip the other API's routes, so recurse and take the function ARN
  // wherever it sits.
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
  const policy = Object.values(template.findResources("AWS::IAM::Policy")).find((p) =>
    (p.Properties.Roles as Array<{ Ref?: string }>).some((r) => r.Ref === roleId),
  );
  expect(policy, `no AWS::IAM::Policy attached to ${roleId}`).toBeDefined();
  return (policy!.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
};

// Does any statement in `statements` reach `resourceLogicalId`, by Ref or by Fn::GetAtt? Compared
// against the serialized statement so both spellings and any nesting are covered.
const grants = (statements: Array<Record<string, unknown>>, actionPrefix: string, resourceLogicalId: string): boolean =>
  statements.some((statement) => {
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
    const cors = template.findResources("AWS::ApiGatewayV2::Api")[apiId].Properties.CorsConfiguration as { AllowHeaders?: string[] } | undefined;
    expect(cors, "the MCP API has no CORS configuration").toBeDefined();
    expect(cors!.AllowHeaders).toContain("authorization");
    expect(cors!.AllowHeaders).toContain("*");
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
