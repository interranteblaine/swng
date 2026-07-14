import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { pkceVerifierStore, returnToStore, tokenStore } from "./tokenStore";

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => vi.unstubAllGlobals());

describe("tokenStore", () => {
  it("round-trips tokens through localStorage under the swng:auth key", () => {
    expect(tokenStore.load()).toBeUndefined();

    tokenStore.save({ idToken: "id-1", refreshToken: "refresh-1", expiresAt: 1_000 });

    expect(tokenStore.load()).toEqual({ idToken: "id-1", refreshToken: "refresh-1", expiresAt: 1_000 });
    expect(localStorage.getItem("swng:auth")).toBeTruthy();
  });

  it("clear() removes the stored tokens", () => {
    tokenStore.save({ idToken: "id-1", refreshToken: "refresh-1", expiresAt: 1_000 });
    tokenStore.clear();

    expect(tokenStore.load()).toBeUndefined();
  });

  it("treats a corrupted entry as absent rather than throwing", () => {
    localStorage.setItem("swng:auth", "{not json");

    expect(tokenStore.load()).toBeUndefined();
  });
});

describe("pkceVerifierStore", () => {
  it("take() reads and removes the stored verifier in one step (single-use)", () => {
    pkceVerifierStore.save("verifier-1");

    expect(pkceVerifierStore.take()).toBe("verifier-1");
    expect(pkceVerifierStore.take()).toBeUndefined(); // gone after the first take
  });

  it("returns undefined when nothing was ever stored", () => {
    expect(pkceVerifierStore.take()).toBeUndefined();
  });
});

describe("returnToStore", () => {
  it("take() reads and removes the stashed path in one step (single-use)", () => {
    returnToStore.save("/join?code=ABC123");

    expect(returnToStore.take()).toBe("/join?code=ABC123");
    expect(returnToStore.take()).toBeUndefined(); // gone after the first take — a stale return can't redirect a later sign-in
  });

  it("returns undefined when nothing was ever stashed", () => {
    expect(returnToStore.take()).toBeUndefined();
  });
});
