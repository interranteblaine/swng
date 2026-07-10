import { buildRebuild } from "../compositionRoot.js";

// Composition happens ONCE at module scope (Lambda cold start) — see entries/http.ts. Manual
// invoke only (apps/infra-cdk/lib/swngStack.ts wires NO event source to this function) — an
// operator runs it to recover from a projections bug or data-loss incident by replaying every
// archive in the rounds table from scratch (application/src/projections/rebuildProjections.ts).
const app = buildRebuild(process.env);

export const handler = app.handler;
