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
  par: 72,
  courseHandicap: 8,
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
        if (path === "/me/record") return fakeResponse(200, { metrics: {}, history: [] });
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
        if (path === "/me/record") return fakeResponse(200, { metrics: { whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 1 } }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ann"));
    // The override input (was "Declared index") is seeded from the saved declared value.
    expect((screen.getByLabelText("Your own number") as HTMLInputElement).value).toBe("15");

    // A declared override is active and reads plainly as "your own"; the WHS index is shown as an
    // adoptable reference (this fixture has no swng index, so that source reads "—").
    expect(screen.getByText("your own").closest("p")?.textContent).toContain("15");
    expect(screen.getByText(/WHS index · 7\.2/)).toBeTruthy();
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
        if (path === "/me/record") return fakeResponse(200, { metrics: {}, history });
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
        if (path === "/me/record") return fakeResponse(200, { metrics: {}, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await waitFor(() => expect(screen.getByText(/computes after 3 posted/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ann Updated" } });
    fireEvent.change(screen.getByLabelText("Your own number"), { target: { value: "12" } });
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
        if (path === "/me/record") return fakeResponse(200, { metrics: {}, history: [] });
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

// The adoptable index sources (handicap-model legibility, model §3/§7): the swng index and WHS
// index rendered beneath "Your index" as labeled data points a golfer can one-tap into the
// override — NOT a nudge (no threshold, no prose, no auto-write).
describe("ProfilePage — index sources", () => {
  const withRecord = (metrics: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

  it("renders the swng index data point and its 'Use this' fills the override input", async () => {
    signIn();
    withRecord({ swngIndex: { value: 9.4, differentialsUsed: 3 } });

    renderProfilePage();

    await screen.findByText(/swng index · 9\.4/);
    fireEvent.click(screen.getByRole("button", { name: /use swng index/i }));
    expect((screen.getByLabelText("Your own number") as HTMLInputElement).value).toBe("9.4");
  });

  it("renders the WHS index data point and its 'Use this' fills the override input", async () => {
    signIn();
    withRecord({ whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } });

    renderProfilePage();

    await screen.findByText(/WHS index · 7\.2/);
    fireEvent.click(screen.getByRole("button", { name: /use whs index/i }));
    expect((screen.getByLabelText("Your own number") as HTMLInputElement).value).toBe("7.2");
  });

  // A golfer with only unrated rounds: a swng index value, but no WHS index yet → the WHS source
  // reads "—" and offers no button.
  it("a metric with no data renders '—' and offers no 'Use this'", async () => {
    signIn();
    withRecord({ swngIndex: { value: 9.4, differentialsUsed: 3 } });

    renderProfilePage();

    await screen.findByText(/swng index · 9\.4/);
    expect(screen.getByText(/WHS index · —/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /use whs index/i })).toBeNull();
  });

  it("a brand-new golfer (empty metrics) shows '—' for both sources and no 'Use this' anywhere", async () => {
    signIn();
    withRecord({});

    renderProfilePage();

    await screen.findByText(/swng index · —/);
    expect(screen.getByText(/WHS index · —/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /use swng index/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /use whs index/i })).toBeNull();
  });

  // The aids are data points, not a nudge: even when the declared index diverges sharply from both,
  // there is deliberately no threshold, no divergence prose, no "you should" sentence, no auto-write.
  it("shows only the numbers — no divergence nudge or threshold copy", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", declared: 20 } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") {
          return fakeResponse(200, { metrics: { swngIndex: { value: 9.4, differentialsUsed: 3 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } }, history: [] });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await screen.findByText(/swng index · 9\.4/);
    expect(screen.queryByText(/consider|you should|diverge|update your declared|off by|higher than|lower than|recommend/i)).toBeNull();
  });
});

// "Your index" — the one active number the golfer owns (model §3/§7). Its value is the override
// when set, else the swng index (the all-rounds default, NOT WHS), and it always shows its source.
describe("ProfilePage — Your index (the one active number)", () => {
  const withGolferAndMetrics = (golfer: unknown, metrics: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

  it("with nothing declared, the active value IS the swng index (the all-rounds default), sourced 'computed from your rounds' — never the WHS number", async () => {
    signIn();
    // Blaine's worked example (model §3): swng index 12.4 (all rounds) is the default; WHS 11.2 is a
    // reference only.
    withGolferAndMetrics({ golferId: "ann", name: "Ann" }, { swngIndex: { value: 12.4, differentialsUsed: 8 }, whsIndex: { value: 11.2, computedAtMs: 1_000, differentialsUsed: 6 } });

    renderProfilePage();

    const activeLine = (await screen.findByText("computed from your rounds")).closest("p");
    expect(activeLine?.textContent).toContain("12.4"); // the swng index is the active value
    expect(activeLine?.textContent).not.toContain("11.2"); // NOT the WHS index
    // Both sources are shown as adoptable references beneath it.
    expect(screen.getByText(/swng index · 12\.4/)).toBeTruthy();
    expect(screen.getByText(/WHS index · 11\.2/)).toBeTruthy();
  });

  it("for a rated-only golfer (swng index == WHS index), the active value equals that shared number", async () => {
    signIn();
    // Model §2: a golfer who plays only rated golf has swng index == WHS index exactly.
    withGolferAndMetrics({ golferId: "ann", name: "Ann" }, { swngIndex: { value: 7.2, differentialsUsed: 5 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } });

    renderProfilePage();

    const activeLine = (await screen.findByText("computed from your rounds")).closest("p");
    expect(activeLine?.textContent).toContain("7.2");
  });

  it("a declared override is the active value and reads 'your own'", async () => {
    signIn();
    withGolferAndMetrics({ golferId: "ann", name: "Ann", declared: 20 }, { swngIndex: { value: 9.4, differentialsUsed: 3 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } });

    renderProfilePage();

    const activeLine = (await screen.findByText("your own")).closest("p");
    expect(activeLine?.textContent).toContain("20");
  });

  // The exact confusion this task removes: the old page rendered the WHS value under a "swng Index"
  // label. No element may show the WHS number under a swng-index meaning.
  it("no mislabel — the WHS number never appears under a 'swng index' label", async () => {
    signIn();
    withGolferAndMetrics({ golferId: "ann", name: "Ann" }, { swngIndex: { value: 9.4, differentialsUsed: 3 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } });

    renderProfilePage();

    await screen.findByText(/swng index · 9\.4/); // the swng source shows the SWNG value
    expect(screen.queryByText(/swng index · 7\.2/)).toBeNull(); // never the WHS value
    expect(screen.queryByText(/swng.*7\.2/i)).toBeNull(); // no "swng …7.2" anywhere
    expect(screen.getByText(/WHS index · 7\.2/)).toBeTruthy(); // the WHS value lives under WHS
    // And the active number is the swng index, not WHS.
    expect((await screen.findByText("computed from your rounds")).closest("p")?.textContent).toContain("9.4");
  });

  it("a brand-new golfer (no declared, no computed) sees no active number and an invitation to play or set their own", async () => {
    signIn();
    withGolferAndMetrics({ golferId: "ann", name: "Ann" }, {});

    renderProfilePage();

    await screen.findByText(/no index yet/i);
    expect(screen.queryByText("computed from your rounds")).toBeNull();
    expect(screen.queryByText("your own")).toBeNull();
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
        if (path === "/me/record") return fakeResponse(200, { metrics: {}, history: [] });
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
        if (path === "/me/record") return fakeResponse(200, { metrics: {}, history: [] });
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
        if (path === "/me/record") return fakeResponse(200, { metrics: {}, history: [] });
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
