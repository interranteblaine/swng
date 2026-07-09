import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateEnvFile, stripTrailingSlash } from "./webEnv.mjs";

describe("stripTrailingSlash", () => {
  it("removes a single trailing slash", () => {
    expect(stripTrailingSlash("https://api.example.com/")).toBe("https://api.example.com");
  });

  it("removes multiple trailing slashes", () => {
    expect(stripTrailingSlash("https://api.example.com///")).toBe("https://api.example.com");
  });

  it("leaves a URL with no trailing slash untouched", () => {
    expect(stripTrailingSlash("wss://ws.example.com/beta")).toBe("wss://ws.example.com/beta");
  });
});

describe("generateEnvFile", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes stripped VITE_HTTP_URL/VITE_WS_URL from a cdk-outputs.json-shaped file", () => {
    dir = mkdtempSync(join(tmpdir(), "swng-webenv-"));
    const outputsPath = join(dir, "cdk-outputs.json");
    const envPath = join(dir, ".env.local");
    writeFileSync(
      outputsPath,
      JSON.stringify({ "swng-beta": { HttpApiUrl: "https://example.execute-api.us-east-1.amazonaws.com/", WsApiUrl: "wss://ws.example.com/beta" } }),
    );

    const result = generateEnvFile(outputsPath, envPath);

    expect(result).toEqual({ httpUrl: "https://example.execute-api.us-east-1.amazonaws.com", wsUrl: "wss://ws.example.com/beta" });
    expect(readFileSync(envPath, "utf8")).toBe("VITE_HTTP_URL=https://example.execute-api.us-east-1.amazonaws.com\nVITE_WS_URL=wss://ws.example.com/beta\n");
  });

  it("throws when the outputs file has no stack entries, rather than writing a broken .env.local", () => {
    dir = mkdtempSync(join(tmpdir(), "swng-webenv-"));
    const outputsPath = join(dir, "cdk-outputs.json");
    const envPath = join(dir, ".env.local");
    writeFileSync(outputsPath, JSON.stringify({}));

    expect(() => generateEnvFile(outputsPath, envPath)).toThrow(/no stack outputs found/);
  });
});
