import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "./auth/tokenStore";
import { createMemoryStorage } from "./testSupport/memoryStorage";
import { App } from "./App";

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Home/Create/Join/RoundPage each carry their own full behavior-contract test suite — this
// is just a smoke test that App.tsx's router wiring lands on Home at "/" (happy-dom's default
// window.location), not a re-test of any page's own behavior.
describe("App", () => {
  it("renders Home at the root route", () => {
    render(<App />);

    // Home-specific and signed-out-stable: the anonymous "Start a round" link is gone
    // (accounts-only), but "Join by code" still routes into the funnel.
    expect(screen.getByRole("link", { name: "Join by code" })).toBeTruthy();
  });

  it("shows the Sign in header chrome when signed out", () => {
    render(<App />);

    // Scoped to the header banner: the Home body now also carries a sign-in CTA (its own
    // "Sign in" button), so an unscoped query would match two.
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  // Not a re-test of useAuth's own GET /me contract (useAuth.test.tsx covers that in full) —
  // just that App.tsx's header actually wires the golfer's name through to a /profile link.
  it("shows the golfer's name linking to /profile when signed in", async () => {
    const base64url = (obj: unknown) =>
      btoa(JSON.stringify(obj))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1" })}.sig`;
    tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } }) }) as unknown as Response),
    );

    render(<App />);

    const link = await screen.findByRole("link", { name: "Ann" });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  // Controller amendment 1: GET /me never creates — a signed-in user with no golfer row yet
  // (golfer: null) still gets identity chrome, falling back to the JWT email's localpart.
  it("falls back to the email localpart in the header when signed in with no golfer row yet", async () => {
    const base64url = (obj: unknown) =>
      btoa(JSON.stringify(obj))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-2", email: "fresh@example.com" })}.sig`;
    tokenStore.save({ idToken, refreshToken: "refresh-2", expiresAt: Date.now() + 60_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ golfer: null }) }) as unknown as Response),
    );

    render(<App />);

    const link = await screen.findByRole("link", { name: "fresh" });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  // M8 Task 6: same router-wiring smoke as "renders Home at the root route" — each crew page
  // carries its own full behavior-contract suite in src/crews/.
  it("routes /crews/new to CrewCreatePage", () => {
    window.history.pushState({}, "", "/crews/new");
    render(<App />);

    expect(screen.getByRole("heading", { name: "New crew" })).toBeTruthy();
    window.history.pushState({}, "", "/");
  });

  it("routes /crews/:crewId to CrewPage", () => {
    window.history.pushState({}, "", "/crews/crew-1");
    render(<App />);

    // Signed out (no token saved) — CrewPage's own sign-in prompt is proof the route landed.
    expect(screen.getByText(/sign in to see your crew/i)).toBeTruthy();
    window.history.pushState({}, "", "/");
  });
});
