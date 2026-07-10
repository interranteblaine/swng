import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { createCognitoVerifier, createCognitoVerifierFrom } from "./createCognitoVerifier.js";

// Hermetic JWT verification (M7 Task 4 brief: "no network in validate") — a real RSA keypair
// signs tokens locally, and the matching JWK is loaded into the verifier's cache via
// `cacheJwks` (aws-jwt-verify's own documented offline path: "Loading the JWKS from file" in
// its README) rather than ever letting it fetch a JWKS over HTTPS. This proves the SAME
// signature-verification and claim-checking code path a real Cognito-issued token would run
// through, just fed a JWKS this test controls instead of a live user pool's.

const USER_POOL_ID = "us-east-1_TestPool1";
const CLIENT_ID = "test-client-id";
// CognitoJwtVerifier.parseUserPoolId's region-format issuer (cognito-verifier.ts) — cacheJwks
// populates both the region and "issuer-cognito-idp" global formats regardless, but the JWT's
// own `iss` claim must match one of them for validateJwtFields to accept it.
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${USER_POOL_ID}`;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaJwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
const jwk = { ...rsaJwk, kid: "test-kid", use: "sig", alg: "RS256" };

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

// Hand-rolls a JWT (header.payload.signature) rather than pulling in a signing library —
// aws-jwt-verify has zero runtime dependencies (its own README's stated philosophy) and this
// package shouldn't add one just to produce test fixtures.
const signJwt = (payload: Record<string, unknown>): string => {
  const header = { alg: "RS256", kid: jwk.kid, typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
};

const nowSec = (): number => Math.floor(Date.now() / 1000);

// A fresh CognitoJwtVerifier per test, primed with the local JWKS — cacheJwks caches by
// issuer, so a fresh instance (rather than a shared module-level one) keeps each test's
// verifier state independent.
const primedVerifier = (): ReturnType<typeof CognitoJwtVerifier.create> => {
  const verifier = CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: "id", clientId: CLIENT_ID });
  verifier.cacheJwks({ keys: [jwk] });
  return verifier;
};

describe("createCognitoVerifierFrom / createCognitoVerifier", () => {
  it("resolves {sub, email} for a valid, freshly-signed ID token", async () => {
    const token = signJwt({
      sub: "user-123",
      email: "ann@example.com",
      token_use: "id",
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: nowSec(),
      exp: nowSec() + 3600,
    });
    const verifier = createCognitoVerifierFrom(primedVerifier());

    await expect(verifier.verify(token)).resolves.toEqual({ sub: "user-123", email: "ann@example.com" });
  });

  it("resolves with email undefined when the token carries no email claim", async () => {
    const token = signJwt({ sub: "user-456", token_use: "id", iss: ISSUER, aud: CLIENT_ID, iat: nowSec(), exp: nowSec() + 3600 });
    const verifier = createCognitoVerifierFrom(primedVerifier());

    await expect(verifier.verify(token)).resolves.toEqual({ sub: "user-456", email: undefined });
  });

  it("rejects an expired token", async () => {
    const token = signJwt({ sub: "user-123", token_use: "id", iss: ISSUER, aud: CLIENT_ID, iat: nowSec() - 7200, exp: nowSec() - 3600 });
    const verifier = createCognitoVerifierFrom(primedVerifier());

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a token minted for a different client (wrong audience)", async () => {
    const token = signJwt({ sub: "user-123", token_use: "id", iss: ISSUER, aud: "some-other-client-id", iat: nowSec(), exp: nowSec() + 3600 });
    const verifier = createCognitoVerifierFrom(primedVerifier());

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a token signed by a DIFFERENT key than the one in the cached JWKS", async () => {
    const otherKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = { alg: "RS256", kid: jwk.kid, typ: "JWT" };
    const payload = { sub: "user-123", token_use: "id", iss: ISSUER, aud: CLIENT_ID, iat: nowSec(), exp: nowSec() + 3600 };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const forged = `${signingInput}.${base64url(cryptoSign("RSA-SHA256", Buffer.from(signingInput), otherKeyPair.privateKey))}`;
    const verifier = createCognitoVerifierFrom(primedVerifier());

    await expect(verifier.verify(forged)).rejects.toThrow();
  });

  it("rejects a garbage (non-JWT-shaped) token", async () => {
    const verifier = createCognitoVerifierFrom(primedVerifier());
    await expect(verifier.verify("not-a-real-token")).rejects.toThrow();
  });

  // createCognitoVerifier itself (not just the injectable createCognitoVerifierFrom) must
  // build a working verifier from plain config — this only proves construction doesn't throw
  // and the shape is right; verify() over cacheJwks-primed behavior is covered above via the
  // shared internals, so this test never lets `verify` actually run (that would require a
  // real network fetch of the (nonexistent) test user pool's JWKS).
  it("createCognitoVerifier builds an AccountVerifier from plain config", () => {
    const verifier = createCognitoVerifier({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID });
    expect(typeof verifier.verify).toBe("function");
  });
});
