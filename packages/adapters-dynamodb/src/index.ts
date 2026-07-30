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
