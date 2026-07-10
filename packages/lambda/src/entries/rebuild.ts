import { buildRebuild } from "../compositionRoot.js";

// Composition happens ONCE at module scope (Lambda cold start) — see entries/http.ts. Manual
// invoke only (apps/infra-cdk/lib/swngStack.ts wires NO event source to this function) — an
// operator runs it to recover from a projections bug or data-loss incident by replaying every
// archive in the rounds table from scratch (application/src/projections/rebuildProjections.ts).
//
// Operator note (accepted for beta — see the wipe-replay window documented on
// rebuildProjections.ts itself): a round finalizing WHILE this is running can have its
// projection wiped and then missed by this same run, since the archive Scan the rebuild reads
// from is taken before the wipe step runs. Prefer invoking this during a quiet period; if a
// finalize might have landed mid-run, just invoke it again.
const app = buildRebuild(process.env);

export const handler = app.handler;
