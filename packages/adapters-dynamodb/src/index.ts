// The package's one public interface (conventions §2) — consumers (lambda, its tests)
// import "@swng/adapters-dynamodb", never a deep path. `keys.ts` and `testing/local.ts` stay
// internal (table-layout plumbing / contract-test-only tooling that spawns Java, downloads a
// jar — no place in a Lambda bundle), EXCEPT `archiveSk` below: apps/infra-cdk's
// ProjectorFunction event-source filter hand-duplicates this exact literal (swngStack.ts's
// `ARCHIVE_SK`, M7 Task 4) with no compile-time link to keys.ts — exporting it here is what
// lets routesParity.test.ts's sibling, the stack test's `ARCHIVE_SK === archiveSk` pin (M7
// Task 5 rider), catch drift instead of a projector filter that silently never matches.
export { archiveSk } from "./keys.js";
export { createDynamoEventJournal } from "./createDynamoEventJournal.js";
export { createDynamoRoundStore } from "./createDynamoRoundStore.js";
export { createDynamoConnectionRegistry } from "./createDynamoConnectionRegistry.js";
export { createDynamoCourseStore } from "./createDynamoCourseStore.js";
export { createDynamoGolferStore } from "./createDynamoGolferStore.js";
export { createDynamoCrewStore } from "./createDynamoCrewStore.js";
export { createDynamoProjectionStore } from "./createDynamoProjectionStore.js";
export { createDynamoArchiveSource } from "./createDynamoArchiveSource.js";
export { parseArchiveStreamImage } from "./parseArchiveStreamImage.js";
export { createDocumentClient } from "./createDocumentClient.js";
