import type { RoundId } from "@swng/domain";
import type { OutboxStore, PersistedSync } from "./outbox.js";

const STORE_NAME = "sync";

// The browser-durable OutboxStore adapter: one IndexedDB object store, keyed by roundId,
// holding the whole PersistedSync shape per round. `indexedDb` is injectable (tests use
// fake-indexeddb's IDBFactory) instead of always reading the browser global.
export const createIndexedDbOutboxStore = (config: { databaseName?: string; indexedDb?: IDBFactory } = {}): OutboxStore => {
  const databaseName = config.databaseName ?? "swng-client-outbox";
  // globalThis.indexedDB (not a bare `indexedDB` reference) so this module never throws a
  // ReferenceError merely by being imported/evaluated outside a browser — only calling
  // load/save without an injected factory would ever touch it.
  const idbFactory = config.indexedDb ?? globalThis.indexedDB;

  // Opened once and reused for the lifetime of this store instance — OutboxStore has no
  // dispose/close in its interface, so a fresh connection only happens when the caller
  // constructs a fresh store (that's what "app restarted" means for this adapter).
  let dbPromise: Promise<IDBDatabase> | undefined;
  const openDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = idbFactory.open(databaseName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error as Error);
      });
    }
    return dbPromise;
  };

  return {
    load: async (roundId: RoundId): Promise<PersistedSync | undefined> => {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(roundId);
        request.onsuccess = () => resolve(request.result as PersistedSync | undefined);
        request.onerror = () => reject(request.error as Error);
      });
    },
    save: async (roundId: RoundId, sync: PersistedSync): Promise<void> => {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(sync, roundId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    },
  };
};
