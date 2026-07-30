import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { GolferPage } from "./GolferPage";

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

// GetGolferResponse.metrics.typicalEighteen/averageHistory/bests/milestones are REQUIRED on the
// wire (same contract as GetMyRecordResponse; analytics spec 2026-07-21 §3) — every fixture
// below spreads this in.
const emptyMetricsExtras = {
  typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  averageHistory: [] as unknown[],
  bests: {},
  milestones: [] as unknown[],
};

function ProfileProbe() {
  return <div data-testid="profile-probe">profile page probe</div>;
}

const renderGolferPage = (id: string) =>
  render(
    <MemoryRouter initialEntries={[`/golfers/${id}`]}>
      <AuthProvider>
        <Routes>
          <Route path="/golfers/:golferId" element={<GolferPage />} />
          <Route path="/profile" element={<ProfileProbe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

const signIn = (sub = "sub-1") => {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub, email: "ann@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GolferPage", () => {
  // (a) signed out — the SignInCta funnel, returnTo the current /golfers/:golferId path.
  it("signed out: shows the SignInCta funnel with returnTo the current /golfers/:golferId path", () => {
    renderGolferPage("bo");

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(sessionStorage.getItem("swng:returnTo")).toBe("/golfers/bo");
  });

  // (b) loaded: name h1 then RecordSections. The separate "plays off N · from all their rounds"
  // line this page used to render is deleted with the index it named (spec 2026-07-29 §7) —
  // RecordSections' own third-person headline is the ONE number about this golfer now, so there is
  // no second one to keep in sync.
  it("loaded: renders the golfer's name and the record sections, third-person throughout", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/golfers/bo") {
          return fakeResponse(200, { name: "Bo", metrics: { average: 26, ...emptyMetricsExtras }, history: [] });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderGolferPage("bo");

    expect(await screen.findByRole("heading", { name: "Bo" })).toBeTruthy();
    // The ONE number about this golfer, third-person and served.
    expect(screen.getByRole("heading", { name: "What they shoot" })).toBeTruthy();
    expect(screen.getByText("+26")).toBeTruthy();
    expect(screen.getByText("their last 10 rounds with every hole scored, score minus par")).toBeTruthy();
    // RecordSections rendered with the response's (empty) history.
    expect(screen.getByText("No rounds yet.")).toBeTruthy();
    // person="their" (whole-branch-review finding): GolferPage renders someone ELSE's record, so
    // RecordSections' own copy must read third-person too — no second-person "Your"/"Keep going."
    // text anywhere on the page.
    expect(screen.getByRole("heading", { name: "Their average over time" })).toBeTruthy();
    expect(screen.getByText("Their average over time shows up at 8 rounds — they've played 0.")).toBeTruthy();
    expect(screen.queryByText(/Your average over time/)).toBeNull();
    expect(screen.queryByText(/Keep going\./)).toBeNull();
  });

  // A golfer with no scored round yet renders "—" — absent is the honest answer, never a crash and
  // never a 0.
  it("a golfer with no average renders the '—' treatment", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/golfers/bo") {
          return fakeResponse(200, { name: "Bo", metrics: { ...emptyMetricsExtras }, history: [] });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderGolferPage("bo");

    expect(await screen.findByRole("heading", { name: "What they shoot" })).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  // (c) API 404 → the honest empty state, a link home, no crash.
  it("API 404: shows 'This golfer isn't available' with a link home, no crash", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/golfers/nope") {
          return { ok: false, status: 404, json: async () => ({ code: "golfer-not-found", message: "no such golfer" }) } as unknown as Response;
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderGolferPage("nope");

    expect(await screen.findByText("This golfer isn't available")).toBeTruthy();
    const homeLink = screen.getByRole("link", { name: /back to swng/i });
    expect(homeLink.getAttribute("href")).toBe("/");
  });

  // (d) viewing yourself: "This is you · your profile" linking /profile.
  it("viewing yourself shows 'This is you · your profile' linking /profile", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/golfers/ann") {
          return fakeResponse(200, { name: "Ann", metrics: { ...emptyMetricsExtras }, history: [] });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderGolferPage("ann");

    const selfLink = await screen.findByRole("link", { name: /this is you/i });
    expect(selfLink.textContent).toBe("This is you · your profile");
    expect(selfLink.getAttribute("href")).toBe("/profile");
  });

  it("viewing someone else shows no self-view link", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/golfers/bo") {
          return fakeResponse(200, { name: "Bo", metrics: { ...emptyMetricsExtras }, history: [] });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderGolferPage("bo");

    await screen.findByRole("heading", { name: "Bo" });
    expect(screen.queryByRole("link", { name: /this is you/i })).toBeNull();
  });

  // (e) usePageTitle lands the golfer's name.
  it("usePageTitle: sets document.title to the golfer's name once loaded", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/golfers/bo") {
          return fakeResponse(200, { name: "Bo", metrics: { ...emptyMetricsExtras }, history: [] });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderGolferPage("bo");

    await waitFor(() => expect(document.title).toBe("Bo · swng"));
  });
});
