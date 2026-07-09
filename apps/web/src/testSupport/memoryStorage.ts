// A minimal Storage stand-in — `class X implements Storage` fights TS over Storage's string
// index signature for no payoff here, so this is a plain object cast the same way
// packages/client/src/transport.test.ts casts its fakeResponse to Response. Shared because
// every route test that touches credentialStore (Home/Create/Join/RoundPage) needs its own
// isolated localStorage, not happy-dom's real one shared across the whole test file.
export const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as Storage;
};
