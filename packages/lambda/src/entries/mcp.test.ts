import { describe, expect, it } from "vitest";
import { requireBearerAuth } from "@modelcontextprotocol/server";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { wrapVerifierErrorsAsInvalidToken } from "./mcp.js";

// Requirement 1 (task-13 brief): Task 9's createAccessTokenVerifier throws a plain Error on a
// wrong-audience or expired token. Fed straight to requireBearerAuth, the SDK's own
// bearerAuthChallengeResponse answers a non-OAuthError with a bare 500 and no
// WWW-Authenticate — the client's refresh/re-authorize recovery keys on exactly that header, so
// this is the whole point of the fix, proven end to end through the REAL SDK gate rather than
// by reading the wrapper's source.
const rejectingVerifier: OAuthTokenVerifier = {
  verifyAccessToken: async (): Promise<AuthInfo> => {
    throw new Error("Token audience does not match required resource \"https://mcp.beta.swng.golf/mcp\"");
  },
};

const requestWithBearer = (token: string): Request => new Request("https://mcp.beta.swng.golf/mcp", { headers: { authorization: `Bearer ${token}` } });

describe("wrapVerifierErrorsAsInvalidToken", () => {
  it("BASELINE: an unwrapped plain-Error verifier answers 500, no WWW-Authenticate — the bug this task fixes", async () => {
    const gate = requireBearerAuth({ verifier: rejectingVerifier, resourceMetadataUrl: "https://mcp.beta.swng.golf/.well-known/oauth-protected-resource/mcp" });

    const result = await gate(requestWithBearer("bad-token"));

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(500);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("wrapped, the SAME rejection answers 401 with a WWW-Authenticate: Bearer challenge, not 500", async () => {
    const gate = requireBearerAuth({
      verifier: wrapVerifierErrorsAsInvalidToken(rejectingVerifier),
      resourceMetadataUrl: "https://mcp.beta.swng.golf/.well-known/oauth-protected-resource/mcp",
    });

    const result = await gate(requestWithBearer("bad-token"));

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("passes an AuthInfo through untouched on success", async () => {
    const info: AuthInfo = { token: "t", clientId: "c", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    const verifier: OAuthTokenVerifier = { verifyAccessToken: async () => info };

    const gate = requireBearerAuth({ verifier: wrapVerifierErrorsAsInvalidToken(verifier) });

    await expect(gate(requestWithBearer("good-token"))).resolves.toEqual(info);
  });
});
