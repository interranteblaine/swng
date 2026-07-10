import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { AccountClaims, AccountVerifier } from "@swng/application";

// The minimal shape this adapter actually calls — satisfied by both the real
// CognitoJwtVerifier (createCognitoVerifier below) and, in tests, a CognitoJwtVerifier primed
// with `cacheJwks` so verification never hits the network (createCognitoVerifier.test.ts).
interface RawVerifier {
  verify(jwt: string): Promise<{ sub: string; email?: unknown }>;
}

// Adapts anything shaped like aws-jwt-verify's verifier into this package's AccountVerifier
// port — exported (not `createCognitoVerifier`'s own private detail) so tests can hand it a
// verifier whose JWKS was injected locally, instead of the one createCognitoVerifier always
// builds fresh below. `verify` rejects (aws-jwt-verify's own behavior — a bad signature,
// expired token, or wrong issuer/audience all throw, never resolve falsy); the dispatcher
// (lambda/http/dispatch.ts) maps that rejection to `invalid-token`, same as a failed
// participant-token verify.
export const createCognitoVerifierFrom = (verifier: RawVerifier): AccountVerifier => ({
  verify: async (bearer: string): Promise<AccountClaims> => {
    const payload = await verifier.verify(bearer);
    return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
  },
});

// The one real implementation (M7 Task 4) — an ID token verifier (tokenUse: "id") for the
// given user pool/client: the hosted UI's authorization-code+PKCE flow returns an ID token
// carrying `sub`/`email`, unlike an access token, which carries scopes but no email claim.
export const createCognitoVerifier = (config: { userPoolId: string; clientId: string }): AccountVerifier =>
  createCognitoVerifierFrom(CognitoJwtVerifier.create({ userPoolId: config.userPoolId, tokenUse: "id", clientId: config.clientId }));
