// The package's one public interface (conventions §2) — consumers (lambda, its tests)
// import "@swng/adapters-dynamodb", never a deep path. `keys.ts` and `testing/local.ts` stay
// internal (table-layout plumbing / contract-test-only tooling that spawns Java, downloads a
// jar — no place in a Lambda bundle). The projector's stream source needs no key literal
// anymore (the snapshots table's stream is unfiltered — every item IS a finished round), so the
// old `archiveSk` export the ARCHIVE-filter test pinned is gone with the filter.
export { createDynamoEventJournal } from "./createDynamoEventJournal.js";
export { createDynamoRoundStore } from "./createDynamoRoundStore.js";
export { createDynamoConnectionRegistry } from "./createDynamoConnectionRegistry.js";
export { createDynamoCourseStore } from "./createDynamoCourseStore.js";
// Course-cards spec: the new write-once-lineage store lands BESIDE createDynamoCourseStore
// (T4 switches consumers and deletes the old pair).
export { createDynamoCardStore } from "./createDynamoCardStore.js";
export { createDynamoGolferStore } from "./createDynamoGolferStore.js";
export { createDynamoCrewStore } from "./createDynamoCrewStore.js";
export { createDynamoProjectionStore } from "./createDynamoProjectionStore.js";
export { createDynamoSnapshotStore } from "./createDynamoSnapshotStore.js";
export { parseSnapshotStreamImage } from "./parseSnapshotStreamImage.js";
export { createDocumentClient } from "./createDocumentClient.js";
