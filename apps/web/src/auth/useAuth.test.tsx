import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId } from "@swng/domain";
import { getMyRecord } from "../api";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { tokenStore } from "./tokenStore";
import { AuthProvider, useAuth } from "./useAuth";

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// A well-formed-shaped JWT with no real signature — decodeIdTokenEmail only ever reads the
// payload segment, never verifies it (that's the server's job), so this is enough to drive it.
const fakeIdToken = (claims: Record<string, unknown>): string => `${base64url({ alg: "none" })}.${base64url(claims)}.sig`;

function Harness() {
  const auth = useAuth();
  const [callResult, setCallResult] = useState("");

  return (
    <div>
      <p data-testid="signedIn">{String(auth.signedIn)}</p>
      <p data-testid="golfer">{auth.golfer === undefined ? "undefined" : auth.golfer === null ? "null" : auth.golfer.name}</p>
      <p data-testid="email">{auth.email ?? ""}</p>
      <button type="button" onClick={() => auth.signIn()}>
        Sign in
      </button>
      <button type="button" onClick={() => auth.signOut()}>
        Sign out
      </button>
      <button type="button" onClick={() => void auth.refetch()}>
        Refetch
      </button>
      <button type="button" onClick={() => auth.applyGolfer({ golferId: golferId("ann"), name: "Ann Applied", indexSource: { kind: "whs" } })}>
        Apply golfer
      </button>
      <button
        type="button"
        onClick={() =>
          void auth
            .withAuth((token) => getMyRecord(token))
            .then(() => setCallResult("ok"))
            .catch((caught: unknown) => setCallResult(`error:${caught instanceof Error ? caught.name : "unknown"}`))
        }
      >
        Call record
      </button>
      <p data-testid="callResult">{callResult}</p>
    </div>
  );
}

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthProvider / useAuth — signed out", () => {
  it("reports signed-out with no golfer, and never calls fetch when no tokens are saved", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    expect(screen.getByTestId("signedIn").textContent).toBe("false");
    expect(screen.getByTestId("golfer").textContent).toBe("undefined");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("AuthProvider / useAuth — signed in", () => {
  it("loads saved tokens, GETs /me once, and exposes the returned golfer", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-1", email: "ann@example.com" }), refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } }));
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann"));
    expect(screen.getByTestId("signedIn").textContent).toBe("true");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer " + fakeIdToken({ sub: "sub-1", email: "ann@example.com" }));
  });

  // Controller amendment 1: GET /me never creates — a signed-in user with no golfer row gets
  // `golfer: null`, and the header/auto-fill fallback is the ID token's own email claim.
  it("golfer: null (no row yet) falls back to the ID token's email for display", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-2", email: "fresh@example.com" }), refreshToken: "refresh-2", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: null })),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("null"));
    expect(screen.getByTestId("email").textContent).toBe("fresh@example.com");
  });

  it("signOut() clears storage and reverts to signed-out", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-1" }), refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } })),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann"));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(screen.getByTestId("signedIn").textContent).toBe("false");
    expect(screen.getByTestId("golfer").textContent).toBe("undefined");
    expect(tokenStore.load()).toBeUndefined();
  });

  // Papercut 6 (M9 hardening): signOut clears local tokens AND ends the Hosted UI's own
  // session by redirecting through Cognito's /logout — otherwise the next signIn() silently
  // resumes the same account. Same window.location seam as the PKCE signIn redirect test
  // below (happy-dom actually updates window.location.href on assign, no extra mock needed).
  it("signOut() redirects to the Hosted UI's /logout URL, after clearing tokens", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-1" }), refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } })),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann"));

    // Captured BEFORE the redirect — window.location.origin itself changes once the assign
    // below actually navigates, so this is the app's own origin the logout_uri must echo.
    const appOrigin = window.location.origin;

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(new URL(window.location.href).pathname).toBe("/logout"));
    const url = new URL(window.location.href);
    expect(url.origin).toBe("https://swng-test.auth.us-east-1.amazoncognito.com");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("logout_uri")).toBe(`${appOrigin}/`);
  });

  it("refetch() re-runs GET /me on demand (e.g. after a claim/profile save elsewhere)", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-1" }), refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: call === 1 ? "Ann" : "Ann Updated" } });
      }),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann"));

    fireEvent.click(screen.getByRole("button", { name: "Refetch" }));

    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann Updated"));
    expect(call).toBe(2);
  });

  // applyGolfer replaces `golfer` in place from a view the caller already holds (a PUT /me
  // response) — the one-request counterpart to refetch: NO GET /me fires across the call.
  it("applyGolfer() sets the golfer in place with no GET /me refetch", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-1" }), refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    const fetchSpy = vi.fn(async () => fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } }));
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann"));
    // The one mount GET /me has fired; applyGolfer must not add a second network call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Apply golfer" }));

    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann Applied"));
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no refetch — the view was applied directly
  });
});

describe("AuthProvider / useAuth — sign-in redirect (PKCE)", () => {
  it("signIn() redirects to the Hosted UI with a code_challenge matching the stored verifier", async () => {
    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // computeCodeChallenge awaits a real crypto.subtle.digest — genuinely async, not just a
    // microtask — so this polls rather than assuming a fixed number of flushes.
    await waitFor(() => expect(new URL(window.location.href).pathname).toBe("/oauth2/authorize"));

    const url = new URL(window.location.href);
    expect(url.searchParams.get("response_type")).toBe("code");

    const verifier = sessionStorage.getItem("swng:pkceVerifier");
    expect(verifier).toBeTruthy();
    const expectedDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier!));
    const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(expectedDigest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
  });
});

describe("AuthProvider / useAuth — 401 anywhere: one silent refresh retry, then signed out", () => {
  it("a 401 from a golfer-tier call refreshes the token once and retries, succeeding", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-1" }), refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    const calls: string[] = [];
    let refreshed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/oauth2/token") {
          calls.push("refresh");
          refreshed = true;
          return fakeResponse(200, { id_token: fakeIdToken({ sub: "sub-1" }), expires_in: 3600 });
        }
        if (path === "/me" && !refreshed) {
          calls.push("me-401");
          return fakeResponse(401, { code: "invalid-token", message: "expired" });
        }
        if (path === "/me") {
          calls.push("refreshed");
          return fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    // Initial mount GET /me hits the 401 -> refresh -> retry path, ending signed in.
    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann"));
    expect(calls).toEqual(["me-401", "refresh", "refreshed"]);
    // The refreshed token is now what's persisted.
    expect(tokenStore.load()?.idToken).toBe(fakeIdToken({ sub: "sub-1" }));
  });

  it("a 401 with a failing refresh signs the golfer out (generalized via withAuth, not just getMe)", async () => {
    tokenStore.save({ idToken: fakeIdToken({ sub: "sub-1" }), refreshToken: "bad-refresh", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } }); // mount fetch succeeds
        if (path === "/me/record") return fakeResponse(401, { code: "invalid-token", message: "expired" });
        if (path === "/oauth2/token") return fakeResponse(400, { error: "invalid_grant" }); // refresh fails
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("golfer").textContent).toBe("Ann"));

    fireEvent.click(screen.getByRole("button", { name: "Call record" }));

    await waitFor(() => expect(screen.getByTestId("callResult").textContent).toBe("error:ApiError"));
    expect(screen.getByTestId("signedIn").textContent).toBe("false");
    expect(tokenStore.load()).toBeUndefined();
  });
});
