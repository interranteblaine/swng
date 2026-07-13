import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, crewId, fixtureLinks18, golferId } from "@swng/domain";
import type { CourseView, CrewView, GetCrewRecordsResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom) — CrewPage composes StandingGameEditor
// (getCourse/searchCourses via CourseSearch) on top of its own crew calls.
vi.mock("../api", () => ({
  getCrew: vi.fn(),
  getCrewRecords: vi.fn(),
  addCrewMember: vi.fn(),
  saveStandingGame: vi.fn(),
  getCourse: vi.fn(),
  searchCourses: vi.fn(),
  getMe: vi.fn(),
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

import { addCrewMember, ApiError, getCourse, getCrew, getCrewRecords, getMe, saveStandingGame } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CrewPage } from "./CrewPage";

const mockedGetCrew = vi.mocked(getCrew);
const mockedGetCrewRecords = vi.mocked(getCrewRecords);
const mockedAddCrewMember = vi.mocked(addCrewMember);
const mockedSaveStandingGame = vi.mocked(saveStandingGame);
const mockedGetCourse = vi.mocked(getCourse);
const mockedGetMe = vi.mocked(getMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetCrew.mockReset();
  mockedGetCrewRecords.mockReset();
  mockedAddCrewMember.mockReset();
  mockedSaveStandingGame.mockReset();
  mockedGetCourse.mockReset();
  mockedGetMe.mockReset();
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

const emptyRecords: GetCrewRecordsResponse = { season: 2026, ledger: [], headToHead: [] };

// Probe for the play-the-usual hand-off: renders whatever router state landed at /create.
function CreateProbe() {
  const location = useLocation();
  return <div data-testid="create-probe">{JSON.stringify(location.state)}</div>;
}

const renderPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/crews/crew-1"]}>
        <Routes>
          <Route path="/crews/:crewId" element={<CrewPage />} />
          <Route path="/create" element={<CreateProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("CrewPage", () => {
  it("shows the join code big, the roster with claimed badges, and fetches both crew + records", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCrewRecords.mockResolvedValue(emptyRecords);
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

  // De-ghost (architecture-realignment Task 9): addCrewMember adds an EXISTING account golfer by
  // golferId (the input carries the golferId until Task 11's member-picker lands).
  it("Add member adds an account golfer by golferId and renders the refreshed roster from the response", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCrewRecords.mockResolvedValue(emptyRecords);
    mockedGetCourse.mockResolvedValue({ course: courseView });
    const refreshed: CrewView = { ...crew, members: [...crew.members, { golferId: golferId("dave-g"), name: "Dave", role: "member", claimed: true }] };
    mockedAddCrewMember.mockResolvedValue({ crew: refreshed });

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.change(screen.getByLabelText(/member name/i), { target: { value: "dave-g" } });
    fireEvent.click(screen.getByRole("button", { name: /add member/i }));

    await waitFor(() => expect(mockedAddCrewMember).toHaveBeenCalledTimes(1));
    expect(mockedAddCrewMember).toHaveBeenCalledWith(idToken, crewId("crew-1"), { golferId: golferId("dave-g") });
    // Scoped to the roster list — "Dave" also lands in the StandingGameEditor's players
    // checkboxes (the refreshed members prop flows there too, by design).
    await within(screen.getByRole("list", { name: /roster/i })).findByText("Dave");
  });

  it("renders the ledger table sorted by wins then points (both descending), W-L-H formatted, names joined from members", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedGetCrewRecords.mockResolvedValue({
      season: 2026,
      // Deliberately unsorted on the wire (the store returns golferId order) — the page owns
      // the wins-then-points presentation sort.
      ledger: [
        { golferId: golferId("ann-g"), rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3 },
        { golferId: golferId("bo-g"), rounds: 10, wins: 6, losses: 3, halves: 1, points: 180, skins: 7 },
        { golferId: golferId("cy-g"), rounds: 8, wins: 5, losses: 2, halves: 1, points: 250, skins: 0 },
      ],
      headToHead: [],
    });

    renderPage();
    await screen.findByText("CRW123");

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1); // drop the header row
    // Bo (6 wins) first; Cy before Ann (5 wins each, 250 > 210 points).
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["Bo", "Cy", "Ann"]);
    expect(within(rows[0]!).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Bo", "10", "6–3–1", "180", "7"]);
  });

  // Papercut 11 (M9 hardening): the ledger row now reads "Former member" + the truncated id as
  // an honest secondary line, never the bare truncated id alone.
  it("a ledger line whose golferId is not in members renders 'Former member' + the truncated id — never crashes (papercut 11)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedGetCrewRecords.mockResolvedValue({
      season: 2026,
      ledger: [{ golferId: golferId("dropped-member-0001"), rounds: 2, wins: 1, losses: 1, halves: 0, points: 40, skins: 1 }],
      headToHead: [],
    });

    renderPage();
    await screen.findByText("CRW123");

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Former member")).toBeTruthy();
    // Truncated raw id: starts with the id's own prefix, never the full 18-char string.
    expect(within(table).getByText(/^dropped-/)).toBeTruthy();
    expect(within(table).queryByText("dropped-member-0001")).toBeNull();
  });

  it("renders head-to-head lines as 'Ann 5–5–2 vs Bo'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedGetCrewRecords.mockResolvedValue({
      season: 2026,
      ledger: [{ golferId: golferId("ann-g"), rounds: 12, wins: 5, losses: 5, halves: 2, points: 0, skins: 0 }],
      headToHead: [{ a: golferId("ann-g"), b: golferId("bo-g"), aWins: 5, bWins: 5, halves: 2 }],
    });

    renderPage();
    await screen.findByText("CRW123");

    expect(await screen.findByText("Ann 5–5–2 vs Bo")).toBeTruthy();
  });

  it("empty records show the explainer instead of an empty table", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedGetCrewRecords.mockResolvedValue(emptyRecords);

    renderPage();
    await screen.findByText("CRW123");

    expect(await screen.findByText(/records build as crew rounds finalize/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  // Papercut 5 (M9 hardening): a crew with no saved preset still shows the affordance, but
  // disabled with an honest explainer instead of vanishing outright.
  it("'Play the usual' renders disabled with an explainer when the crew has no standing game", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    const noPreset: CrewView = { ...crew, standingGame: undefined };
    mockedGetCrew.mockResolvedValue({ crew: noPreset });
    mockedGetCrewRecords.mockResolvedValue(emptyRecords);

    renderPage();
    await screen.findByText("CRW123");

    const button = screen.getByRole("button", { name: /play the usual/i });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/save a standing game first/i)).toBeTruthy();

    fireEvent.click(button);
    // Never navigates — router state probe never mounts.
    expect(screen.queryByTestId("create-probe")).toBeNull();
  });

  // Papercut 12 (M9 hardening): a records fetch failure previously left the "Season records"
  // heading with nothing underneath it — now it shows one quiet, honest line instead.
  it("a records fetch failure shows a quiet line under the heading, not a bare heading with nothing below", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedGetCrewRecords.mockRejectedValue(new Error("network down"));

    renderPage();
    await screen.findByText("CRW123");

    expect(await screen.findByText("Could not load records right now.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/records build as crew rounds finalize/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/network down/);
  });

  it("'Play the usual' hands the crew's id + members + preset to /create via router state", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCrewRecords.mockResolvedValue(emptyRecords);
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: /play the usual/i }));

    const probe = await screen.findByTestId("create-probe");
    expect(JSON.parse(probe.textContent!)).toEqual({
      crewPreset: { crewId: "crew-1", members: crew.members, standingGame: crew.standingGame },
    });
  });

  it("saving the standing game PUTs the whole preset and re-renders from the response", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedGetCrewRecords.mockResolvedValue(emptyRecords);
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
    mockedGetCrewRecords.mockRejectedValue(new ApiError("not-a-member", 403, 'golfer "zed-g" is not a member of crew "crew-1"'));

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
