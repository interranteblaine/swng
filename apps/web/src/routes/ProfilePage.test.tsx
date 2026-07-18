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

// GetMyRecordResponse.metrics.distribution/trend are REQUIRED on the wire now (papercut 17) —
// api.ts's getMyRecord parses every /me/record response through the real zod schema, so a mock
// missing either field throws at runtime and silently leaves `record` unset (the effect's own
// `.catch(() => {})`). Every /me/record fixture below spreads this in; tests that care about a
// SPECIFIC distribution/trend override it explicitly.
const emptyMetricsExtras = { distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, trend: [] as readonly number[] };

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
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await waitFor(() => expect(screen.getByText(/play a few rounds/i)).toBeTruthy());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("img", { name: "Index trend" })).toBeNull();
    expect(screen.getByText(/no rounds yet/i)).toBeTruthy();
  });

  it("renders the pre-filled form, computed index, trend SVG, distribution bars, and newest-first history", async () => {
    signIn();
    const history: GolferRoundLine[] = [lineWithDifferential("1", 9.2), lineWithDifferential("2", 11.8), lineWithDifferential("3", 14.5)]; // newest-first, per the wire contract
    // The metrics projection's own distribution/trend (papercut 17) — trend is oldest -> newest
    // (left to right), the mirror of the newest-first history above; distribution is the 3
    // identical per-line buckets (lineWithDifferential) summed.
    const metrics = {
      whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 1 },
      distribution: { eagles: 0, birdies: 3, pars: 30, bogeys: 18, doublePlus: 3 },
      trend: [14.5, 11.8, 9.2],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "declared", value: 15 } } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics, history });
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
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "declared", value: 15 } } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    const firstLink = await waitFor(() => screen.getByRole("link", { name: /Pebble Beach — white — AGS 82 — differential 9.2/ }));
    expect(firstLink.getAttribute("href")).toBe(`/rounds/${history[0]!.roundId}/archive`);

    const secondLink = screen.getByRole("link", { name: /differential 11.8/ });
    expect(secondLink.getAttribute("href")).toBe(`/rounds/${history[1]!.roundId}/archive`);
  });

  // The name/home Save (index-source one-tap spec §2): the index source commits on its own tap now,
  // so this Save posts ONLY { name, homeCourseId } — never an indexSource — and applies the PUT's own
  // response in place (applyGolfer), so there is exactly ONE GET /me (the mount), no post-save refetch.
  it("the name/home Save PUTs /me with no indexSource and does not refetch /me (applies the response in place)", async () => {
    signIn();
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path === "/me" && init?.method === "PUT") {
          return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann Updated", indexSource: { kind: "swng" } } });
        }
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ann"));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ann Updated" } });
    // Typing in the override changes nothing about this Save's body — it is not a staged source.
    fireEvent.change(screen.getByLabelText("Your own number"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());

    const put = calls.find((c) => c.method === "PUT" && c.path === "/me");
    expect(put).toBeTruthy();
    expect(put?.body).toEqual({ name: "Ann Updated" }); // no indexSource, no homeCourseId (none picked)
    expect(put?.body).not.toHaveProperty("indexSource");
    // applyGolfer, not refetch: exactly one GET /me total (the mount) — no second fetch after save.
    expect(calls.filter((c) => c.method === "GET" && c.path === "/me")).toHaveLength(1);
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
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await waitFor(() => expect(screen.getByText(/play a few rounds/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not save your profile — try again.");
    expect(document.body.textContent).not.toMatch(/revision mismatch/);
    expect(document.body.textContent).not.toMatch(/g-abc123/);
  });
});

// The adoptable index sources (index-source model spec §3/§6): the swng index and WHS index
// rendered beneath "Your index" as labeled data points, each with a one-tap "Use this" that sets
// the golfer's index SOURCE — never a value copied into the override box. The active source shows
// "in use" and offers no button. NOT a nudge (no threshold, no prose, no auto-write).
describe("ProfilePage — index sources", () => {
  const withRecord = (metrics: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras, ...(metrics as object) }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

  it("the default swng source is marked 'in use' with no button; the WHS reference offers a 'Use this' and the override stays empty", async () => {
    signIn();
    withRecord({ swngIndex: { value: 9.4, differentialsUsed: 3 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } });

    renderProfilePage();

    await screen.findByText(/swng index · 9\.4/);
    // swng is the default active source — marked "in use", no adopt button.
    expect(screen.getByText("in use")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /use swng index/i })).toBeNull();
    // WHS is an adoptable reference — it has a button.
    expect(screen.getByRole("button", { name: /use whs index/i })).toBeTruthy();
    // Nothing was copied into the override — the whole model (a source, not a value).
    expect((screen.getByLabelText("Your own number") as HTMLInputElement).value).toBe("");
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
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "declared", value: 20 } } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") {
          return fakeResponse(200, { metrics: { swngIndex: { value: 9.4, differentialsUsed: 3 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 }, ...emptyMetricsExtras }, history: [] });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await screen.findByText(/swng index · 9\.4/);
    expect(screen.queryByText(/consider|you should|diverge|update your declared|off by|higher than|lower than|recommend/i)).toBeNull();
  });
});

// "Your index" — the one active number the golfer owns (index-source model spec §3/§6). Its value
// is resolved live from the chosen SOURCE: swng by default, whs when adopted, or a declared
// override — always shown with its source, never a copied value.
describe("ProfilePage — Your index (the one active number)", () => {
  const withGolferAndMetrics = (golfer: unknown, metrics: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras, ...(metrics as object) }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

  it("on the default swng source, the active value IS the swng index (the all-rounds default), sourced 'from all your rounds' — never the WHS number", async () => {
    signIn();
    // Blaine's worked example (spec §3): swng index 12.4 (all rounds) is the default; WHS 11.2 is a
    // reference only.
    withGolferAndMetrics(
      { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } },
      { swngIndex: { value: 12.4, differentialsUsed: 8 }, whsIndex: { value: 11.2, computedAtMs: 1_000, differentialsUsed: 6 } },
    );

    renderProfilePage();

    // Anchor on the active big-number span (exact "12.4"); the swng source ROW reads "swng index ·
    // 12.4", so this uniquely finds the active line even though "from all your rounds" also labels
    // the swng row (the active label and the menu gloss share that phrase).
    const activeLine = (await screen.findByText("12.4")).closest("p");
    expect(activeLine?.textContent).toContain("from all your rounds"); // the active line's source label
    expect(activeLine?.textContent).not.toContain("11.2"); // NOT the WHS index
    // Both sources are shown as data points beneath it.
    expect(screen.getByText(/swng index · 12\.4/)).toBeTruthy();
    expect(screen.getByText(/WHS index · 11\.2/)).toBeTruthy();
  });

  it("for a rated-only golfer (swng index == WHS index), the active value equals that shared number", async () => {
    signIn();
    // Spec §2: a golfer who plays only rated golf has swng index == WHS index exactly.
    withGolferAndMetrics(
      { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } },
      { swngIndex: { value: 7.2, differentialsUsed: 5 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } },
    );

    renderProfilePage();

    const activeLine = (await screen.findByText("7.2")).closest("p");
    expect(activeLine?.textContent).toContain("from all your rounds");
  });

  // A plus handicap (an index below scratch) renders golf's + convention through the domain
  // (formatHandicapIndex) — never a bare "-1.2". The active number AND the source rows read it,
  // active or not.
  it("a plus handicap (below scratch) renders the + convention on the active number and the source rows — never a bare -1.2", async () => {
    signIn();
    withGolferAndMetrics(
      { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } },
      { swngIndex: { value: -1.2, differentialsUsed: 8 }, whsIndex: { value: -0.4, computedAtMs: 1_000, differentialsUsed: 6 } },
    );

    renderProfilePage();

    // The active big-number span reads +1.2 (anchor on the exact span, as the swng ROW reads the
    // combined "swng index · +1.2").
    const activeLine = (await screen.findByText("+1.2")).closest("p");
    expect(activeLine?.textContent).toContain("from all your rounds");
    expect(screen.queryByText("-1.2")).toBeNull(); // never the bare negative
    // Both source rows render through the same convention — active or not.
    expect(screen.getByText(/swng index · \+1\.2/)).toBeTruthy();
    expect(screen.getByText(/WHS index · \+0\.4/)).toBeTruthy();
  });

  it("a declared override is the active value and reads 'your own'", async () => {
    signIn();
    withGolferAndMetrics(
      { golferId: "ann", name: "Ann", indexSource: { kind: "declared", value: 20 } },
      { swngIndex: { value: 9.4, differentialsUsed: 3 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } },
    );

    renderProfilePage();

    const activeLine = (await screen.findByText("your own")).closest("p");
    expect(activeLine?.textContent).toContain("20");
  });

  // THE ANTI-REVERT TEST (index-source one-tap spec §2): picking "Use this" on the WHS row COMMITS
  // the source in ONE request (a PUT /me with just {indexSource:{kind:"whs"}}) and applies the PUT's
  // own response to auth in place — NO GET /me refetch. The active value tracks the live WHS metric,
  // the WHS row reads "in use", and a reload-equivalent re-render KEEPS WHS: the committed truth
  // lives in auth.golfer, not a staged local copy a reload would drop. This is the whole fix.
  it("'Use WHS index' commits in one request (one PUT, no GET /me) and does not revert on re-render", async () => {
    signIn();
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path === "/me" && init?.method === "PUT") {
          return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "whs" } } });
        }
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { swngIndex: { value: 12.4, differentialsUsed: 8 }, whsIndex: { value: 11.2, computedAtMs: 1_000, differentialsUsed: 6 }, ...emptyMetricsExtras }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    // Starts on swng: active 12.4 "from all your rounds" (anchor on the exact big-number span).
    const activeStart = (await screen.findByText("12.4")).closest("p");
    expect(activeStart?.textContent).toContain("from all your rounds");
    const getMeBefore = calls.filter((c) => c.method === "GET" && c.path === "/me").length;

    fireEvent.click(screen.getByRole("button", { name: /use whs index/i }));

    // Exactly ONE PUT /me carrying just the WHS source; NO additional GET /me (applyGolfer, not refetch).
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/me")).toBe(true));
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/me");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual({ indexSource: { kind: "whs" } });
    expect(calls.filter((c) => c.method === "GET" && c.path === "/me").length).toBe(getMeBefore);

    // Now ON WHS: the active value is the live WHS metric 11.2, "your WHS index"; the WHS row is "in use".
    const activeAfter = (await screen.findByText("your WHS index")).closest("p");
    expect(activeAfter?.textContent).toContain("11.2");
    expect(screen.getByText(/WHS index · 11\.2/).closest("div")?.textContent).toContain("in use");
    // The override box is STILL empty — nothing was copied (the source, never a value).
    expect((screen.getByLabelText("Your own number") as HTMLInputElement).value).toBe("");

    // Reload-equivalent re-render (an unrelated state change): WHS is STILL in use — the commit stuck,
    // and the re-render neither re-committed nor refetched.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ann again" } });
    expect((await screen.findByText("your WHS index")).closest("p")?.textContent).toContain("11.2");
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/me")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/me").length).toBe(getMeBefore);
  });

  // The override commits on its own tap (index-source one-tap spec §2): typing stages nothing — the
  // active source stays swng until "Use this number" is tapped, which fires ONE PUT and makes the
  // declared value active. "Use this number" appears only once a valid number is present.
  it("typing an override then 'Use this number' commits {kind:'declared', value} in one request", async () => {
    signIn();
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path === "/me" && init?.method === "PUT") {
          return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "declared", value: 8 } } });
        }
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { swngIndex: { value: 12.4, differentialsUsed: 8 }, ...emptyMetricsExtras }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await screen.findByText("12.4"); // swng active value settled

    // No commit button until a valid number is typed.
    expect(screen.queryByRole("button", { name: "Use this number" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Your own number"), { target: { value: "8" } });

    // Typing alone stages nothing — still on swng (active 12.4) until the commit tap.
    expect((await screen.findByText("12.4")).closest("p")?.textContent).toContain("from all your rounds");

    fireEvent.click(screen.getByRole("button", { name: "Use this number" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/me")).toBe(true));
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/me");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual({ indexSource: { kind: "declared", value: 8 } });

    const activeLine = (await screen.findByText("your own")).closest("p");
    expect(activeLine?.textContent).toContain("8.0");
  });

  // A rejected PUT applies nothing (auth.golfer updates only on success), so the prior source stays
  // active — no optimism to roll back — and an inline error sits by the section.
  it("a rejected commit leaves the prior source active and shows the inline error", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/me" && init?.method === "PUT") {
          return { ok: false, status: 409, json: async () => ({ code: "golfer-revision-mismatch", message: "boom" }) } as unknown as Response;
        }
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { swngIndex: { value: 12.4, differentialsUsed: 8 }, whsIndex: { value: 11.2, computedAtMs: 1_000, differentialsUsed: 6 }, ...emptyMetricsExtras }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    const activeStart = (await screen.findByText("12.4")).closest("p");
    expect(activeStart?.textContent).toContain("from all your rounds");

    fireEvent.click(screen.getByRole("button", { name: /use whs index/i }));

    await waitFor(() => expect(screen.getByText("Couldn't save your index — try again.")).toBeTruthy());
    // Still on swng — the failed commit changed nothing, and no WHS active label appeared.
    expect(screen.getByText("12.4").closest("p")?.textContent).toContain("from all your rounds");
    expect(screen.queryByText("your WHS index")).toBeNull();
  });

  // The exact confusion this task removes: the old page rendered the WHS value under a "swng Index"
  // label. No element may show the WHS number under a swng-index meaning.
  it("no mislabel — the WHS number never appears under a 'swng index' label", async () => {
    signIn();
    withGolferAndMetrics(
      { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } },
      { swngIndex: { value: 9.4, differentialsUsed: 3 }, whsIndex: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 5 } },
    );

    renderProfilePage();

    await screen.findByText(/swng index · 9\.4/); // the swng source shows the SWNG value
    expect(screen.queryByText(/swng index · 7\.2/)).toBeNull(); // never the WHS value
    expect(screen.queryByText(/swng.*7\.2/i)).toBeNull(); // no "swng …7.2" anywhere
    expect(screen.getByText(/WHS index · 7\.2/)).toBeTruthy(); // the WHS value lives under WHS
    // And the active number is the swng index, not WHS (anchor on the exact big-number span).
    expect((await screen.findByText("9.4")).closest("p")?.textContent).toContain("from all your rounds");
  });

  // A computed source with no data resolves to undefined (first-class, not 0) — the "No WHS index
  // yet" copy names the source the golfer is on, never a bare blank or a 0.
  it("a golfer on WHS with no whsIndex yet sees the 'No WHS index yet' copy and no active number", async () => {
    signIn();
    withGolferAndMetrics({ golferId: "ann", name: "Ann", indexSource: { kind: "whs" } }, {});

    renderProfilePage();

    await screen.findByText(/no whs index yet/i);
    expect(screen.queryByText("your WHS index")).toBeNull();
  });

  it("a brand-new golfer (no computed metrics, default swng source) sees no active number and an invitation to play or set their own", async () => {
    signIn();
    withGolferAndMetrics({ golferId: "ann", name: "Ann", indexSource: { kind: "swng" } }, {});

    renderProfilePage();

    await screen.findByText(/no index yet/i);
    // No active-value paragraph (resolved value undefined) — no "your own", no WHS active label.
    // ("from all your rounds" still appears as the swng source's MENU description — that's the row,
    // not an active number, so it is not asserted absent here.)
    expect(screen.queryByText("your own")).toBeNull();
    expect(screen.queryByText("your WHS index")).toBeNull();
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
        if (path === "/me") return fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
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
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
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
        if (path === "/me") return fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
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
