import { describe, expect, it } from "vitest";
import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata } from "./metadata.js";

// Task-15 brief: the canonical value is read once by the mcp entry (entries/mcp.ts:127) and
// handed to us as a parameter — never re-derived or hardcoded here. This is the SAME literal
// entries/mcp.test.ts uses for its CANONICAL, so a drift between the two test files would show
// up as a spec mismatch, not a passing-for-the-wrong-reason green.
const CANONICAL = "https://mcp.beta.swng.golf/mcp";

describe("buildAuthorizationServerMetadata", () => {
  it("advertises S256 PKCE — clients MUST refuse to proceed without it", () => {
    const m = buildAuthorizationServerMetadata(CANONICAL);

    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises both flags Claude needs before choosing CIMD over DCR", () => {
    const m = buildAuthorizationServerMetadata(CANONICAL);

    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("advertises RFC 9207 issuer identification", () => {
    const m = buildAuthorizationServerMetadata(CANONICAL);

    expect(m.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("advertises the read scope only — write is granted at the consent page, not by step-up", () => {
    const m = buildAuthorizationServerMetadata(CANONICAL);

    expect(m.scopes_supported).toEqual([`${CANONICAL}/read`]);
  });

  it("does NOT advertise offline_access", () => {
    const m = buildAuthorizationServerMetadata(CANONICAL);

    expect(m.scopes_supported).not.toContain("offline_access");
  });

  // Review round 1, important fix 1: every URL below is `new URL(resource).origin`-derived and
  // had zero assertion coverage — a plausible wrong implementation (`.href` instead of `.origin`,
  // a stray trailing slash, `resource` where `origin` belongs) passed every test above. Pinned
  // here field by field, against the SAME origin the PRM test below also pins, so the two
  // documents can't drift from each other without failing.
  it("anchors issuer and every endpoint at the resource's own origin — mcp.swng.golf mediates, Cognito does not", () => {
    const m = buildAuthorizationServerMetadata(CANONICAL);

    expect(m.issuer).toBe("https://mcp.beta.swng.golf");
    expect(m.authorization_endpoint).toBe("https://mcp.beta.swng.golf/authorize");
    expect(m.token_endpoint).toBe("https://mcp.beta.swng.golf/token");
    expect(m.registration_endpoint).toBe("https://mcp.beta.swng.golf/register");
  });

  it("advertises the authorization_code + refresh_token grants over the code response type", () => {
    const m = buildAuthorizationServerMetadata(CANONICAL);

    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });
});

describe("buildProtectedResourceMetadata", () => {
  it("names the canonical resource exactly, path included", () => {
    const m = buildProtectedResourceMetadata(CANONICAL);

    expect(m.resource).toBe("https://mcp.beta.swng.golf/mcp");
  });

  it("advertises the read scope only — write is granted at the consent page, not by step-up", () => {
    const m = buildProtectedResourceMetadata(CANONICAL);

    expect(m.scopes_supported).toEqual([`${CANONICAL}/read`]);
  });

  it("does NOT advertise offline_access", () => {
    const m = buildProtectedResourceMetadata(CANONICAL);

    expect(m.scopes_supported).not.toContain("offline_access");
  });

  it("names the resource's own origin as its authorization server", () => {
    const m = buildProtectedResourceMetadata(CANONICAL);

    expect(m.authorization_servers).toEqual(["https://mcp.beta.swng.golf"]);
  });
});

// Review round 1, important fix 1: "the sharpest gap" — the field tying the two documents
// together had zero coverage on either side. A client resolves the PRM's `authorization_servers`
// entry against the AS metadata's own `issuer`; if they disagree, discovery succeeds but every
// authorization attempt fails against the wrong server.
describe("buildProtectedResourceMetadata and buildAuthorizationServerMetadata together", () => {
  it("the PRM's authorization_servers[0] equals the AS metadata's issuer", () => {
    const prm = buildProtectedResourceMetadata(CANONICAL);
    const asMetadata = buildAuthorizationServerMetadata(CANONICAL);

    expect(prm.authorization_servers).toEqual([asMetadata.issuer]);
  });
});
