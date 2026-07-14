import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkceVerifierStore, returnToStore, tokenStore } from "../auth/tokenStore";
import { AuthProvider } from "../auth/useAuth";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { AuthCallbackPage } from "./AuthCallbackPage";

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderCallback = (initialPath: string) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/" element={<div>home page</div>} />
          <Route path="/join" element={<div>join page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("AuthCallbackPage", () => {
  it("exchanges the code at /oauth2/token using the stashed PKCE verifier, stores the tokens, and redirects home", async () => {
    pkceVerifierStore.save("stashed-verifier");
    const calls: { readonly url: string; readonly body: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? String(init.body) : undefined });
        if (url.endsWith("/oauth2/token")) return fakeResponse(200, { id_token: "id-tok-1", refresh_token: "refresh-tok-1", expires_in: 3600 });
        // completeSignIn resets the "once per session" GET /me guard (useAuth.ts) — a GET /me
        // follows right behind the exchange, same real transport, so the fake must answer it too.
        return fakeResponse(200, { golfer: null });
      }),
    );

    renderCallback("/auth/callback?code=abc123");

    expect(screen.getByRole("status").textContent).toBe("Signing you in…");

    await waitFor(() => expect(screen.getByText("home page")).toBeTruthy());

    const tokenCall = calls.find((c) => c.url.endsWith("/oauth2/token"));
    expect(tokenCall).toBeTruthy();
    const body = new URLSearchParams(tokenCall?.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc123");
    expect(body.get("code_verifier")).toBe("stashed-verifier");

    expect(tokenStore.load()).toEqual({ idToken: "id-tok-1", refreshToken: "refresh-tok-1", expiresAt: expect.any(Number) });
    // Single-use: the verifier is gone after the exchange (pkceVerifierStore.take()'s own
    // read-and-remove contract) — a replayed callback can't reuse it.
    expect(sessionStorage.getItem("swng:pkceVerifier")).toBeNull();
  });

  it("consumes a stashed returnTo (the join funnel) and lands there instead of home — single-use", async () => {
    pkceVerifierStore.save("stashed-verifier");
    returnToStore.save("/join?code=ABC123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/oauth2/token")) return fakeResponse(200, { id_token: "id-tok-1", refresh_token: "refresh-tok-1", expires_in: 3600 });
        return fakeResponse(200, { golfer: null });
      }),
    );

    renderCallback("/auth/callback?code=abc123");

    await waitFor(() => expect(screen.getByText("join page")).toBeTruthy());
    // Single-use: consumed on the way through, so a replayed callback can't reuse it.
    expect(sessionStorage.getItem("swng:returnTo")).toBeNull();
  });

  it("shows a friendly error and never calls fetch when the verifier is missing (expired/foreign link)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    renderCallback("/auth/callback?code=abc123");

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/sign-in link is missing or expired/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a friendly error when the token exchange itself fails — never a raw error message", async () => {
    pkceVerifierStore.save("stashed-verifier");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(400, { error: "invalid_grant" })),
    );

    renderCallback("/auth/callback?code=abc123");

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not complete sign-in — try again.");
    expect(tokenStore.load()).toBeUndefined();
  });
});
