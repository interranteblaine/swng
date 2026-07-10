import { buildProjector } from "../compositionRoot.js";

// Composition happens ONCE at module scope (Lambda cold start) — see entries/http.ts. Wired
// as the DynamoDB Streams event source on the rounds table's ARCHIVE items (apps/infra-cdk/
// lib/swngStack.ts): every finalized round's archive lands here and gets folded into a
// golfer's history/index projections (the SAME projectArchive the manual rebuild entry uses).
const app = buildProjector(process.env);

export const handler = app.handler;
