import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { AccountClaims, AccountVerifier } from "@swng/application";

// The minimal shape this adapter actually calls — satisfied by both the real
// CognitoJwtVerifier (createAccessTokenVerifier below, tokenUse: "access") and, in tests, a
// stub `{ verify: async () => claims }` so verification never touches JWKS or the network
// (createAccessTokenVerifier.test.ts). Deliberately returns an untyped record, not
// aws-jwt-verify's own CognitoAccessTokenPayload: that type does not declare `aud` at all for
// an access token (jwt-model.d.ts's CognitoAccessTokenFields has no `aud` field — see below),
// so trusting it here would be exactly the cast CLAUDE.md forbids ("a type must not assert
// what the read path cannot guarantee — parse stored data, never cast it"). Every claim this
// file relies on is checked at the point of use instead.
interface RawVerifier {
  verify(jwt: string): Promise<Record<string, unknown>>;
}

// The AuthInfo shape the MCP SDK's requireBearerAuth expects (design spec §4.3): it throws
// unless the returned value has a numeric `expiresAt`, so that field is never optional here.
// Defined locally rather than imported from @modelcontextprotocol/sdk — this package (adapters
// live behind application's ports; AWS SDKs stay in adapters, CLAUDE.md) doesn't depend on the
// MCP SDK, only the future http/mcp layer that actually calls requireBearerAuth does.
export interface AuthInfo {
  readonly token: string;
  readonly clientId: string;
  readonly scopes: string[];
  readonly expiresAt: number;
}

export interface OAuthTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

// The check aws-jwt-verify does NOT do for an access token. Read from its own source
// (dist/cjs/cognito-verifier.js, validateCognitoJwtFields): when `payload.token_use` is
// "access" it asserts `payload.client_id` against the configured clientId and never reads
// `payload.aud` at all — that branch belongs to `token_use === "id"` only. Cognito puts the
// resource-server identifier requested at `/authorize` (`resource=…`) into `aud` on an access
// token (design spec §4.2, F3); with no `resource` requested there is no `aud` claim at all
// (§4.2, F1). So without this explicit comparison, a token bound to a different resource server
// — or one minted with no resource binding whatsoever — verifies identically to one bound to
// `resource` here. This is the security property this whole file exists for.
const requireAudience = (claims: Record<string, unknown>, resource: string): void => {
  if (claims.aud !== resource) {
    throw new Error(`Token audience does not match required resource "${resource}"`);
  }
};

// Cognito's `scope` claim on an access token is one space-delimited string ("a b c"), not an
// array — splitting an empty string with String.split(" ") yields [""], not [], so the empty
// case is handled explicitly rather than trusted to split cleanly.
const parseScopes = (claims: Record<string, unknown>): string[] => {
  if (claims.scope === undefined) return [];
  if (typeof claims.scope !== "string") throw new Error("Token scope claim is not a string");
  if (claims.scope.length === 0) return [];
  return claims.scope.split(" ");
};

const parseAuthInfo = (token: string, claims: Record<string, unknown>, resource: string): AuthInfo => {
  requireAudience(claims, resource);
  if (typeof claims.client_id !== "string" || claims.client_id.length === 0) {
    throw new Error("Token is missing client_id");
  }
  if (typeof claims.exp !== "number") {
    throw new Error("Token is missing a numeric exp claim");
  }
  return { token, clientId: claims.client_id, scopes: parseScopes(claims), expiresAt: claims.exp };
};

// Adapts anything shaped like aws-jwt-verify's verifier into an OAuthTokenVerifier bound to
// `resource` — exported (not `createAccessTokenVerifier`'s own private detail) so tests can
// hand it a stub verifier instead of the real CognitoJwtVerifier built below, mirroring
// createCognitoVerifier.ts's `…From` split so tests never touch JWKS or the network.
export const accessTokenVerifierFrom = (verifier: RawVerifier, resource: string): OAuthTokenVerifier => ({
  verifyAccessToken: async (token: string): Promise<AuthInfo> => {
    const claims = await verifier.verify(token);
    return parseAuthInfo(token, claims, resource);
  },
});

// The one real implementation — an access-token verifier (tokenUse: "access") for the MCP app
// client, bound to `resource` (CANONICAL, design spec §4.3). Distinct from createCognitoVerifier
// (tokenUse: "id", for the web's hosted-UI sign-in), which stays exactly as it is.
export const createAccessTokenVerifier = (config: { userPoolId: string; clientId: string; resource: string }): OAuthTokenVerifier =>
  accessTokenVerifierFrom(
    CognitoJwtVerifier.create({ userPoolId: config.userPoolId, tokenUse: "access", clientId: config.clientId }),
    config.resource,
  );

// AuthInfo (above) has no `sub` field, but the dispatcher's "golfer" auth tier needs one
// (application's AccountVerifier port) — Task 11 consumes this. Reuses the same RawVerifier
// shape as accessTokenVerifierFrom so both adapters can share one underlying CognitoJwtVerifier
// instance at the call site, and applies the identical parse-don't-cast discipline: a missing
// or non-string `sub` fails closed rather than passing through as `undefined`.
export const accountVerifierFromAccessToken = (verifier: RawVerifier): AccountVerifier => ({
  verify: async (bearer: string): Promise<AccountClaims> => {
    const claims = await verifier.verify(bearer);
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new Error("Token is missing sub");
    }
    return { sub: claims.sub };
  },
});
