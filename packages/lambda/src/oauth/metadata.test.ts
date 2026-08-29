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
});
