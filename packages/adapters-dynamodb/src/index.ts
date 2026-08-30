// The package's one public interface (conventions §2) — consumers (lambda, its tests)
// import "@swng/adapters-dynamodb", never a deep path. `keys.ts` and `testing/local.ts` stay
// internal (table-layout plumbing / contract-test-only tooling that spawns Java, downloads a
// jar — no place in a Lambda bundle). The projector's stream source needs no key literal
// anymore (the snapshots table's stream is unfiltered — every item IS a finished round), so the
// old `archiveSk` export the ARCHIVE-filter test pinned is gone with the filter.
export { createDynamoEventJournal } from "./createDynamoEventJournal.js";
export { createDynamoRoundStore } from "./createDynamoRoundStore.js";
export { createDynamoConnectionRegistry } from "./createDynamoConnectionRegistry.js";
// Course-cards spec: the write-once card-lineage store — the M6 createDynamoCourseStore
// aggregate it replaced is deleted whole.
export { createDynamoCardStore } from "./createDynamoCardStore.js";
export { createDynamoGolferStore } from "./createDynamoGolferStore.js";
export { createDynamoCrewStore } from "./createDynamoCrewStore.js";
export { createDynamoProjectionStore } from "./createDynamoProjectionStore.js";
export { createDynamoSnapshotStore } from "./createDynamoSnapshotStore.js";
export { parseSnapshotStreamImage } from "./parseSnapshotStreamImage.js";
// Spec 2026-07-30 §10: the codes this package's read paths throw when stored data doesn't match
// its schema. The parse functions themselves stay internal — these two strings are exported only
// because they are the contract with the lambda's error boundary, which pins their behaviour
// against the real names rather than invented ones.
export { STORED_ARCHIVE_INVALID, STORED_EVENT_INVALID } from "./parseStored.js";
export { createDocumentClient } from "./createDocumentClient.js";
// The OAuth mediation store (swng-speaks-mcp design §4.3, Task 14): registered DCR clients,
// recorded /authorize requests, opaque authorization codes, and opaque refresh handles — the
// short-lived state that lets mcp.swng.golf mediate while Cognito stays the only token issuer.
export { createDynamoOAuthStore } from "./createDynamoOAuthStore.js";
export type { OAuthStore } from "./createDynamoOAuthStore.js";
// These lifetimes are exported as VALUES for one reason: /token's own test fake has to reproduce
// the store's single-use code expiry and its rotation grace, and a hard-coded 60_000 / 30_000
// there would silently desync the moment a constant moved. Consumers import them from the package
// root, never a deep path.
export { CODE_TTL_MS, HANDLE_GRACE_MS, HANDLE_TTL_MS } from "./createDynamoOAuthStore.js";
