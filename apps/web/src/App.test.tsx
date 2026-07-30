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

    // Signed out at "/" is the landing door (brand reskin spec §3) — its hero heading is
    // proof the router landed on Home, not any other route.
    expect(screen.getByRole("heading", { name: "swng is the app for the golf you actually play." })).toBeTruthy();
  });

  // Brand reskin spec §3: the signed-out home IS the landing page — no app header at all (the
  // hero's first word is the wordmark). Every other route, including signed-out inner pages,
  // keeps the header and its compact Sign in (e2e relies on it existing on /join).
  it("signed out on /: renders no header banner — the door IS the page", () => {
    render(<App />);

    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("signed out on /join: keeps the header banner with its compact Sign in", () => {
    window.history.pushState({}, "", "/join");
    render(<App />);

    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "Sign in" })).toBeTruthy();
    window.history.pushState({}, "", "/");
  });

  // Nav infrastructure Task 3: the header's Courses destination — public (course reads need no
  // sign-in), so it shows on every signed-out inner page too, not just once signed in.
  it("signed out on /join: the header also shows the Courses link", () => {
    window.history.pushState({}, "", "/join");
    render(<App />);

    const header = screen.getByRole("banner");
    const link = within(header).getByRole("link", { name: "Courses" });
    expect(link.getAttribute("href")).toBe("/courses");
    window.history.pushState({}, "", "/");
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
    tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ golfer: { golferId: "ann", name: "Ann" } }) }) as unknown as Response),
    );

    render(<App />);

    const link = await screen.findByRole("link", { name: "Ann" });
    expect(link.getAttribute("href")).toBe("/profile");

    // Nav infrastructure Task 3: the Courses link shows signed in too.
    const coursesLink = screen.getByRole("link", { name: "Courses" });
    expect(coursesLink.getAttribute("href")).toBe("/courses");
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
    tokenStore.save({ idToken, refreshToken: "refresh-2", expiresAt: Date.now() + 3_600_000 });
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

  // Navigation Task 4: same router-wiring smoke as the crew routes above — GolferPage carries its
  // own full behavior-contract suite in src/golfers/.
  it("routes /golfers/:golferId to GolferPage", () => {
    window.history.pushState({}, "", "/golfers/golfer-1");
    render(<App />);

    // Signed out (no token saved) — GolferPage's own SignInCta framing message is proof the
    // route landed (the header ALSO carries a compact "Sign in" on this inner page, so anchor on
    // the CTA's own text rather than the ambiguous button name).
    expect(screen.getByText(/sign in to see this golfer's record/i)).toBeTruthy();
    window.history.pushState({}, "", "/");
  });

  // Nav infrastructure Task 2: the `path="*"` catch-all inside Layout — a real 404 for any
  // path none of the routes above match, instead of a blank Outlet.
  it("routes an unknown path to a real 404, inside the header chrome", () => {
    window.history.pushState({}, "", "/this/path/does/not/exist");
    render(<App />);

    expect(screen.getByText("This page doesn't exist.")).toBeTruthy();
    // Still inside Layout (unlike /auth/callback and /watch/:roundId) — the header banner renders.
    expect(screen.getByRole("banner")).toBeTruthy();
    window.history.pushState({}, "", "/");
  });
});
