import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/server";

// `import type` only (task-15 brief, design spec §3.4): mcpAuth carries no MCP SDK runtime —
// Claude allows 10s for discovery, so these two well-known documents are hand-authored constants
// typed against the SDK's shapes, which erase at build. A value import here would pull the SDK
// runtime into the bundle Task 19 greps for exactly that.
//
// `resource` is the ONE constant entries/mcp.ts reads via `requireEnv(env, "MCP_RESOURCE")`
// (:127) and is handed in here as a parameter — never re-read from env, never re-derived, never
// hardcoded. Every URL below is derived from it, once: `readScope` is CANONICAL + "/read" (the
// sibling of entries/mcp.ts's own `writeScope = CANONICAL + "/write"`, :130), and the
// authorization-server origin is `new URL(resource).origin` — design spec §4.3's "mcp.swng.golf
// is an authorization server that mediates": the same host that serves `resource`'s path also
// serves /authorize, /token and /register, so the origin is read out of `resource` itself rather
// than assembled from a second env var that could drift from it.

const readScope = (resource: string): string => `${resource}/read`;

/**
 * RFC 9728 Protected Resource Metadata — served at
 * `.well-known/oauth-protected-resource/mcp`, per `getOAuthProtectedResourceMetadataUrl`
 * (entries/mcp.ts:124), which is what a 401 challenge points a client at BEFORE it can
 * authenticate at all.
 *
 * Advertises the read scope only (task-15 brief): write is granted at the consent page
 * (design spec §4.4), never by a runtime step-up a resource-metadata document could invite.
 */
export const buildProtectedResourceMetadata = (resource: string): OAuthProtectedResourceMetadata => {
  const { origin } = new URL(resource);

  return {
    resource,
    authorization_servers: [origin],
    scopes_supported: [readScope(resource)],
  };
};

/**
 * RFC 8414 Authorization Server Metadata — served at `.well-known/oauth-authorization-server`.
 * Cognito stays the token issuer (design spec §4.3); `resource`'s own origin is the
 * authorization server that mediates, so `issuer` and every endpoint below are that origin, not
 * Cognito's.
 */
export const buildAuthorizationServerMetadata = (resource: string): OAuthMetadata => {
  const { origin } = new URL(resource);

  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: [readScope(resource)],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Design spec §4.1: Claude picks CIMD over DCR only when BOTH of the next two flags are
    // advertised together; either alone falls back to DCR.
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    // RFC 9207 issuer identification in the authorization response (design spec §4.3, step 3:
    // the 302 back to the client carries `iss` alongside `code` and `state`).
    authorization_response_iss_parameter_supported: true,
    // A client-side MUST-refuse-to-proceed if absent (design spec §4.3) — omitting this fails
    // every connection before it starts.
    code_challenge_methods_supported: ["S256"],
  };
};
