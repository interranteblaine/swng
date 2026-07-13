import { buildRebuild } from "../compositionRoot.js";

// Composition happens ONCE at module scope (Lambda cold start) — see entries/http.ts. Manual
// invoke only (apps/infra-cdk/lib/swngStack.ts wires NO event source to this function) — an
// operator runs it to recover from a projections bug or data-loss incident by replaying every
// snapshot from scratch, one page at a time (application/src/projections/rebuildProjections.ts).
//
// Paged, not a single Scan-then-wipe-then-replay: the event/response IS the use case's own
// `{ cursor?, maxSnapshots? }` in / `{ processed, cursor? }` out (compositionRoot.ts's
// RebuildApp doc comment) — an operator invokes this repeatedly, passing the returned `cursor`
// back in, until a response comes back with none. There is no wipe step and therefore no race
// to caution about here: rebuildProjections.ts's own doc comment covers why a partial or
// out-of-order run can never leave stale or missing-then-unrepaired data behind.
const app = buildRebuild(process.env);

export const handler = app.handler;
