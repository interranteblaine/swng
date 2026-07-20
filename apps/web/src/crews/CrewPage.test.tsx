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
// SeasonPanel in SeasonPanel.test.tsx, not re-tested through this composition. Crew membership
// (invited in, accountable out — spec §1/§2): mintCrewInvite/removeCrewMember/transferOrganizer
// are the C-T3 additions replacing the deleted join-code/add-by-id surface.
vi.mock("../api", () => ({
  getCrew: vi.fn(),
  getMe: vi.fn(),
  createSeason: vi.fn(),
  listSeasons: vi.fn(),
  getSeasonStandings: vi.fn(),
  leaveCrew: vi.fn(),
  mintCrewInvite: vi.fn(),
  removeCrewMember: vi.fn(),
  transferOrganizer: vi.fn(),
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

import { ApiError, createSeason, getCrew, getMe, getSeasonStandings, leaveCrew, listSeasons, mintCrewInvite, removeCrewMember, transferOrganizer } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CrewPage } from "./CrewPage";

const mockedGetCrew = vi.mocked(getCrew);
const mockedGetMe = vi.mocked(getMe);
const mockedCreateSeason = vi.mocked(createSeason);
const mockedListSeasons = vi.mocked(listSeasons);
const mockedGetSeasonStandings = vi.mocked(getSeasonStandings);
const mockedLeaveCrew = vi.mocked(leaveCrew);
const mockedMintCrewInvite = vi.mocked(mintCrewInvite);
const mockedRemoveCrewMember = vi.mocked(removeCrewMember);
const mockedTransferOrganizer = vi.mocked(transferOrganizer);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetCrew.mockReset();
  mockedGetMe.mockReset();
  mockedCreateSeason.mockReset();
  mockedListSeasons.mockReset();
  mockedGetSeasonStandings.mockReset();
  mockedLeaveCrew.mockReset();
  mockedMintCrewInvite.mockReset();
  mockedRemoveCrewMember.mockReset();
  mockedTransferOrganizer.mockReset();
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
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
  return idToken;
};

const crew: CrewView = {
  crewId: crewId("crew-1"),
  name: "Sunday crew",
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

// Every test below waits on the Invite button (the code panel's C-T3 replacement) as its "crew
// has loaded" signal, the same role the old "CRW123" join-code text used to play.
const waitForLoaded = () => screen.findByRole("button", { name: "Invite" });

describe("CrewPage", () => {
  it("shows an Invite button (no join code) and the roster with claimed + organizer badges", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();

    await waitForLoaded();
    expect(screen.getByText("Sunday crew")).toBeTruthy();
    // Nav infrastructure Task 2: usePageTitle re-runs once the crew loads — the crew's own name.
    expect(document.title).toBe("Sunday crew · swng");
    // The permanent join code is gone outright — no six-character code renders anywhere.
    expect(screen.queryByText(/crew code/i)).toBeNull();

    const roster = screen.getByRole("list", { name: /roster/i });
    const items = within(roster).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("Ann"), expect.stringContaining("Bo"), expect.stringContaining("Cy")]);
    // Claimed badge on Ann and Cy, not on ghost Bo.
    expect(within(items[0]!).getByText(/account/i)).toBeTruthy();
    expect(within(items[1]!).queryByText(/account/i)).toBeNull();
    expect(within(items[2]!).getByText(/account/i)).toBeTruthy();
    // Organizer badge on Ann only — an EXACT "organizer" match, since Bo/Cy's own rows also
    // carry a "Make organizer…" button whose text a loose /organizer/i substring would wrongly
    // match too.
    expect(within(items[0]!).getByText(/^organizer$/i)).toBeTruthy();
    expect(within(items[1]!).queryByText(/^organizer$/i)).toBeNull();
    expect(within(items[2]!).queryByText(/^organizer$/i)).toBeNull();
  });

  // De-ghost (architecture-realignment Task 9) removed the free-text ghost-mint form; Task 11
  // removes the golferId-based "Add member" form from the UI entirely too, and crew membership
  // (invited in, accountable out — spec §3) removes add-by-id outright — an invite link is the
  // one way in now.
  it("no 'Add member' form renders — an Invite link is the one way to grow the roster", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    expect(screen.queryByLabelText(/member name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^add member$/i })).toBeNull();
  });

  // Owner ruling (spec §11a): a crew is a grouping/competition only — no standing game, no
  // "Play the usual." This pins the negative directly: none of the deleted feature's strings
  // render anywhere on the page, even for a crew whose STORED wire payload still happens to
  // carry a stray `standingGame` (a legacy server response, or a stale field the wire type no
  // longer declares at all now that the backend has deleted it too — `as unknown as CrewView`
  // is the deliberate escape hatch, since a real `CrewView` literal can no longer even type
  // this shape) — the point here is that the WEB never reads or renders it even when present.
  it("no standing-game or play-the-usual remnants render, even when the crew's own payload still carries a stray standingGame field", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({
      crew: { ...crew, standingGame: { tee: "white", games: [] } } as unknown as CrewView,
    });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    expect(screen.queryByText(/play the usual/i)).toBeNull();
    expect(screen.queryByText(/the standing game/i)).toBeNull();
    expect(screen.queryByText(/save a standing game first/i)).toBeNull();
    expect(screen.queryByText(/configured games/i)).toBeNull();
  });

  it("a non-member 403 shows humanized copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("zed-g"), name: "Zed" } });
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

// Crew membership (invited in, accountable out — spec §2): the join-code panel is replaced by an
// Invite button — mint, compose the join link from this device's own origin, copy it, and show
// the EXACT feedback copy the brief pins.
describe("CrewPage — invite", () => {
  it("mints an invite, composes /crews/join#<token> from this device's own origin, and copies it — exact feedback copy", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedMintCrewInvite.mockResolvedValue({ token: "invite-tok-1", expiresAtMs: 1_700_000_000_000 });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => expect(mockedMintCrewInvite).toHaveBeenCalledWith(idToken, crewId("crew-1")));
    const expectedUrl = `${window.location.origin}/crews/join#invite-tok-1`;
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedUrl));
    expect(await screen.findByText("Link copied — good for 7 days.")).toBeTruthy();
    expect(screen.getByText(expectedUrl)).toBeTruthy();
  });

  it("still shows the raw url as a visible fallback when clipboard access fails", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedMintCrewInvite.mockResolvedValue({ token: "invite-tok-2", expiresAtMs: 1_700_000_000_000 });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("permission denied");
        }),
      },
    });

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => expect(screen.getByText("Copy this link — good for 7 days.")).toBeTruthy());
    expect(screen.getByText(`${window.location.origin}/crews/join#invite-tok-2`)).toBeTruthy();
  });

  it("a mint failure shows honest copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedMintCrewInvite.mockRejectedValue(new Error("network down"));

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not create an invite link — try again.");
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});

// Crew membership (invited in, accountable out — spec §1): the organizer's roster authority —
// Remove…/Make organizer… render ONLY for the organizer, and never on the organizer's own row.
describe("CrewPage — organizer authority", () => {
  it("the organizer sees Remove…/Make organizer… on every OTHER row, never on their own", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    const roster = screen.getByRole("list", { name: /roster/i });
    const items = within(roster).getAllByRole("listitem");
    // Bo and Cy's rows: both affordances — awaited, since they render only once auth.golfer's
    // own async GET /me settles (a separate fetch from getCrew's own, no ordering guarantee
    // between the two).
    expect(await within(items[1]!).findByRole("button", { name: /^remove…$/i })).toBeTruthy();
    expect(within(items[1]!).getByRole("button", { name: /^make organizer…$/i })).toBeTruthy();
    expect(within(items[2]!).getByRole("button", { name: /^remove…$/i })).toBeTruthy();
    expect(within(items[2]!).getByRole("button", { name: /^make organizer…$/i })).toBeTruthy();
    // Ann's own row (organizer): neither affordance — checked AFTER the above await, so
    // auth.golfer has definitely settled by now (a false negative here would otherwise be
    // indistinguishable from "still loading").
    expect(within(items[0]!).queryByRole("button", { name: /^remove…$/i })).toBeNull();
    expect(within(items[0]!).queryByRole("button", { name: /^make organizer…$/i })).toBeNull();
  });

  it("a non-organizer sees neither affordance on any row", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    expect(screen.queryByRole("button", { name: /^remove…$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^make organizer…$/i })).toBeNull();
  });

  it("Remove…: exact confirm copy naming the member, cancel does nothing", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    const roster = screen.getByRole("list", { name: /roster/i });
    const boRow = within(roster).getAllByRole("listitem")[1]!;
    fireEvent.click(await within(boRow).findByRole("button", { name: /^remove…$/i }));

    const dialog = within(boRow).getByRole("dialog");
    expect(dialog.textContent).toContain("Remove Bo from the crew? Their rounds stay counted; their standings return if they're invited back.");
    expect(mockedRemoveCrewMember).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(within(boRow).queryByRole("dialog")).toBeNull();
    expect(mockedRemoveCrewMember).not.toHaveBeenCalled();
  });

  it("Remove…: confirming DELETEs the member and replaces the roster with the server's response", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    const afterRemoval: CrewView = { ...crew, members: crew.members.filter((m) => m.golferId !== golferId("bo-g")) };
    mockedRemoveCrewMember.mockResolvedValue({ crew: afterRemoval });

    renderPage();
    await waitForLoaded();

    const roster = screen.getByRole("list", { name: /roster/i });
    const boRow = within(roster).getAllByRole("listitem")[1]!;
    fireEvent.click(await within(boRow).findByRole("button", { name: /^remove…$/i }));
    fireEvent.click(within(boRow).getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(mockedRemoveCrewMember).toHaveBeenCalledWith(idToken, crewId("crew-1"), golferId("bo-g")));
    await waitFor(() => expect(within(screen.getByRole("list", { name: /roster/i })).queryByText("Bo")).toBeNull());
  });

  // The reviewer forward-flag (task-C-T3-brief.md): a race where the target vanished before this
  // click must NOT surface humanizeCrewLoadError's "You're not a member of this crew" — the
  // organizer plainly IS one; the honest copy names the TARGET's own vanished standing.
  it("Remove…: a not-a-member failure (target vanished mid-race) gets copy distinct from 'you're not a member'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedRemoveCrewMember.mockRejectedValue(new ApiError("not-a-member", 403, 'golfer "bo-g" is not a member of crew "crew-1"'));

    renderPage();
    await waitForLoaded();

    const roster = screen.getByRole("list", { name: /roster/i });
    const boRow = within(roster).getAllByRole("listitem")[1]!;
    fireEvent.click(await within(boRow).findByRole("button", { name: /^remove…$/i }));
    fireEvent.click(within(boRow).getByRole("button", { name: /confirm/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That member isn't in this crew anymore.");
    expect(alert.textContent).not.toMatch(/you're not a member/i);
  });

  it("Make organizer…: confirming transfers the role and replaces the roster with the server's response", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    const afterTransfer: CrewView = {
      ...crew,
      members: crew.members.map((m) => ({ ...m, role: m.golferId === golferId("bo-g") ? "organizer" : "member" })),
    };
    mockedTransferOrganizer.mockResolvedValue({ crew: afterTransfer });

    renderPage();
    await waitForLoaded();

    const roster = screen.getByRole("list", { name: /roster/i });
    const boRow = within(roster).getAllByRole("listitem")[1]!;
    fireEvent.click(await within(boRow).findByRole("button", { name: /^make organizer…$/i }));
    const dialog = within(boRow).getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(mockedTransferOrganizer).toHaveBeenCalledWith(idToken, crewId("crew-1"), { golferId: golferId("bo-g") }));
    // After the transfer, Bo carries the organizer badge and (as the new organizer's row) no
    // longer offers Remove…/Make organizer… to the still-viewing former organizer's own render.
    const updatedRoster = screen.getByRole("list", { name: /roster/i });
    const updatedBoRow = within(updatedRoster).getAllByRole("listitem")[1]!;
    expect(within(updatedBoRow).getByText(/organizer/i)).toBeTruthy();
  });

  it("the organizer's own row has no Leave crew button — a note names transferring first instead", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    // Waited for first (findBy retries): the note renders only once auth.golfer's own async
    // GET /me settles, a separate fetch from getCrew's own with no ordering guarantee between
    // the two — only once it's visible is "no Leave crew button" a settled assertion rather
    // than an accidental snapshot of the loading window.
    expect(await screen.findByText(/make someone else the organizer to leave the crew/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /leave crew/i })).toBeNull();
  });
});

// Architecture-realignment Task 11: the crew page speaks seasons — a list + "New season", and
// picking one renders SeasonPanel.
describe("CrewPage — seasons", () => {
  const seasonA: CrewSeasonView = { seasonId: "season-a", name: "2025", status: "open", createdAtMs: 1_000 };
  const seasonB: CrewSeasonView = { seasonId: "season-b", name: "2026", status: "open", createdAtMs: 2_000 };

  it("lists seasons newest-createdAtMs-first, even when the wire returns them in another order", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    // Deliberately wire-unsorted (oldest first) — CrewPage imposes its own newest-first order.
    mockedListSeasons.mockResolvedValue({ seasons: [seasonA, seasonB] });

    renderPage();
    await waitForLoaded();

    const seasonsList = await screen.findByRole("list", { name: /seasons/i });
    const items = within(seasonsList).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("2026"), expect.stringContaining("2025")]);
  });

  it("picking a season fetches and renders its standings via SeasonPanel", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue({ seasons: [seasonB] });
    mockedGetSeasonStandings.mockResolvedValue(emptyStandings("season-b", "2026"));

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "2026" }));

    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledWith(expect.any(String), crewId("crew-1"), "season-b"));
    expect(await screen.findByText(/standings build as rounds are counted/i)).toBeTruthy();
  });

  it("a season list containing a closed season renders its closed badge", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    const closedSeason: CrewSeasonView = { seasonId: "season-closed", name: "2025", status: "closed", createdAtMs: 1_000 };
    mockedListSeasons.mockResolvedValue({ seasons: [seasonB, closedSeason] });

    renderPage();
    await waitForLoaded();

    const seasonsList = await screen.findByRole("list", { name: /seasons/i });
    const items = within(seasonsList).getAllByRole("button");
    const closedItem = items.find((button) => button.textContent.includes("2025"))!;
    expect(closedItem.textContent).toContain("closed");
  });

  it("creates a season with the typed name, POSTs it, and adds it to the list", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedCreateSeason.mockResolvedValue({ season: seasonB });
    mockedGetSeasonStandings.mockResolvedValue(emptyStandings("season-b", "2026"));

    renderPage();
    await waitForLoaded();

    fireEvent.change(screen.getByLabelText(/new season/i), { target: { value: "2026" } });
    fireEvent.click(screen.getByRole("button", { name: /create season/i }));

    await waitFor(() => expect(mockedCreateSeason).toHaveBeenCalledWith(idToken, crewId("crew-1"), { name: "2026" }));

    const seasonsList = await screen.findByRole("list", { name: /seasons/i });
    expect(within(seasonsList).getByText("2026")).toBeTruthy();
  });

  it("a 400 invalid-season-name shows honest copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    // A well-formed-looking name still round-trips into the server's own 400 here — the point
    // is the CLIENT's error-copy handling, not manufacturing a real 61-char/whitespace-only
    // violation (the input's own maxLength=60 already keeps a real user from typing past the
    // bound; createSeason.ts's inline trim/length check is the source of truth either way).
    mockedCreateSeason.mockRejectedValue(new ApiError("invalid-season-name", 400, 'season name must be 1-60 characters: "Summer Cup"'));

    renderPage();
    await waitForLoaded();

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
// Crew membership (invited in, accountable out — spec §1): the organizer cannot leave — these
// tests sign in as Bo (a plain member), since Ann-the-organizer's own row is covered by the
// "organizer authority" describe block above (no Leave crew button at all).
describe("CrewPage — leave crew", () => {
  it("Leave crew reveals a confirm step and does nothing until confirmed", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    expect(screen.getByRole("dialog", { name: /confirm leave/i })).toBeTruthy();
    expect(mockedLeaveCrew).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog", { name: /confirm leave/i })).toBeNull();
    expect(mockedLeaveCrew).not.toHaveBeenCalled();
  });

  it("confirming leave POSTs /crews/{id}/leave and navigates home on success", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedLeaveCrew.mockResolvedValue({ crewId: crewId("crew-1") });

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(mockedLeaveCrew).toHaveBeenCalledWith(idToken, crewId("crew-1")));
    expect(await screen.findByTestId("home-probe")).toBeTruthy();
  });

  it("a leave failure shows honest copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    // A generic failure (network/500) — the unknown-crew arm (a race: the crew vanished between
    // load and this click) gets its own more specific copy, asserted separately below.
    mockedLeaveCrew.mockRejectedValue(new Error("network down"));

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not leave/i);
    expect(document.body.textContent).not.toMatch(/network down/);
    expect(screen.queryByTestId("home-probe")).toBeNull();
  });

  it("a leave against a crew that's vanished mid-race (unknown-crew) gets its own honest copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedLeaveCrew.mockRejectedValue(new ApiError("unknown-crew", 404, 'no crew "crew-1"'));

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/doesn't exist/i);
    expect(document.body.textContent).not.toMatch(/no crew "crew-1"/);
    expect(screen.queryByTestId("home-probe")).toBeNull();
  });

  it("a leave rejected with organizer-must-transfer (a stale role underneath the caller) names the way out", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);
    mockedLeaveCrew.mockRejectedValue(new ApiError("organizer-must-transfer", 409, "the organizer cannot leave — transfer the role to another member first"));

    renderPage();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: /leave crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/make someone else the organizer first/i);
    expect(document.body.textContent).not.toMatch(/the organizer cannot leave — transfer the role to another member first/);
  });
});
