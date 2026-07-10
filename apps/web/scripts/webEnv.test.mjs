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

  it("writes stripped VITE_HTTP_URL/VITE_WS_URL/pool vars from a cdk-outputs.json-shaped file", () => {
    dir = mkdtempSync(join(tmpdir(), "swng-webenv-"));
    const outputsPath = join(dir, "cdk-outputs.json");
    const envPath = join(dir, ".env.local");
    writeFileSync(
      outputsPath,
      JSON.stringify({
        "swng-beta": {
          HttpApiUrl: "https://example.execute-api.us-east-1.amazonaws.com/",
          WsApiUrl: "wss://ws.example.com/beta",
          UserPoolId: "us-east-1_ABC123",
          UserPoolClientId: "client-abc",
          HostedUiDomain: "https://swng-beta-123.auth.us-east-1.amazoncognito.com/",
        },
      }),
    );

    const result = generateEnvFile(outputsPath, envPath);

    expect(result).toEqual({
      httpUrl: "https://example.execute-api.us-east-1.amazonaws.com",
      wsUrl: "wss://ws.example.com/beta",
      userPoolId: "us-east-1_ABC123",
      userPoolClientId: "client-abc",
      hostedUiDomain: "https://swng-beta-123.auth.us-east-1.amazoncognito.com",
    });
    expect(readFileSync(envPath, "utf8")).toBe(
      "VITE_HTTP_URL=https://example.execute-api.us-east-1.amazonaws.com\n" +
        "VITE_WS_URL=wss://ws.example.com/beta\n" +
        "VITE_USER_POOL_ID=us-east-1_ABC123\n" +
        "VITE_USER_POOL_CLIENT_ID=client-abc\n" +
        "VITE_HOSTED_UI_DOMAIN=https://swng-beta-123.auth.us-east-1.amazoncognito.com\n",
    );
  });

  it("throws when the outputs file has no stack entries, rather than writing a broken .env.local", () => {
    dir = mkdtempSync(join(tmpdir(), "swng-webenv-"));
    const outputsPath = join(dir, "cdk-outputs.json");
    const envPath = join(dir, ".env.local");
    writeFileSync(outputsPath, JSON.stringify({}));

    expect(() => generateEnvFile(outputsPath, envPath)).toThrow(/no stack outputs found/);
  });
});
