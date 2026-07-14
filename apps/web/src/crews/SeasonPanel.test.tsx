import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId, golferId, roundId } from "@swng/domain";
import type { GetMyRoundsResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom) — SeasonPanel owns its own fetching
// (useAuth's withAuth), same as SetupPanel's crew quick-add.
vi.mock("../api", () => ({
  getSeasonStandings: vi.fn(),
  getMyRounds: vi.fn(),
  appendCountedRound: vi.fn(),
  removeCountedRound: vi.fn(),
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

import { appendCountedRound, ApiError, getMe, getMyRounds, getSeasonStandings, removeCountedRound } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { SeasonPanel } from "./SeasonPanel";

const mockedGetSeasonStandings = vi.mocked(getSeasonStandings);
const mockedGetMyRounds = vi.mocked(getMyRounds);
const mockedAppendCountedRound = vi.mocked(appendCountedRound);
const mockedRemoveCountedRound = vi.mocked(removeCountedRound);
const mockedGetMe = vi.mocked(getMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetSeasonStandings.mockReset();
  mockedGetMyRounds.mockReset();
  mockedAppendCountedRound.mockReset();
  mockedRemoveCountedRound.mockReset();
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

const ANN = golferId("ann-g");
const BO = golferId("bo-g");
const CREW = crewId("crew-1");

const distribution = { eagles: 0, birdies: 2, pars: 8, bogeys: 6, doublePlus: 2 };

// Renders SeasonPanel directly (not through CrewPage) — CrewPage.test.tsx only pins that
// selecting a season wires the right crewId/seasonId/myGolferId through; SeasonPanel's own full
// behavior (standings, head-to-head, counted rounds, the count-a-round picker, remove) is pinned
// here in isolation.
const renderPanel = (myGolferId = ANN) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/crews/crew-1"]}>
        <Routes>
          <Route path="/crews/:crewId" element={<SeasonPanel crewId={CREW} seasonId="season-1" myGolferId={myGolferId} />} />
          <Route path="/rounds/:roundId/archive" element={<div data-testid="archive-probe">archive</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("SeasonPanel — standings", () => {
  it("renders the ledger sorted by wins then points (both descending)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" },
        { golferId: BO, rounds: 10, wins: 6, losses: 3, halves: 1, points: 180, skins: 7, name: "Bo" },
      ],
      headToHead: [],
    });

    renderPanel();

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1); // drop the header row
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([expect.stringContaining("Bo"), expect.stringContaining("Ann")]);
  });

  // Crews became accounts-only rosters (architecture-realignment Phase 3): the guest label is
  // dead regardless of a ledger line's `member` flag — this pins the negative for BOTH values
  // (the wire field itself only dies in a later task; the point here is the web never renders
  // off it, whatever it happens to carry).
  it("never renders a guest label for any ledger row", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" },
        { golferId: BO, rounds: 10, wins: 6, losses: 3, halves: 1, points: 180, skins: 7, name: "Bo" },
      ],
      headToHead: [],
    });

    renderPanel();

    await screen.findByRole("table");
    expect(screen.queryByText(/guest/i)).toBeNull();
  });

  it("renders head-to-head as 'Ann 5–5–2 vs Bo', names resolved from the ledger", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: ANN, rounds: 12, wins: 5, losses: 5, halves: 2, points: 0, skins: 0, name: "Ann" },
        { golferId: BO, rounds: 12, wins: 5, losses: 5, halves: 2, points: 0, skins: 0, name: "Bo" },
      ],
      headToHead: [{ a: ANN, b: BO, aWins: 5, bWins: 5, halves: 2 }],
    });

    renderPanel();

    expect(await screen.findByText("Ann 5–5–2 vs Bo")).toBeTruthy();
  });

  // Papercut 9: the empty-ledger copy distinguishes two different truths — no counted rounds
  // at all (standings genuinely haven't started building) vs. counted rounds exist but every
  // contributor is off the current roster (the ledger is empty for a DIFFERENT reason).
  it("zero counted rounds: shows the build-up explainer, not an empty table", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [] });

    renderPanel();

    expect(await screen.findByText("Standings build as rounds are counted.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("counted rounds exist but an empty ledger (every contributor off the roster): tells the truth instead of the build-up copy", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }],
      ledger: [],
      headToHead: [],
    });

    renderPanel();

    expect(await screen.findByText("No current members appear in this season's counted rounds.")).toBeTruthy();
    expect(screen.queryByText("Standings build as rounds are counted.")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a standings load failure renders an honest quiet message, never a thrown render", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockRejectedValue(new Error("network down"));

    renderPanel();

    expect(await screen.findByText(/could not load this season/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});

describe("SeasonPanel — counted rounds", () => {
  it("counted-round rows link to /rounds/<id>/archive; remove shows ONLY on the caller's own appended rows", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [
        { roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }, // mine
        { roundId: roundId("round-2"), finalizedAt: 1_700_100_000_000, appendedBy: BO }, // not mine
      ],
      ledger: [],
      headToHead: [],
    });

    renderPanel(ANN);

    const list = await screen.findByRole("list", { name: /counted rounds/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const mine = items.find((li) => within(li).getByRole("link").getAttribute("href") === "/rounds/round-1/archive")!;
    const theirs = items.find((li) => within(li).getByRole("link").getAttribute("href") === "/rounds/round-2/archive")!;
    expect(within(mine).getByRole("button", { name: /remove/i })).toBeTruthy();
    expect(within(theirs).queryByRole("button", { name: /remove/i })).toBeNull();

    fireEvent.click(within(mine).getByRole("link"));
    expect(await screen.findByTestId("archive-probe")).toBeTruthy();
  });

  it("removing a counted round DELETEs it and refreshes standings", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings
      .mockResolvedValueOnce({
        seasonId: "season-1",
        name: "2026",
        status: "open",
        rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }],
        ledger: [],
        headToHead: [],
      })
      .mockResolvedValueOnce({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [] });
    mockedRemoveCountedRound.mockResolvedValue({ roundId: roundId("round-1") });

    renderPanel();
    const list = await screen.findByRole("list", { name: /counted rounds/i });

    fireEvent.click(within(list).getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(mockedRemoveCountedRound).toHaveBeenCalledWith(idToken, CREW, "season-1", roundId("round-1")));
    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no rounds counted yet/i)).toBeTruthy();
  });
});

describe("SeasonPanel — count a round", () => {
  const myRounds: GetMyRoundsResponse["rounds"] = [
    { roundId: roundId("round-9"), courseName: "Casa Verde GC", tee: "white", holes: 18, ags: 84, differential: 12.3, distribution, finalizedAt: 1_700_000_000_000 },
    { roundId: roundId("round-1"), courseName: "Old Muni", tee: "blue", holes: 18, ags: 90, differential: 18.1, distribution, finalizedAt: 1_699_000_000_000 },
  ];

  it("lists my finalized rounds not yet counted in THIS season; the empty state is honest", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_699_000_000_000, appendedBy: ANN }], // already counted this season
      ledger: [],
      headToHead: [],
    });
    mockedGetMyRounds.mockResolvedValue({ rounds: myRounds });

    renderPanel();
    await screen.findByRole("list", { name: /counted rounds/i });

    fireEvent.click(screen.getByRole("button", { name: /count a round/i }));

    // round-1 is already counted this season -> excluded; round-9 is offered.
    expect(await screen.findByRole("button", { name: /casa verde gc/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /old muni/i })).toBeNull();
  });

  it("no uncounted finalized rounds: the empty state says so", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [] });
    mockedGetMyRounds.mockResolvedValue({ rounds: [] });

    renderPanel();
    await screen.findByText(/standings build as rounds are counted/i);

    fireEvent.click(screen.getByRole("button", { name: /count a round/i }));

    expect(await screen.findByText(/you have no uncounted finalized rounds/i)).toBeTruthy();
  });

  it("picking a round POSTs the append and refreshes standings", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings
      .mockResolvedValueOnce({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [] })
      .mockResolvedValueOnce({
        seasonId: "season-1",
        name: "2026",
        status: "open",
        rounds: [{ roundId: roundId("round-9"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }],
        ledger: [],
        headToHead: [],
      });
    mockedGetMyRounds.mockResolvedValue({ rounds: myRounds });
    mockedAppendCountedRound.mockResolvedValue({ round: { roundId: roundId("round-9"), finalizedAt: 1_700_000_000_000, appendedBy: ANN } });

    renderPanel();
    await screen.findByText(/standings build as rounds are counted/i);

    fireEvent.click(screen.getByRole("button", { name: /count a round/i }));
    fireEvent.click(await screen.findByRole("button", { name: /casa verde gc/i }));

    await waitFor(() => expect(mockedAppendCountedRound).toHaveBeenCalledWith(idToken, CREW, "season-1", { roundId: roundId("round-9") }));
    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledTimes(2));
  });

  it("409 round-already-counted surfaces as 'Already counted for this season.' — never raw error text (M9 discipline)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [] });
    mockedGetMyRounds.mockResolvedValue({ rounds: myRounds });
    mockedAppendCountedRound.mockRejectedValue(new ApiError("round-already-counted", 409, "round round-9 is already counted in season season-1 of crew crew-1"));

    renderPanel();
    await screen.findByText(/standings build as rounds are counted/i);

    fireEvent.click(screen.getByRole("button", { name: /count a round/i }));
    fireEvent.click(await screen.findByRole("button", { name: /casa verde gc/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Already counted for this season.");
    expect(document.body.textContent).not.toMatch(/is already counted in season season-1 of crew crew-1/);
  });

  it("409 season-closed surfaces as 'This season is closed.' — never raw error text (M9 discipline)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [] });
    mockedGetMyRounds.mockResolvedValue({ rounds: myRounds });
    mockedAppendCountedRound.mockRejectedValue(new ApiError("season-closed", 409, "season season-1 of crew crew-1 is closed"));

    renderPanel();
    await screen.findByText(/standings build as rounds are counted/i);

    fireEvent.click(screen.getByRole("button", { name: /count a round/i }));
    fireEvent.click(await screen.findByRole("button", { name: /casa verde gc/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This season is closed.");
    expect(document.body.textContent).not.toMatch(/season season-1 of crew crew-1/);
  });

  it("a closed season renders with a closed badge in the heading", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "closed",
      rounds: [
        { roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN },
      ],
      ledger: [
        { golferId: ANN, rounds: 1, wins: 0, losses: 0, halves: 0, points: 0, skins: 0, name: "Ann" },
      ],
      headToHead: [],
    });

    renderPanel();

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(heading.textContent).toContain("2026");
    expect(within(heading).getByText(/closed/i)).toBeTruthy();
  });
});
