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
export { toHttpError } from "./http/errorMapping.js";
