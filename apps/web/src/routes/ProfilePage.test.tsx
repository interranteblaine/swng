import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, roundId } from "@swng/domain";
import type { GolferRoundLine } from "@swng/domain";
import type { GetMyRecordResponse } from "@swng/contracts";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { ProfilePage } from "./ProfilePage";

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

// GetMyRecordResponse.metrics.typicalEighteen/averageHistory are REQUIRED on the wire (spec
// 2026-07-29 §5; bests/milestones, analytics spec 2026-07-21 §3) — api.ts's getMyRecord parses
// every /me/record response through the real zod schema, so a mock missing any required field
// throws at runtime and silently leaves `record` unset (the effect's own `.catch(() => {})`).
// Every /me/record fixture below spreads this in; tests that care about a SPECIFIC
// typicalEighteen/averageHistory override it explicitly.
const emptyMetricsExtras = {
  typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  averageHistory: [] as GetMyRecordResponse["metrics"]["averageHistory"],
  bests: {} as GetMyRecordResponse["metrics"]["bests"],
  milestones: [] as GetMyRecordResponse["metrics"]["milestones"],
};

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

const lineWithScore = (roundIdSuffix: string, score: number): GolferRoundLine => ({
  roundId: roundId(`round-${roundIdSuffix}`),
  courseName: "Pebble Beach",
  tee: "white",
  holes: 18,
  par: 72,
  strokes: 8,
  score,
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
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
};

describe("ProfilePage — signed out", () => {
  it("shows a sign-in prompt, never renders the form", () => {
    renderProfilePage();

    expect(screen.getByText(/sign in to see your profile/i)).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

describe("ProfilePage — signed in", () => {
  it("first-time golfer (golfer: null): blank form, gated chart, no rounds", async () => {
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

    await waitFor(() => expect(screen.getByText(/shows up at 8 rounds/)).toBeTruthy());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("average-chart")).toBeNull();
    expect(screen.getByText(/no rounds yet/i)).toBeTruthy();
    // The profile is a reporting artifact with no inputs (spec §5): name + home course only.
    expect(screen.queryByLabelText("Your own number")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your index" })).toBeNull();
  });

  it("renders the pre-filled form, the served average as the headline, and newest-first history (chart gated at 3 rounds)", async () => {
    signIn();
    const history: GolferRoundLine[] = [lineWithScore("1", 98), lineWithScore("2", 100), lineWithScore("3", 103)]; // newest-first, per the wire contract
    const metrics = { average: 26, ...emptyMetricsExtras };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ann"));

    // The headline: ONE number, served, with the sentence naming exactly how it was arrived at.
    expect(screen.getByRole("heading", { name: "What you shoot" })).toBeTruthy();
    expect(screen.getByText("+26")).toBeTruthy();
    expect(screen.getByText("your last 10 finished rounds, score minus par")).toBeTruthy();

    // 3 rounds is under the 8-round chart gate — no chart yet.
    expect(screen.queryByTestId("average-chart")).toBeNull();

    // History renders newest-first, exactly as the wire response ordered it (no re-sort). Each row
    // is ONE whole-row link to its own round (RecordSections extraction, owner-ruled 2026-07-20 —
    // a history row IS the round) — queried directly, anchored on its own "white" tee text.
    const historyLinks = screen.getAllByRole("link", { name: /white/ });
    expect(historyLinks[0]?.textContent).toContain("98 (+26)");
    expect(historyLinks[1]?.textContent).toContain("100 (+28)");
    expect(historyLinks[2]?.textContent).toContain("103 (+31)");
  });

  // The link sweep (navigation spec, task 6): every rendered noun's name is its address — the
  // home course line links to /courses/:courseId, in the same linkEntity idiom CoursesHubPage
  // uses; the "Change" button stays a plain button beside it, unchanged.
  it("links the home course name to /courses/:courseId — 'Change' stays a plain button", async () => {
    signIn();
    const homeCourseId = courseId("course-home-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", homeCourseId } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
        if (path === `/courses/${homeCourseId}`) {
          return fakeResponse(200, {
            course: {
              courseId: homeCourseId,
              cardId: "card-1",
              card: { courseName: "Pebble Beach", teeSets: [{ name: "white", holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] }] },
              enteredBy: "Ann",
              updatedAtMs: 1_000,
            },
          });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    const courseLink = await screen.findByRole("link", { name: "Pebble Beach" });
    expect(courseLink.getAttribute("href")).toBe(`/courses/${homeCourseId}`);
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });

  // Projection-realignment Task 6 / navigation spec §6c.3 (Step 1's own structural pin), corrected
  // 2026-07-20 (a history row IS the round): every history line is ONE whole-row link to the
  // round's own permanent address (navigation Task 5's RoundRecordPage), keyed by the wire
  // response's own roundId — never plain unlinked text.
  it("renders each history line as a whole-row link to its own /rounds/:roundId", async () => {
    signIn();
    const history: GolferRoundLine[] = [lineWithScore("1", 98), lineWithScore("2", 100)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    // Both lines share the same course/tee/par and differ only by their score, so each link's
    // accessible name anchors on that.
    const firstLink = await waitFor(() => screen.getByRole("link", { name: /white · 98 \(\+26\)/ }));
    expect(firstLink.getAttribute("href")).toBe(`/rounds/${history[0]!.roundId}`);

    const secondLink = screen.getByRole("link", { name: /white · 100 \(\+28\)/ });
    expect(secondLink.getAttribute("href")).toBe(`/rounds/${history[1]!.roundId}`);
  });

  // Owner ruling 2026-07-20: a history row is ONE link, whole row, regardless of whether the line
  // carries a courseId — a courseId no longer produces a second, separately-addressable anchor
  // inside the row (the course stays reachable from the round page's own heading link instead).
  it("a history row is one whole-row link whether or not the line carries a courseId — the course name is never its own anchor inside the row", async () => {
    signIn();
    const withCourse: GolferRoundLine = { ...lineWithScore("1", 98), courseId: courseId("course-pebble") };
    const withoutCourse: GolferRoundLine = lineWithScore("2", 100);
    const history = [withCourse, withoutCourse];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    const firstRowLink = await waitFor(() => screen.getByRole("link", { name: /Pebble Beach · white · 98 \(\+26\)/ }));
    expect(firstRowLink.getAttribute("href")).toBe(`/rounds/${withCourse.roundId}`);
    expect(firstRowLink.querySelectorAll("a")).toHaveLength(0); // no nested anchor, courseId or not

    const secondRowLink = screen.getByRole("link", { name: /Pebble Beach · white · 100 \(\+28\)/ });
    expect(secondRowLink.getAttribute("href")).toBe(`/rounds/${withoutCourse.roundId}`);
    expect(secondRowLink.querySelectorAll("a")).toHaveLength(0);

    // Exactly two anchors carry "Pebble Beach" in their accessible name — the two row links
    // themselves — never a third, separately-addressable course-name anchor for either row.
    expect(screen.getAllByRole("link", { name: /Pebble Beach/ })).toHaveLength(2);
  });

  // The chart gate: the average-over-time chart is HELD BACK below AVERAGE_HISTORY_MIN_ROUNDS
  // rounds — a 1-3 point sparkline is noise, not a trend. No <svg>/<polyline> renders at all; the
  // gate copy names both the threshold and where the golfer stands.
  it("fewer than 8 rounds: the chart is gated with a 'keep going' message, no svg/polyline anywhere", async () => {
    signIn();
    const history: GolferRoundLine[] = [lineWithScore("1", 98), lineWithScore("2", 100), lineWithScore("3", 103)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await waitFor(() => expect(screen.getByText("Your average over time shows up at 8 rounds — you've played 3. Keep going.")).toBeTruthy());
    expect(screen.queryByTestId("average-chart")).toBeNull();
    expect(document.querySelectorAll("polyline").length).toBe(0);
    expect(document.querySelectorAll("svg").length).toBe(0);
  });

  // 8+ rounds turns the gate off: a real chart, sourced straight from the served
  // metrics.averageHistory. ONE line now (spec 2026-07-29 §5) — the two-series index chart and the
  // three tests that covered its independent swng/WHS pairing (unrated gaps, a lone WHS vertex) are
  // deleted with the second series they existed to prove.
  it("8+ rounds: renders a chart with ONE polyline, drawn from the served averageHistory", async () => {
    signIn();
    const history: GolferRoundLine[] = Array.from({ length: 8 }, (_, i) => lineWithScore(String(i + 1), 98 + i));
    const averageHistory: GetMyRecordResponse["metrics"]["averageHistory"] = history.map((line, i) => ({ roundId: line.roundId, average: 31 - i }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras, averageHistory }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    await waitFor(() => expect(screen.getByTestId("average-chart")).toBeTruthy());
    expect(screen.getAllByTestId("average-line")).toHaveLength(1);
    // Every point in the served series is drawn, and the LAST one is the emphasized endpoint.
    expect(screen.getAllByTestId("average-dot")).toHaveLength(8);
    expect(screen.queryByText(/shows up at 8 rounds/)).toBeNull();
  });

  // "Your typical 18" — the career scoring shape (metrics.typicalEighteen), always present
  // (zeroed rather than absent below any bootstrap).
  it("renders the typical-18 line from metrics.typicalEighteen", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") {
          return fakeResponse(200, {
            metrics: { averageHistory: [], typicalEighteen: { eagles: 0, birdies: 2, pars: 8, bogeys: 5, doublePlus: 3 }, bests: {}, milestones: [] },
            history: [],
          });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    const typicalLine = await waitFor(() => screen.getByText(/2 birdies/).closest("p"));
    expect(typicalLine?.textContent).toContain("2 birdies");
    expect(typicalLine?.textContent).toContain("8 pars");
    expect(typicalLine?.textContent).toContain("5 bogeys");
    expect(typicalLine?.textContent).toContain("3 double+");
    expect(typicalLine?.textContent).not.toMatch(/eagle/); // 0 eagles: the prefix is omitted, not "0 eagle+"
  });

  // History rows lead with the score, not just the course — the redesign's whole point (a golfer
  // scans scores first, details second). A 9-hole round gets a marker. The differential column is
  // gone with the index (spec §7); vs par is the row's only derived figure, and the headline above
  // is the mean of exactly these numbers, so the subtraction is checkable by hand on one screen.
  it("history rows lead with the score and its vs-par figure, a nine stating its doubled contribution, and no differential", async () => {
    signIn();
    const eighteen: GolferRoundLine = {
      roundId: roundId("round-18"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      strokes: 9,
      score: 81,
      distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
    };
    const nine: GolferRoundLine = {
      roundId: roundId("round-9"),
      courseName: "Sandy Hollow Nine",
      tee: "white",
      holes: 9,
      par: 36,
      strokes: 5,
      score: 47,
      distribution: { eagles: 0, birdies: 0, pars: 4, bogeys: 3, doublePlus: 2 },
    };
    const history = [eighteen, nine];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();

    // Each row is one whole-row link (RecordSections extraction, owner-ruled 2026-07-20) — the
    // course name is text inside that same link, queried via the link's own textContent.
    const eighteenLink = await waitFor(() => screen.getByRole("link", { name: /81 \(\+9\)/ }));
    expect(eighteenLink.textContent).toBe("Casa Verde GC · white · 81 (+9)");

    const nineLink = screen.getByRole("link", { name: /47 \(\+11\)/ });
    // The nine states its DOUBLED contribution (spec §5's own register) — 47 on par 36 is +11 for
    // the round and +22 into the average, so the rows reconcile with the headline by hand.
    expect(nineLink.textContent).toBe("Sandy Hollow Nine · white · 47 (+11) · 9 holes, counts +22");
  });

  // The name/home Save is the WHOLE editable profile now (spec 2026-07-29 §5): this Save posts
  // ONLY { name, homeCourseId }, and applies the PUT's own response in place (applyGolfer), so
  // there is exactly ONE GET /me (the mount), no post-save refetch.
  it("the name/home Save PUTs /me with name + home only, and does not refetch /me (applies the response in place)", async () => {
    signIn();
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path === "/me" && init?.method === "PUT") {
          return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann Updated" } });
        }
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
        if (path === "/me/crews") return fakeResponse(200, { crews: [] });
        if (path === "/me/record") return fakeResponse(200, { metrics: { ...emptyMetricsExtras }, history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderProfilePage();
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ann"));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ann Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());

    const put = calls.find((c) => c.method === "PUT" && c.path === "/me");
    expect(put).toBeTruthy();
    expect(put?.body).toEqual({ name: "Ann Updated" }); // no homeCourseId (none picked), and nothing else exists to send
    expect(put?.body).not.toHaveProperty("indexSource"); // the retired field, pinned absent
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
    await waitFor(() => expect(screen.getByRole("heading", { name: "What you shoot" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not save your profile — try again.");
    expect(document.body.textContent).not.toMatch(/revision mismatch/);
    expect(document.body.textContent).not.toMatch(/g-abc123/);
  });
});

// The two describes that stood here — "index sources" (the adoptable swng/WHS rows and their
// one-tap commit) and "Your index (the one active number)" (resolveIndex over the committed source,
// the plus-handicap notation, the declared override, the no-drift pins) — are DELETED with the
// index-source model itself (spec 2026-07-29 §5/§7). There is no number to set on the profile and
// no source to pick: what a golfer shoots is computed from their rounds and shown as the headline
// above (its own tests live in RecordSections.test.tsx and in the signed-in block above), and what
// they play off is the basis they state when they join a round.

describe("ProfilePage — crews", () => {
  it("signed in: lists crews from GET /me/crews, each linking to its crew page", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
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
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
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
