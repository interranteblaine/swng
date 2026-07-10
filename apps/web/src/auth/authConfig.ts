// Cognito Hosted UI config + the authorization-code+PKCE plumbing (M7 Task 6) — same
// "throws loudly at import time if a var is missing" contract as config.ts, one directory
// over, and generated the same way (scripts/webEnv.mjs, extended alongside this file).
export class AuthConfigError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AuthConfigError";
  }
}

const requireEnv = (key: "VITE_USER_POOL_ID" | "VITE_USER_POOL_CLIENT_ID" | "VITE_HOSTED_UI_DOMAIN"): string => {
  const value = import.meta.env[key];
  if (!value) {
    throw new AuthConfigError("missing-env", `${key} is not set — run \`node scripts/webEnv.mjs\` to generate .env.local, or set it before starting the dev server.`);
  }
  return value;
};

// Strips a trailing slash the same way webEnv.mjs's own stripTrailingSlash does for
// HttpApiUrl/WsApiUrl — cdk-outputs.json's HostedUiDomain (CDK's userPoolDomain.baseUrl())
// is not observed to carry one, but defensively matching the sibling endpoints' own rule
// costs nothing and avoids a doubled slash in every URL built below.
const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

export interface AuthConfig {
  readonly hostedUiDomain: string;
  readonly userPoolClientId: string;
  readonly userPoolId: string;
  // `/auth/callback` — AuthCallbackPage's own route (App.tsx) — not the bare origin: Cognito
  // requires an EXACT match against a registered callback URL, so a beta redeploy that widens
  // WEB_ORIGINS to include this path is a prerequisite for a real Hosted-UI round trip to
  // complete end to end (flagged for the controller; out of this web-only task's scope).
  readonly redirectUri: string;
}

export const authConfig: AuthConfig = {
  hostedUiDomain: stripTrailingSlash(requireEnv("VITE_HOSTED_UI_DOMAIN")),
  userPoolClientId: requireEnv("VITE_USER_POOL_CLIENT_ID"),
  userPoolId: requireEnv("VITE_USER_POOL_ID"),
  redirectUri: `${window.location.origin}/auth/callback`,
};

export const tokenEndpoint = (): string => `${authConfig.hostedUiDomain}/oauth2/token`;

// response_type=code + PKCE (S256) — the SPA client has no secret (CDK: generateSecret false),
// so PKCE is what proves this callback belongs to the same party that started the flow.
export const buildAuthorizeUrl = (codeChallenge: string): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: authConfig.userPoolClientId,
    redirect_uri: authConfig.redirectUri,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${authConfig.hostedUiDomain}/oauth2/authorize?${params.toString()}`;
};

// Raw bytes -> base64url (RFC 7636 §A) — plain btoa's alphabet ('+/=') isn't URL-safe, so every
// PKCE value (verifier and challenge alike) goes through this before it's ever stored or sent.
const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// 32 random bytes (well above RFC 7636's 43-character minimum once base64url-encoded) —
// crypto.getRandomValues, not Math.random: this is a security-bearing value, not a UI id like
// identity.ts's tabDeviceId.
export const generateCodeVerifier = (): string => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

// S256: SHA-256 the verifier, then the same base64url encoding — crypto.subtle is genuinely
// present in this app's test environment (happy-dom's window.crypto is Node's own webcrypto,
// confirmed before writing this), so this needs no test-only polyfill or injection seam.
export const computeCodeChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
};
