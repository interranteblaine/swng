import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { ClaimAffordance } from "./ClaimAffordance";
import type { ClaimAffordanceProps } from "./ClaimAffordance";

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signIn = () => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
};

const renderAffordance = (props: ClaimAffordanceProps) =>
  render(
    <AuthProvider>
      <ClaimAffordance {...props} />
    </AuthProvider>,
  );

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ClaimAffordance", () => {
  // Papercut 13 (M9 hardening): WatchPage's own reuse of ResultsView for a spectator passes
  // joinCode="" (no round/crew code to prove membership with) — this must render nothing at
  // all, never a button that would always 403 claim-proof-required if tapped. Harmless either
  // way (the server rejects it), but contradicts "no edit affordances on a spectator page."
  it("renders nothing when code is empty, even when signed in", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: null })),
    );

    const { container } = renderAffordance({ rowGolferId: golferId("bo"), rowName: "Bo", code: "" });

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled()); // AuthProvider's own GET /me still fires
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });

  it("renders nothing when signed out, even with a real code", () => {
    const { container } = renderAffordance({ rowGolferId: golferId("bo"), rowName: "Bo", code: "ABC123" });
    expect(container.textContent).toBe("");
  });

  // Papercut 6 (M9 hardening): while GET /me is still loading (signed in, auth.golfer not yet
  // resolved), no row can honestly be shown as "This is me" — the own-row check needs
  // auth.golfer, which doesn't exist yet; rendering the button here risks a flash of "This is
  // me" on what may turn out to BE this account's own row a moment later.
  it("renders nothing while identity is still loading, even for the row that turns out to be the caller's own", async () => {
    signIn();
    let resolveGetMe: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveGetMe = resolve;
          }),
      ),
    );

    const { container } = renderAffordance({ rowGolferId: golferId("bo"), rowName: "Bo", code: "ABC123" });

    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();

    resolveGetMe(fakeResponse(200, { golfer: { golferId: "bo", name: "Bo" } }));
    await waitFor(() => expect(screen.getByText("You")).toBeTruthy());
  });

  it("once identity resolves to no golfer, the claim button appears normally", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: null })),
    );

    renderAffordance({ rowGolferId: golferId("bo"), rowName: "Bo", code: "ABC123" });

    await waitFor(() => expect(screen.getByRole("button", { name: "This is me" })).toBeTruthy());
  });
});
