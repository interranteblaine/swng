import { describe, expect, it } from "vitest";
import { authConfig, buildAuthorizeUrl, buildLogoutUrl, computeCodeChallenge, generateCodeVerifier, tokenEndpoint } from "./authConfig";

// vitest.config.ts pins VITE_HOSTED_UI_DOMAIN/VITE_USER_POOL_CLIENT_ID/VITE_USER_POOL_ID —
// same "hermetic, no real .env.local needed" contract as config.test.ts's own pinned fakes.
describe("authConfig", () => {
  it("reads the pool config from Vite env, with a trailing slash stripped from the domain", () => {
    expect(authConfig.hostedUiDomain).toBe("https://swng-test.auth.us-east-1.amazoncognito.com");
    expect(authConfig.userPoolClientId).toBe("test-client-id");
    expect(authConfig.userPoolId).toBe("us-east-1_TESTPOOL");
  });

  it("redirectUri points at /auth/callback under the current origin", () => {
    expect(authConfig.redirectUri).toMatch(/\/auth\/callback$/);
  });
});

describe("tokenEndpoint", () => {
  it("is the hosted UI domain's /oauth2/token", () => {
    expect(tokenEndpoint()).toBe("https://swng-test.auth.us-east-1.amazoncognito.com/oauth2/token");
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the Hosted UI's /oauth2/authorize URL with response_type=code, PKCE S256, and this app's redirect_uri", () => {
    const url = new URL(buildAuthorizeUrl("challenge-abc"));

    expect(`${url.origin}${url.pathname}`).toBe("https://swng-test.auth.us-east-1.amazoncognito.com/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(authConfig.redirectUri);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });
});

// Papercut 6 (M9 hardening): the Hosted UI's own /logout endpoint, not a bare local sign-out.
describe("buildLogoutUrl", () => {
  it("builds the Hosted UI's /logout URL with this app's client_id and a trailing-slash logout_uri matching swngStack.ts's registered logoutUrls", () => {
    const url = new URL(buildLogoutUrl());

    expect(`${url.origin}${url.pathname}`).toBe("https://swng-test.auth.us-east-1.amazoncognito.com/logout");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("logout_uri")).toBe(`${window.location.origin}/`);
  });
});

describe("PKCE: generateCodeVerifier + computeCodeChallenge", () => {
  it("generates a URL-safe verifier with no padding/plus/slash characters", () => {
    const verifier = generateCodeVerifier();

    expect(verifier.length).toBeGreaterThanOrEqual(43); // RFC 7636 §4.1 minimum
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("generates a fresh verifier on every call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it("computes a real S256 challenge — matches an independent SHA-256+base64url computation over the same verifier", async () => {
    const verifier = "a-fixed-test-verifier-value-thats-long-enough";

    const challenge = await computeCodeChallenge(verifier);

    const expectedDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(expectedDigest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expectedChallenge);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/); // URL-safe, no padding
  });
});
