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

// `resource` is CANONICAL (design spec §4.3) and everything below is measured against it — so
// a bad `resource` at construction time (empty string, or `undefined` arriving from env
// plumbing typed `string | undefined`, per compositionRoot.ts) would make `claims.aud !==
// resource` compare against something falsy and let a no-`aud` token through silently. Guarded
// once here rather than trusted at every call site.
const requireValidResource = (resource: string): void => {
  if (typeof resource !== "string" || resource.length === 0) {
    throw new Error("A non-empty resource is required to construct an access-token verifier");
  }
};

// The check aws-jwt-verify does NOT do for an access token. Read from its own source
// (dist/cjs/cognito-verifier.js, validateCognitoJwtFields): when `payload.token_use` is
// "access" it asserts `payload.client_id` against the configured clientId and never reads
// `payload.aud` at all — that branch belongs to `token_use === "id"` only. Cognito puts the
// resource-server identifier requested at `/authorize` (`resource=…`) into `aud` on an access
// token (design spec §4.2, F3); with no `resource` requested there is no `aud` claim at all
// (§4.2, F1). So without this explicit comparison, a token bound to a different resource server
// — or one minted with no resource binding whatsoever — verifies identically to one bound to
// `resource` here. This is the security property this whole file exists for.
//
// `aud` is normalized to an array before comparison: RFC 7519 permits a JWT audience to be
// either a single string or an array of strings, and aws-jwt-verify's own JwtPayload types it
// `aud?: string | string[]` — so array form must still be checked exactly, not rejected purely
// because it isn't `===` a string (that would fail closed today, since Cognito hasn't been
// observed emitting array form, but a future emission would be a silent full outage rather
// than a handled case).
const requireAudience = (claims: Record<string, unknown>, resource: string): void => {
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(resource)) {
    throw new Error(`Token audience does not match required resource "${resource}"`);
  }
};

// Cognito's `scope` claim on an access token is one space-delimited string ("a b c"), not an
// array. A plain `.split(" ")` on an empty string yields `[""]`, not `[]`, and a doubled or
// leading/trailing space would leave stray empty entries — `.split(/\s+/).filter(...)` avoids
// both without weakening the check (still every whitespace-delimited token, still no empties).
const parseScopes = (claims: Record<string, unknown>): string[] => {
  if (claims.scope === undefined) return [];
  if (typeof claims.scope !== "string") throw new Error("Token scope claim is not a string");
  return claims.scope.split(/\s+/).filter((scope) => scope.length > 0);
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
export const accessTokenVerifierFrom = (verifier: RawVerifier, resource: string): OAuthTokenVerifier => {
  requireValidResource(resource);
  return {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const claims = await verifier.verify(token);
      return parseAuthInfo(token, claims, resource);
    },
  };
};

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
//
// Takes `resource` and runs the SAME `requireAudience` check accessTokenVerifierFrom does —
// application/src/ports/accountVerifier.ts's own doc comment states the port's contract is
// "rejects ... on an invalid/expired/wrong-audience bearer token," true of createCognitoVerifier
// (the library checks `aud` on id tokens) and would be silently false here otherwise: fed the
// real Cognito verifier, this adapter would accept a token bound to a different resource server,
// or to none, with nothing else in front of it enforcing that today.
export const accountVerifierFromAccessToken = (verifier: RawVerifier, resource: string): AccountVerifier => {
  requireValidResource(resource);
  return {
    verify: async (bearer: string): Promise<AccountClaims> => {
      const claims = await verifier.verify(bearer);
      requireAudience(claims, resource);
      if (typeof claims.sub !== "string" || claims.sub.length === 0) {
        throw new Error("Token is missing sub");
      }
      return { sub: claims.sub };
    },
  };
};
