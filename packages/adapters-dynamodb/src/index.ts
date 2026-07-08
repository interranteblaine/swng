// The package's one public interface (conventions §2) — consumers (lambda, its tests)
// import "@swng/adapters-dynamodb", never a deep path. `keys.ts` and `testing/local.ts` stay
// internal: the former is table-layout plumbing, the latter is contract-test-only tooling
// (it spawns Java, downloads a jar) with no place in a Lambda bundle.
export { createDynamoEventJournal } from "./createDynamoEventJournal.js";
export { createDynamoRoundStore } from "./createDynamoRoundStore.js";
export { createDynamoConnectionRegistry } from "./createDynamoConnectionRegistry.js";
export { createDocumentClient } from "./createDocumentClient.js";
