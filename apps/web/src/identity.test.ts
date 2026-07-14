import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import { credentialStore, tabDeviceId } from "./identity";

// A minimal Storage stand-in — `class X implements Storage` fights TS over Storage's string
// index signature for no payoff here, so this is a plain object cast the same way
// packages/client/src/transport.test.ts casts its fakeResponse to Response.
const createMemoryStorage = (): Storage => {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tabDeviceId", () => {
  it("is stable across repeated calls within the same tab", () => {
    vi.stubGlobal("sessionStorage", createMemoryStorage());

    expect(tabDeviceId()).toBe(tabDeviceId());
  });

  it("is distinct across a fresh tab's storage", () => {
    vi.stubGlobal("sessionStorage", createMemoryStorage());
    const idA = tabDeviceId();

    vi.stubGlobal("sessionStorage", createMemoryStorage()); // simulates a fresh tab's own, empty sessionStorage
    const idB = tabDeviceId();

    expect(idB).not.toBe(idA);
  });
});

describe("credentialStore", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
  });

  it("round-trips a saved credential", () => {
    const id = roundId("round-1");
    const credential = { token: "tok-abc", golferId: golferId("ann"), name: "Ann", joinCode: "ABC123" };

    credentialStore.save(id, credential);

    expect(credentialStore.load(id)).toEqual(credential);
  });

  it("returns undefined for a round with no saved credential", () => {
    expect(credentialStore.load(roundId("nope"))).toBeUndefined();
  });
});
