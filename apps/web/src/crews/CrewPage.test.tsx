import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId, golferId } from "@swng/domain";
import type { CrewSeasonView, CrewView, SeasonStandingsResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom) — CrewPage composes SeasonPanel
// (architecture-realignment Task 11) on top of its own crew calls. Crews are a
// grouping/competition only (spec §11a, owner ruling) — CrewPage no longer composes a course
// picker or any standing-game editor, so getCourse/searchCourses/saveStandingGame are gone from
// this mock entirely. SeasonPanel only ever mounts once a season is selected, so its own calls
// (getSeasonStandings/getMyRounds/appendCountedRound/removeCountedRound) are stubbed here for
// the two tests that select a season — SeasonPanel's OWN full behavior (standings table,
// head-to-head, the count-a-round picker, remove affordance) is pinned directly against
// SeasonPanel in SeasonPanel.test.tsx, not re-tested through this composition.
vi.mock("../api", () => ({
  getCrew: vi.fn(),
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

import { ApiError, createSeason, getCrew, getMe, getSeasonStandings, leaveCrew, listSeasons } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CrewPage } from "./CrewPage";

const mockedGetCrew = vi.mocked(getCrew);
const mockedGetMe = vi.mocked(getMe);
const mockedCreateSeason = vi.mocked(createSeason);
const mockedListSeasons = vi.mocked(listSeasons);
const mockedGetSeasonStandings = vi.mocked(getSeasonStandings);
const mockedLeaveCrew = vi.mocked(leaveCrew);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetCrew.mockReset();
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

const crew: CrewView = {
  crewId: crewId("crew-1"),
  name: "Sunday crew",
  joinCode: "CRW123",
  members: [
    { golferId: golferId("ann-g"), name: "Ann", role: "organizer", claimed: true },
    { golferId: golferId("bo-g"), name: "Bo", role: "member", claimed: false },
    { golferId: golferId("cy-g"), name: "Cy", role: "member", claimed: true },
  ],
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

    renderPage();
    await screen.findByText("CRW123");

    expect(screen.queryByLabelText(/member name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^add member$/i })).toBeNull();
  });

  // Owner ruling (spec §11a): a crew is a grouping/competition only — no standing game, no
  // "Play the usual." This pins the negative directly: none of the deleted feature's strings
  // render anywhere on the page, for a crew whose CrewView still happens to carry a
  // `standingGame` (the wire field itself only dies in the backend task that follows this one —
  // the point here is that the WEB never reads or renders it even when it's present).
  it("no standing-game or play-the-usual remnants render, even when the crew's own view still carries a standingGame field", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({
      crew: { ...crew, standingGame: { tee: "white", games: [] } },
    });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await screen.findByText("CRW123");

    expect(screen.queryByText(/play the usual/i)).toBeNull();
    expect(screen.queryByText(/the standing game/i)).toBeNull();
    expect(screen.queryByText(/save a standing game first/i)).toBeNull();
    expect(screen.queryByText(/configured games/i)).toBeNull();
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
    mockedListSeasons.mockResolvedValue({ seasons: [seasonB] });
    mockedGetSeasonStandings.mockResolvedValue(emptyStandings("season-b", "2026"));

    renderPage();
    await screen.findByText("CRW123");

    fireEvent.click(screen.getByRole("button", { name: "2026" }));

    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledWith(expect.any(String), crewId("crew-1"), "season-b"));
    expect(await screen.findByText(/standings build as rounds are counted/i)).toBeTruthy();
  });

  it("a season list containing a closed season renders its closed badge", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    const closedSeason: CrewSeasonView = { seasonId: "season-closed", name: "2025", status: "closed", createdAtMs: 1_000 };
    mockedListSeasons.mockResolvedValue({ seasons: [seasonB, closedSeason] });

    renderPage();
    await screen.findByText("CRW123");

    const seasonsList = await screen.findByRole("list", { name: /seasons/i });
    const items = within(seasonsList).getAllByRole("button");
    const closedItem = items.find((button) => button.textContent.includes("2025"))!;
    expect(closedItem.textContent).toContain("closed");
  });


  it("creates a season with the typed name, POSTs it, and adds it to the list", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
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
