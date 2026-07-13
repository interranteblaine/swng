import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, crewId, fixtureLinks18, golferId } from "@swng/domain";
import type { CourseView, CrewSeasonView, CrewView, SeasonStandingsResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom) — CrewPage composes StandingGameEditor
// (getCourse/searchCourses via CourseSearch) and SeasonPanel (architecture-realignment Task 11)
// on top of its own crew calls. SeasonPanel only ever mounts once a season is selected, so its
// own calls (getSeasonStandings/getMyRounds/appendCountedRound/removeCountedRound) are stubbed
// here for the two tests that select a season — SeasonPanel's OWN full behavior (standings
// table, head-to-head, the count-a-round picker, remove affordance) is pinned directly against
// SeasonPanel in SeasonPanel.test.tsx, not re-tested through this composition.
vi.mock("../api", () => ({
  getCrew: vi.fn(),
  saveStandingGame: vi.fn(),
  getCourse: vi.fn(),
  searchCourses: vi.fn(),
  getMe: vi.fn(),
  createSeason: vi.fn(),
  listSeasons: vi.fn(),
  getSeasonStandings: vi.fn(),
  leaveCrew: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      readonly status?: number,
      message?: string,
    ) {
      super(message ?? code);
      this.name = "ApiError";
    }
  },
}));

import { ApiError, createSeason, getCourse, getCrew, getMe, getSeasonStandings, leaveCrew, listSeasons, saveStandingGame } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CrewPage } from "./CrewPage";

const mockedGetCrew = vi.mocked(getCrew);
const mockedSaveStandingGame = vi.mocked(saveStandingGame);
const mockedGetCourse = vi.mocked(getCourse);
const mockedGetMe = vi.mocked(getMe);
const mockedCreateSeason = vi.mocked(createSeason);
const mockedListSeasons = vi.mocked(listSeasons);
const mockedGetSeasonStandings = vi.mocked(getSeasonStandings);
const mockedLeaveCrew = vi.mocked(leaveCrew);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetCrew.mockReset();
  mockedSaveStandingGame.mockReset();
  mockedGetCourse.mockReset();
  mockedGetMe.mockReset();
  mockedCreateSeason.mockReset();
  mockedListSeasons.mockReset();
  mockedGetSeasonStandings.mockReset();
  mockedLeaveCrew.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signIn = (): string => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
  return idToken;
};

const courseView: CourseView = {
  courseId: courseId("course-18"),
  name: fixtureLinks18.courseName,
  card: fixtureLinks18,
  teeSets: [{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] }],
};

const crew: CrewView = {
  crewId: crewId("crew-1"),
  name: "Sunday crew",
  joinCode: "CRW123",
  members: [
    { golferId: golferId("ann-g"), name: "Ann", role: "organizer", claimed: true },
    { golferId: golferId("bo-g"), name: "Bo", role: "member", claimed: false },
    { golferId: golferId("cy-g"), name: "Cy", role: "member", claimed: true },
  ],
  standingGame: {
    courseId: courseId("course-18"),
    tee: "white",
    games: [{ kind: "singles-match", a: golferId("ann-g"), b: golferId("bo-g"), allowance: 1 }],
  },
};

const emptySeasons: { readonly seasons: readonly CrewSeasonView[] } = { seasons: [] };

const emptyStandings = (seasonId: string, name: string): SeasonStandingsResponse => ({
  seasonId,
  name,
  status: "open",
  rounds: [],
  ledger: [],
  headToHead: [],
});

// Probe for the play-the-usual hand-off: renders whatever router state landed at /create.
function CreateProbe() {
  const location = useLocation();
  return <div data-testid="create-probe">{JSON.stringify(location.state)}</div>;
}

// Probe for "Leave crew" -> navigate home.
function HomeProbe() {
  return <div data-testid="home-probe">home</div>;
}

const renderPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/crews/crew-1"]}>
        <Routes>
          <Route path="/" element={<HomeProbe />} />
          <Route path="/crews/:crewId" element={<CrewPage />} />
          <Route path="/create" element={<CreateProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("CrewPage", () => {
  it("shows the join code big and the roster with claimed badges", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderPage();

    await screen.findByText("CRW123");
    expect(screen.getByText("Sunday crew")).toBeTruthy();

    const roster = screen.getByRole("list", { name: /roster/i });
    const items = within(roster).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("Ann"), expect.stringContaining("Bo"), expect.stringContaining("Cy")]);
    // Claimed badge on Ann and Cy, not on ghost Bo.
    expect(within(items[0]!).getByText(/account/i)).toBeTruthy();
    expect(within(items[1]!).queryByText(/account/i)).toBeNull();
    expect(within(items[2]!).getByText(/account/i)).toBeTruthy();
  });

  // De-ghost (architecture-realignment Task 9) removed the free-text ghost-mint form; Task 11
  // removes the golferId-based "Add member" form from the UI entirely too (binding resolution:
  // "no member picker exists yet; don't invent one" — membership grows via join code alone).
  it("no 'Add member' form renders — only the join code is shown for growing the roster", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderPage();
    await screen.findByText("CRW123");

    expect(screen.queryByLabelText(/member name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^add member$/i })).toBeNull();
  });

  it("'Play the usual' renders disabled with an explainer when the crew has no standing game", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    const noPreset: CrewView = { ...crew, standingGame: undefined };
    mockedGetCrew.mockResolvedValue({ crew: noPreset });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await screen.findByText("CRW123");

    const button = screen.getByRole("button", { name: /play the usual/i });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/save a standing game first/i)).toBeTruthy();

    fireEvent.click(button);
    // Never navigates — router state probe never mounts.
    expect(screen.queryByTestId("create-probe")).toBeNull();
  });

  it("'Play the usual' hands the crew's id + members + preset to /create via router state", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: /play the usual/i }));

    const probe = await screen.findByTestId("create-probe");
    // No crewId in the preset: round-is-a-sealed-leaf — "Play the usual" hands off only the
    // roster + standing game to prefill, never a crew tag for the created round.
    expect(JSON.parse(probe.textContent!)).toEqual({
      crewPreset: { members: crew.members, standingGame: crew.standingGame },
    });
  });

  it("saving the standing game PUTs the whole preset and re-renders from the response", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedSaveStandingGame.mockResolvedValue({ crew });

    renderPage();
    await screen.findByText("CRW123");
    await screen.findByText(fixtureLinks18.courseName); // the editor's course loaded from the preset

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(mockedSaveStandingGame).toHaveBeenCalledTimes(1));
    expect(mockedSaveStandingGame).toHaveBeenCalledWith(idToken, crewId("crew-1"), { standingGame: crew.standingGame });
  });

  it("a non-member 403 shows humanized copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("zed-g"), name: "Zed" } });
    mockedGetCrew.mockRejectedValue(new ApiError("not-a-member", 403, 'golfer "zed-g" is not a member of crew "crew-1"'));
    mockedListSeasons.mockRejectedValue(new ApiError("not-a-member", 403, 'golfer "zed-g" is not a member of crew "crew-1"'));

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not a member of this crew/i);
    expect(screen.queryByText(/zed-g/)).toBeNull();
  });

  it("signed out: prompts to sign in", () => {
    renderPage();

    expect(screen.getByText(/sign in to see your crew/i)).toBeTruthy();
  });
});

// Architecture-realignment Task 11: the crew page speaks seasons — a list + "New season", and
// picking one renders SeasonPanel.
describe("CrewPage — seasons", () => {
  const seasonA: CrewSeasonView = { seasonId: "season-a", name: "2025", status: "open", createdAtMs: 1_000 };
  const seasonB: CrewSeasonView = { seasonId: "season-b", name: "2026", status: "open", createdAtMs: 2_000 };

  it("lists seasons newest-createdAtMs-first, even when the wire returns them in another order", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    // Deliberately wire-unsorted (oldest first) — CrewPage imposes its own newest-first order.
    mockedListSeasons.mockResolvedValue({ seasons: [seasonA, seasonB] });

    renderPage();
    await screen.findByText("CRW123");

    const seasonsList = await screen.findByRole("list", { name: /seasons/i });
    const items = within(seasonsList).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("2026"), expect.stringContaining("2025")]);
  });

  it("picking a season fetches and renders its standings via SeasonPanel", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedListSeasons.mockResolvedValue({ seasons: [seasonB] });
    mockedGetSeasonStandings.mockResolvedValue(emptyStandings("season-b", "2026"));

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: "2026" }));

    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledWith(expect.any(String), crewId("crew-1"), "season-b"));
    expect(await screen.findByText(/standings build as rounds are counted/i)).toBeTruthy();
  });

  it("creates a season with the typed name, POSTs it, and adds it to the list", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedCreateSeason.mockResolvedValue({ season: seasonB });
    mockedGetSeasonStandings.mockResolvedValue(emptyStandings("season-b", "2026"));

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.change(screen.getByLabelText(/new season/i), { target: { value: "2026" } });
    fireEvent.click(screen.getByRole("button", { name: /create season/i }));

    await waitFor(() => expect(mockedCreateSeason).toHaveBeenCalledWith(idToken, crewId("crew-1"), { name: "2026" }));

    const seasonsList = await screen.findByRole("list", { name: /seasons/i });
    expect(within(seasonsList).getByText("2026")).toBeTruthy();
  });

  it("a 400 invalid-season-name shows honest copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    // A well-formed-looking name still round-trips into the server's own 400 here — the point
    // is the CLIENT's error-copy handling, not manufacturing a real 61-char/whitespace-only
    // violation (the input's own maxLength=60 already keeps a real user from typing past the
    // bound; createSeason.ts's inline trim/length check is the source of truth either way).
    mockedCreateSeason.mockRejectedValue(new ApiError("invalid-season-name", 400, 'season name must be 1-60 characters: "Summer Cup"'));

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.change(screen.getByLabelText(/new season/i), { target: { value: "Summer Cup" } });
    fireEvent.click(screen.getByRole("button", { name: /create season/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Season name must be 1–60 characters.");
    // The raw server text echoes the typed value back in quotes (server vocabulary) — that
    // exact echo must never reach the page, even though "Summer Cup" itself is still sitting
    // in the (uncontrolled-by-this-assertion) input value.
    expect(document.body.textContent).not.toMatch(/season name must be 1-60 characters: "Summer Cup"/);
  });
});

// Architecture-realignment Task 11: "Leave crew" with a confirm step; success navigates home.
describe("CrewPage — leave crew", () => {
  it("Leave crew reveals a confirm step and does nothing until confirmed", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    expect(screen.getByRole("dialog", { name: /confirm leave/i })).toBeTruthy();
    expect(mockedLeaveCrew).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog", { name: /confirm leave/i })).toBeNull();
    expect(mockedLeaveCrew).not.toHaveBeenCalled();
  });

  it("confirming leave POSTs /crews/{id}/leave and navigates home on success", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedLeaveCrew.mockResolvedValue({ crewId: crewId("crew-1") });

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(mockedLeaveCrew).toHaveBeenCalledWith(idToken, crewId("crew-1")));
    expect(await screen.findByTestId("home-probe")).toBeTruthy();
  });

  it("a leave failure shows honest copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    // A generic failure (network/500) — the unknown-crew arm (a race: the crew vanished between
    // load and this click) gets its own more specific copy, asserted separately below.
    mockedLeaveCrew.mockRejectedValue(new Error("network down"));

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not leave/i);
    expect(document.body.textContent).not.toMatch(/network down/);
    expect(screen.queryByTestId("home-probe")).toBeNull();
  });

  it("a leave against a crew that's vanished mid-race (unknown-crew) gets its own honest copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedLeaveCrew.mockRejectedValue(new ApiError("unknown-crew", 404, 'no crew "crew-1"'));

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/doesn't exist/i);
    expect(document.body.textContent).not.toMatch(/no crew "crew-1"/);
    expect(screen.queryByTestId("home-probe")).toBeNull();
  });
});
