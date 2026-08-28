import { describe, expect, it } from "vitest";
import { accessTokenVerifierFrom, accountVerifierFromAccessToken } from "./createAccessTokenVerifier.js";

// Hermetic (CLAUDE.md: `pnpm validate` is offline) — `accessTokenVerifierFrom` and
// `accountVerifierFromAccessToken` both take an injectable `{ verify }` stub instead of the real
// CognitoJwtVerifier, so nothing here touches JWKS or the network. That's the whole point of the
// `…From` split this file mirrors from createCognitoVerifier.ts.

const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const claims = { sub: "s1", aud: CANONICAL, scope: `${CANONICAL}/read`, client_id: "abc", exp: 1893456000 };

describe("accessTokenVerifierFrom", () => {
  it("returns the AuthInfo shape requireBearerAuth needs, expiresAt included", async () => {
    await expect(accessTokenVerifierFrom({ verify: async () => claims }, CANONICAL).verifyAccessToken("t")).resolves.toEqual({
      token: "t",
      clientId: "abc",
      scopes: [`${CANONICAL}/read`],
      expiresAt: 1893456000,
    });
  });

  it("REJECTS a token issued for a different audience", async () => {
    // aws-jwt-verify checks client_id for access tokens and NEVER reads aud (its own source),
    // so without this explicit check a bound token and an unbound one verify identically.
    await expect(
      accessTokenVerifierFrom({ verify: async () => ({ ...claims, aud: "https://elsewhere/mcp" }) }, CANONICAL).verifyAccessToken("t"),
    ).rejects.toThrow(/audience/i);
  });

  it("REJECTS a token with no aud at all", async () => {
    const withoutAud = { sub: claims.sub, scope: claims.scope, client_id: claims.client_id, exp: claims.exp };
    await expect(accessTokenVerifierFrom({ verify: async () => withoutAud }, CANONICAL).verifyAccessToken("t")).rejects.toThrow(
      /audience/i,
    );
  });

  it("handles a single-scope and an absent scope claim without leaving a stray empty entry", async () => {
    await expect(
      accessTokenVerifierFrom({ verify: async () => ({ ...claims, scope: `${CANONICAL}/read` }) }, CANONICAL).verifyAccessToken("t"),
    ).resolves.toMatchObject({ scopes: [`${CANONICAL}/read`] });

    const withoutScope = { sub: claims.sub, aud: claims.aud, client_id: claims.client_id, exp: claims.exp };
    await expect(accessTokenVerifierFrom({ verify: async () => withoutScope }, CANONICAL).verifyAccessToken("t")).resolves.toMatchObject(
      { scopes: [] },
    );
  });
});

describe("accountVerifierFromAccessToken", () => {
  it("exposes sub through the AccountVerifier adapter the dispatcher needs", async () => {
    const verifier = accountVerifierFromAccessToken({ verify: async () => claims });
    await expect(verifier.verify("t")).resolves.toStrictEqual({ sub: "s1" });
  });

  it("rejects a token with no sub claim, rather than passing through undefined", async () => {
    const withoutSub = { aud: claims.aud, scope: claims.scope, client_id: claims.client_id, exp: claims.exp };
    const verifier = accountVerifierFromAccessToken({ verify: async () => withoutSub });
    await expect(verifier.verify("t")).rejects.toThrow(/sub/i);
  });
});
