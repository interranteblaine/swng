// Every path the mediating authorization server serves, in ONE place (design spec §3's diagram).
//
// WHY THIS FILE EXISTS (fix round 1, Minor 4). Three of these paths used to be typed twice: once
// as the router's switch arm in entries/mcpAuth.ts and once as a literal inside the RFC 8414
// document metadata.ts builds — joined by nothing but two independently hardcoded copies in two
// test files. Renaming an endpoint the natural way (the module and its own test together) left
// the router untouched and the whole suite green, while the deployed AS metadata advertised an
// endpoint that answers 404. `authorize.ts` already learned this lesson on MAX_REDIRECT_URI_LENGTH
// and says it best: a comment is not a mechanism.
//
// So the ADVERTISED endpoint and the SERVED endpoint are now the same constant, and the two
// well-known documents' own paths sit beside them because they are the same class of fact.
// Nothing here is stage-dependent — only the origin these hang off is, and that is derived from
// the one canonical resource (metadata.ts, entries/mcpAuth.ts).

// RFC 9728 §3.1 / RFC 8414 §3.1. The protected-resource document is additionally served with the
// resource's own path appended (entries/mcpAuth.ts derives that form); the authorization-server
// document is served at this bare path ONLY — its issuer is the origin, and RFC 8414 §3.3 has a
// client refuse a document whose issuer disagrees with where it was fetched from.
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

// The three endpoints the AS metadata document advertises by name.
export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";

// The two the browser leg walks: the path Cognito's app client is configured to redirect back to
// (both legs share it), and the path this AS's own consent form posts to. Re-exported from
// authorize.ts, which is where every caller already reaches for them.
export const CALLBACK_PATH = "/oauth/callback";
export const CONSENT_SUBMIT_PATH = "/oauth/consent";
