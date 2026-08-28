import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { accessTokenVerifierFrom, accountVerifierFromAccessToken, createAccessTokenVerifier } from "./createAccessTokenVerifier.js";

// Hermetic (CLAUDE.md: `pnpm validate` is offline) — `accessTokenVerifierFrom` and
// `accountVerifierFromAccessToken` both take an injectable `{ verify }` stub instead of the real
// CognitoJwtVerifier for most of these, so nothing there touches JWKS or the network. The
// `createAccessTokenVerifier` describe block below stays hermetic too, the same way
// createCognitoVerifier.test.ts does: a real RSA keypair signs tokens locally and the matching
// JWK is loaded via `cacheJwks` instead of ever letting the library fetch a JWKS over HTTPS.

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

  it("REJECTS an array-form aud that does not contain the resource, ACCEPTS one that does", async () => {
    await expect(
      accessTokenVerifierFrom({ verify: async () => ({ ...claims, aud: ["https://elsewhere/mcp"] }) }, CANONICAL).verifyAccessToken("t"),
    ).rejects.toThrow(/audience/i);

    // RFC 7519 permits `aud` as a single string OR an array of strings; aws-jwt-verify's own
    // JwtPayload types it that way too. Array form containing the resource must still verify —
    // narrowing to string-only would be a silent outage the day Cognito emits array form.
    await expect(
      accessTokenVerifierFrom({ verify: async () => ({ ...claims, aud: [CANONICAL] }) }, CANONICAL).verifyAccessToken("t"),
    ).resolves.toMatchObject({ clientId: "abc" });
  });

  it("REJECTS construction with an empty resource — a falsy resource would let a no-aud token through", async () => {
    expect(() => accessTokenVerifierFrom({ verify: async () => claims }, "")).toThrow();
  });

  it("REJECTS a token with no client_id claim", async () => {
    const withoutClientId = { sub: claims.sub, aud: claims.aud, scope: claims.scope, exp: claims.exp };
    await expect(accessTokenVerifierFrom({ verify: async () => withoutClientId }, CANONICAL).verifyAccessToken("t")).rejects.toThrow(
      /client_id/i,
    );
  });

  it("REJECTS a token with no numeric exp claim — the exact gap requireBearerAuth throws on", async () => {
    const withoutExp = { sub: claims.sub, aud: claims.aud, scope: claims.scope, client_id: claims.client_id };
    await expect(accessTokenVerifierFrom({ verify: async () => withoutExp }, CANONICAL).verifyAccessToken("t")).rejects.toThrow(
      /exp/i,
    );
  });

  it("splits a multi-scope claim on whitespace, and an empty claim to no scopes", async () => {
    await expect(
      accessTokenVerifierFrom({ verify: async () => ({ ...claims, scope: `${CANONICAL}/read ${CANONICAL}/write` }) }, CANONICAL).verifyAccessToken(
        "t",
      ),
    ).resolves.toMatchObject({ scopes: [`${CANONICAL}/read`, `${CANONICAL}/write`] });

    await expect(
      accessTokenVerifierFrom({ verify: async () => ({ ...claims, scope: "" }) }, CANONICAL).verifyAccessToken("t"),
    ).resolves.toMatchObject({ scopes: [] });

    const withoutScope = { sub: claims.sub, aud: claims.aud, client_id: claims.client_id, exp: claims.exp };
    await expect(accessTokenVerifierFrom({ verify: async () => withoutScope }, CANONICAL).verifyAccessToken("t")).resolves.toMatchObject(
      { scopes: [] },
    );
  });
});

describe("accountVerifierFromAccessToken", () => {
  it("exposes sub through the AccountVerifier adapter the dispatcher needs", async () => {
    const verifier = accountVerifierFromAccessToken({ verify: async () => claims }, CANONICAL);
    await expect(verifier.verify("t")).resolves.toStrictEqual({ sub: "s1" });
  });

  it("rejects a token with no sub claim, rather than passing through undefined", async () => {
    const withoutSub = { aud: claims.aud, scope: claims.scope, client_id: claims.client_id, exp: claims.exp };
    const verifier = accountVerifierFromAccessToken({ verify: async () => withoutSub }, CANONICAL);
    await expect(verifier.verify("t")).rejects.toThrow(/sub/i);
  });

  it("REJECTS a token issued for a different audience — the port's own documented contract", async () => {
    // application/src/ports/accountVerifier.ts: "verify rejects ... on an invalid/expired/
    // wrong-audience bearer token." Fed the real Cognito verifier (tokenUse: "access"), which
    // never checks aud itself, this adapter must enforce that contract itself or it would
    // accept a token bound to a different resource server (or none at all).
    const verifier = accountVerifierFromAccessToken({ verify: async () => ({ ...claims, aud: "https://elsewhere/mcp" }) }, CANONICAL);
    await expect(verifier.verify("t")).rejects.toThrow(/audience/i);
  });
});

// Hermetic JWT verification through the REAL library path (mirrors createCognitoVerifier.test.ts)
// — a real RSA keypair signs tokens locally, and the matching JWK is loaded into the verifier's
// cache via `cacheJwks` rather than ever letting it fetch a JWKS over HTTPS. This is the one
// place that proves parseAuthInfo actually runs on a genuine aws-jwt-verify CognitoAccessTokenPayload
// (tokenUse: "access") and that createAccessTokenVerifier's composition builds and works — the
// stub-based tests above only prove the parsing logic in isolation.
describe("createAccessTokenVerifier — real CognitoJwtVerifier, offline JWKS", () => {
  const USER_POOL_ID = "us-east-1_TestPool1";
  const CLIENT_ID = "test-client-id";
  const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${USER_POOL_ID}`;

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaJwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
  const jwk = { ...rsaJwk, kid: "test-kid", use: "sig", alg: "RS256" };

  const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

  const signJwt = (payload: Record<string, unknown>): string => {
    const header = { alg: "RS256", kid: jwk.kid, typ: "JWT" };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${base64url(signature)}`;
  };

  const nowSec = (): number => Math.floor(Date.now() / 1000);

  const primedRawVerifier = (): ReturnType<typeof CognitoJwtVerifier.create> => {
    const verifier = CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: "access", clientId: CLIENT_ID });
    verifier.cacheJwks({ keys: [jwk] });
    return verifier;
  };

  it("verifies a real access token end to end and returns AuthInfo", async () => {
    const token = signJwt({
      sub: "user-123",
      token_use: "access",
      iss: ISSUER,
      aud: CANONICAL,
      client_id: CLIENT_ID,
      scope: `${CANONICAL}/read`,
      iat: nowSec(),
      exp: nowSec() + 3600,
    });
    // createAccessTokenVerifier itself builds CognitoJwtVerifier.create — reuse its shape here
    // via accessTokenVerifierFrom(primedRawVerifier(), CANONICAL) since createAccessTokenVerifier
    // would otherwise need a live JWKS fetch (it builds its own uncached verifier).
    const verifier = accessTokenVerifierFrom(primedRawVerifier(), CANONICAL);

    const info = await verifier.verifyAccessToken(token);
    expect(info.clientId).toBe(CLIENT_ID);
    expect(info.scopes).toEqual([`${CANONICAL}/read`]);
    expect(typeof info.expiresAt).toBe("number");
  });

  it("REJECTS a real, validly-signed access token bound to a different resource", async () => {
    const token = signJwt({
      sub: "user-123",
      token_use: "access",
      iss: ISSUER,
      aud: "https://elsewhere/mcp",
      client_id: CLIENT_ID,
      scope: `${CANONICAL}/read`,
      iat: nowSec(),
      exp: nowSec() + 3600,
    });
    const verifier = accessTokenVerifierFrom(primedRawVerifier(), CANONICAL);

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/audience/i);
  });

  it("REJECTS a real access token with no aud claim at all — aws-jwt-verify's own client_id check would pass this", async () => {
    const token = signJwt({
      sub: "user-123",
      token_use: "access",
      iss: ISSUER,
      client_id: CLIENT_ID,
      scope: `${CANONICAL}/read`,
      iat: nowSec(),
      exp: nowSec() + 3600,
    });
    const verifier = accessTokenVerifierFrom(primedRawVerifier(), CANONICAL);

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/audience/i);
  });

  it("createAccessTokenVerifier builds an OAuthTokenVerifier from plain config", () => {
    const verifier = createAccessTokenVerifier({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, resource: CANONICAL });
    expect(typeof verifier.verifyAccessToken).toBe("function");
  });
});
