import { afterEach, describe, expect, it, vi } from "vitest";

// config.ts throws AT IMPORT TIME (module top-level), so each case needs its own fresh
// module instance — vi.resetModules() + a dynamic import, rather than the static import
// every other test file in this package uses.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config", () => {
  it("reads httpUrl/wsUrl from the Vite env", async () => {
    vi.stubEnv("VITE_HTTP_URL", "https://api.example.test");
    vi.stubEnv("VITE_WS_URL", "wss://ws.example.test");

    const { config } = await import("./config");

    expect(config).toEqual({ httpUrl: "https://api.example.test", wsUrl: "wss://ws.example.test" });
  });

  it("throws a coded ConfigError at import time when VITE_HTTP_URL is missing", async () => {
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "wss://ws.example.test");

    await expect(import("./config")).rejects.toMatchObject({ code: "missing-env" });
  });

  it("throws a coded ConfigError at import time when VITE_WS_URL is missing", async () => {
    vi.stubEnv("VITE_HTTP_URL", "https://api.example.test");
    vi.stubEnv("VITE_WS_URL", "");

    await expect(import("./config")).rejects.toMatchObject({ code: "missing-env" });
  });
});
