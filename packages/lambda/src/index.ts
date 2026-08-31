// The package's one public interface (conventions §2). Consumers are its own tests and
// (indirectly) apps/infra-cdk, which points NodejsFunction at the files under src/entries/
// directly rather than through this barrel — those are the actual Lambda entry points, each
// building its own `App` at module scope (compositionRoot.ts).
export { buildApp, buildProjector, buildRebuild, createProjectorHandler } from "./compositionRoot.js";
export type { App, ProjectorApp, RebuildApp } from "./compositionRoot.js";

export { createHmacTokenIssuer } from "./auth/hmacTokenIssuer.js";

export { buildRoutes } from "./http/routes.js";
export type { Route, RouteContext, UseCases } from "./http/routes.js";
export { createDispatcher } from "./http/dispatch.js";
export type { HttpRequest, HttpResponse } from "./http/httpRequest.js";
export { toHttpError } from "./http/errorMapping.js";

// swng-speaks-mcp Task 20: apps/infra-cdk declares the MCP API's route table and the Cognito app
// client's callback URL as its own literals — a `cdk deploy` runs bin/infra-cdk.ts through
// ts-node with no build step, so the stack cannot import this package at synth time. What it CAN
// do is pin those literals against these constants in a test (test/mcpCanonical.test.ts), the
// same mechanism routesParity.test.ts already gives HTTP_ROUTES. Exported for that guard.
export {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  CALLBACK_PATH,
  CONSENT_SUBMIT_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
} from "./oauth/paths.js";
export { CIMD_FETCH_FAILED } from "./oauth/clients.js";
export { readScopeOf, writeScopeOf } from "./oauth/authorize.js";
