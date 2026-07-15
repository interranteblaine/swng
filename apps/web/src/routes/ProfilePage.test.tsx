import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roundId } from "@swng/domain";
import type { GolferRoundLine } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { ProfilePage } from "./ProfilePage";

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

// ProfilePage's history lines are now react-router <Link>s (projection-realignment Task 6) —
// every render needs a Router ancestor, same MemoryRouter-wrapping idiom WatchPage.test.tsx's
// own renderWithAuth uses. A `/crews/:crewId` probe route is registered too since the crews
// list itself renders real <Link>s to it (the crews section moved here from HomePage — spec
// §11a) — kept even though nothing here clicks through it anymore (crew membership, invited in,
// accountable out — spec §2/§3, deleted the join-by-code form that used to navigate there).
function CrewProbe() {
  return <div data-testid="crew-probe">crew page probe</div>;
}

const renderProfilePage = () =>
  render(
    <MemoryRouter initialEntries={["/profile"]}>
      <AuthProvider>
        <Routes>
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/crews/:crewId" element={<CrewProbe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

const lineWithDifferential = (roundIdSuffix: string, differential: number): GolferRoundLine => ({
  roundId: roundId(`round-${roundIdSuffix}`),
  courseName: "Pebble Beach",
  tee: "white",
  holes: 18,
  ags: 82,
  differential,
  distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
});

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signIn = () => {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "ann@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
};

describe("ProfilePage — signed out", () => {
  it("shows a sign-in prompt, never renders the form", () => {
    renderProfilePage();

    expect(screen.getByText(/sign in to see your profile/i)).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

describe("ProfilePage — signed in", () => {
  it("first-time golfer (golfer: null): blank form, bootstrap explainer, no trend SVG", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await waitFor(() => expect(screen.getByText(/computes after 3 posted/i)).toBeTruthy());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("img", { name: "Index trend" })).toBeNull();
    expect(screen.getByText(/no rounds yet/i)).toBeTruthy();
  });

  it("renders the pre-filled form, computed index, trend SVG, distribution bars, and newest-first history", async () => {
    signIn();
    const history: GolferRoundLine[] = [lineWithDifferential("1", 9.2), lineWithDifferential("2", 11.8), lineWithDifferential("3", 14.5)]; // newest-first, per the wire contract
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", declared: 15 } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { index: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 1 }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ann"));
    expect((screen.getByLabelText("Declared index") as HTMLInputElement).value).toBe("15");

    expect(screen.getByText("7.2")).toBeTruthy(); // computed index
    expect(screen.getByText(/from 1 differential/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Index trend" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Scoring distribution" })).toBeTruthy();

    // History renders newest-first, exactly as the wire response ordered it (no re-sort).
    const historyItems = screen.getAllByText(/Pebble Beach — white/);
    expect(historyItems[0]?.textContent).toMatch(/differential 9.2/);
    expect(historyItems[1]?.textContent).toMatch(/differential 11.8/);
    expect(historyItems[2]?.textContent).toMatch(/differential 14.5/);
  });

  // Projection-realignment Task 6 (Step 1's own structural pin): every history line is a
  // real link to its own ArchivedRoundPage, keyed by the wire response's own roundId — never
  // plain unlinked text.
  it("renders each history line as a link to its own /rounds/:roundId/archive", async () => {
    signIn();
    const history: GolferRoundLine[] = [lineWithDifferential("1", 9.2), lineWithDifferential("2", 11.8)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", declared: 15 } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    const firstLink = await waitFor(() => screen.getByRole("link", { name: /Pebble Beach — white — AGS 82 — differential 9.2/ }));
    expect(firstLink.getAttribute("href")).toBe(`/rounds/${history[0]!.roundId}/archive`);

    const secondLink = screen.getByRole("link", { name: /differential 11.8/ });
    expect(secondLink.getAttribute("href")).toBe(`/rounds/${history[1]!.roundId}/archive`);
  });

  it("saving the form PUTs /me, then re-fetches /me", async () => {
    signIn();
    const calls: string[] = [];
    let meCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/me" && init?.method === "PUT") {
          return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann Updated", declared: 12 } });
        }
        if (path === "/me") {
          meCallCount += 1;
          return fakeResponse(200, meCallCount === 1 ? { golfer: null } : { golfer: { golferId: "ann", name: "Ann Updated", declared: 12 } });
        }
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await waitFor(() => expect(screen.getByText(/computes after 3 posted/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ann Updated" } });
    fireEvent.change(screen.getByLabelText("Declared index"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(calls).toContain("PUT /me");
    // The re-fetch after save is a real GET /me, not just a locally-applied echo of the PUT response.
    expect(calls.filter((c) => c === "GET /me").length).toBeGreaterThanOrEqual(2);
  });

  it("a failed save shows a fixed human message, never the raw server error text (e.g. a golfer revision-mismatch line naming the internal id)", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/me" && init?.method === "PUT") {
          return {
            ok: false,
            status: 409,
            json: async () => ({ code: "golfer-revision-mismatch", message: "golfer g-abc123 revision mismatch: expected 3, got 2" }),
          } as unknown as Response;
        }
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await waitFor(() => expect(screen.getByText(/computes after 3 posted/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not save your profile — try again.");
    expect(document.body.textContent).not.toMatch(/revision mismatch/);
    expect(document.body.textContent).not.toMatch(/g-abc123/);
  });
});

// Moved here from HomePage (spec §11a, owner ruling: a crew is a grouping/competition only, off
// the play surface) — same list/New-crew-link behavior HomePage's own crews suite pinned before
// this move. Crew membership (invited in, accountable out — spec §2/§3): the join-by-code form
// is deleted whole — the "no join input" test below is this task's own structural pin.
describe("ProfilePage — crews", () => {
  it("signed in: lists crews from GET /me/crews, each linking to its crew page", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        if (path === "/me/crews") {
          return fakeResponse(200, {
            crews: [
              { crewId: "crew-1", name: "Sunday crew", memberCount: 4 },
              { crewId: "crew-2", name: "Work league", memberCount: 8 },
            ],
          });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    const sundayLink = await screen.findByRole("link", { name: /sunday crew/i });
    expect(sundayLink.getAttribute("href")).toBe("/crews/crew-1");
    expect(screen.getByRole("link", { name: /work league/i }).getAttribute("href")).toBe("/crews/crew-2");
  });

  it("offers a New crew link to /crews/new", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    const link = await screen.findByRole("link", { name: /new crew/i });
    expect(link.getAttribute("href")).toBe("/crews/new");
  });

  // Crew membership (invited in, accountable out — spec §2/§3): the permanent join code is
  // gone — this is C-T3's own structural pin that the form (and the golfer-required alert arm
  // that guarded it) never renders again, matching the proof-grep the task closes with.
  it("no join-by-code input anywhere — an invite LINK (/crews/join) is the one way in now", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await screen.findByText(/your crews/i);

    expect(screen.queryByLabelText(/crew code/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /join crew/i })).toBeNull();
    expect(screen.queryByText(/save your name in the form above first, then join the crew/i)).toBeNull();
  });

});
