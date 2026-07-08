import { buildApp } from "../compositionRoot.js";

// Composition happens ONCE at module scope (Lambda cold start), never per invocation
// (conventions §3, M3 plan) — every warm invocation of this handler reuses the same
// dispatcher/journal/store/broadcast/tokens.
const app = buildApp(process.env);

export const handler = app.dispatcher;
