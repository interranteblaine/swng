import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId, golferId, roundId } from "@swng/domain";
import type { GetMyRoundsResponse, SeasonStandingsResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom) — SeasonPanel owns its own fetching
// (useAuth's withAuth), same as SetupPanel's crew quick-add.
vi.mock("../api", () => ({
  getSeasonStandings: vi.fn(),
  getMyRounds: vi.fn(),
  appendCountedRound: vi.fn(),
  removeCountedRound: vi.fn(),
  closeSeason: vi.fn(),
  reopenSeason: vi.fn(),
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

import { appendCountedRound, ApiError, closeSeason, getMe, getMyRounds, getSeasonStandings, removeCountedRound, reopenSeason } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { SeasonPanel } from "./SeasonPanel";

const mockedGetSeasonStandings = vi.mocked(getSeasonStandings);
const mockedGetMyRounds = vi.mocked(getMyRounds);
const mockedAppendCountedRound = vi.mocked(appendCountedRound);
const mockedRemoveCountedRound = vi.mocked(removeCountedRound);
const mockedCloseSeason = vi.mocked(closeSeason);
const mockedReopenSeason = vi.mocked(reopenSeason);
const mockedGetMe = vi.mocked(getMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetSeasonStandings.mockReset();
  mockedGetMyRounds.mockReset();
  mockedAppendCountedRound.mockReset();
  mockedRemoveCountedRound.mockReset();
  mockedCloseSeason.mockReset();
  mockedReopenSeason.mockReset();
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
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
  return idToken;
};

const ANN = golferId("ann-g");
const BO = golferId("bo-g");
const CREW = crewId("crew-1");

const distribution = { eagles: 0, birdies: 2, pars: 8, bogeys: 6, doublePlus: 2 };

// Renders SeasonPanel directly (not through CrewPage) — CrewPage.test.tsx only pins that
// selecting a season wires the right crewId/seasonId/myGolferId/isOrganizer through;
// SeasonPanel's own full behavior (standings, head-to-head, counted rounds, the count-a-round
// picker, remove, close/reopen) is pinned here in isolation. `isOrganizer` defaults false — the
// conservative default for a permissions flag — so every PRE-EXISTING test above (none of which
// exercise the organizer-only verbs) keeps behaving exactly as it did before this prop existed.
const renderPanel = (myGolferId = ANN, isOrganizer = false) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/crews/crew-1"]}>
        <Routes>
          <Route path="/crews/:crewId" element={<SeasonPanel crewId={CREW} seasonId="season-1" myGolferId={myGolferId} isOrganizer={isOrganizer} />} />
          <Route path="/rounds/:roundId" element={<div data-testid="archive-probe">archive</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("SeasonPanel — standings", () => {
  // Standings order is domain truth, served (domain-boundary arc precedent — aggregateSeason,
  // packages/domain/src/crew/ledger.ts, ranks wins desc/points desc/golferId asc): the component
  // renders the ledger EXACTLY as served, with no re-ranking of its own. The fixture below is
  // already in served order (Bo: 6 wins, ahead of Ann's 5) — this pins render-in-served-order,
  // not a client-side sort (that invariant is pinned in ledger.test.ts, not here).
  it("renders the ledger rows in the order the API serves them", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: BO, rounds: 10, wins: 6, losses: 3, halves: 1, points: 180, skins: 7, name: "Bo" },
        { golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" },
      ],
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel();

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1); // drop the header row
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([expect.stringContaining("Bo"), expect.stringContaining("Ann")]);
  });

  // The link sweep (navigation spec, task 6): every rendered noun's name is its address — the
  // ledger's own Member column links to /golfers/:golferId.
  it("links each ledger row's name to /golfers/:golferId", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [{ golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" }],
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel();

    const table = await screen.findByRole("table");
    const annLink = within(table).getByRole("link", { name: "Ann" });
    expect(annLink.getAttribute("href")).toBe(`/golfers/${ANN}`);
  });

  // Crews became accounts-only rosters (architecture-realignment Phase 3): the guest label is
  // dead regardless of a ledger line's `member` flag — this pins the negative for BOTH values
  // (the wire field itself only dies in a later task; the point here is the web never renders
  // off it, whatever it happens to carry).
  it("never renders a guest label for any ledger row", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" },
        { golferId: BO, rounds: 10, wins: 6, losses: 3, halves: 1, points: 180, skins: 7, name: "Bo" },
      ],
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel();

    await screen.findByRole("table");
    expect(screen.queryByText(/guest/i)).toBeNull();
  });

  it("renders a tied head-to-head as a leader-first sentence — 'Ann and Bo are tied 5–5 · 2 halved'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: ANN, rounds: 12, wins: 5, losses: 5, halves: 2, points: 0, skins: 0, name: "Ann" },
        { golferId: BO, rounds: 12, wins: 5, losses: 5, halves: 2, points: 0, skins: 0, name: "Bo" },
      ],
      headToHead: [{ a: ANN, b: BO, aWins: 5, bWins: 5, halves: 2 }], partners: [], superlatives: {},
    });

    renderPanel();

    // Names are GolferLinks now (the link sweep, task 6) — RTL's getByText can't bridge a
    // nested <a>, so the sentence is read via the <li>'s own native textContent (this file's own
    // counted-round-link precedent already reads a <li> the same way).
    const list = await screen.findByRole("list", { name: "Head to head" });
    const item = within(list).getByRole("listitem");
    expect(item.textContent).toBe("Ann and Bo are tied 5–5 · 2 halved");
    expect(within(item).getByRole("link", { name: "Ann" }).getAttribute("href")).toBe(`/golfers/${ANN}`);
    expect(within(item).getByRole("link", { name: "Bo" }).getAttribute("href")).toBe(`/golfers/${BO}`);
  });

  // The helper reorders so the LEADER always comes first — even when the trailing party is `a`
  // in the raw headToHead row (b has more wins here, but Ann is still `a` in the wire shape).
  it("renders a leading head-to-head as a leader-first sentence, regardless of raw a/b order — 'Bo leads Ann 5–4'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: ANN, rounds: 9, wins: 4, losses: 5, halves: 0, points: 0, skins: 0, name: "Ann" },
        { golferId: BO, rounds: 9, wins: 5, losses: 4, halves: 0, points: 0, skins: 0, name: "Bo" },
      ],
      headToHead: [{ a: ANN, b: BO, aWins: 4, bWins: 5, halves: 0 }], partners: [], superlatives: {},
    });

    renderPanel();

    const list = await screen.findByRole("list", { name: "Head to head" });
    const item = within(list).getByRole("listitem");
    expect(item.textContent).toBe("Bo leads Ann 5–4");
    expect(within(item).getByRole("link", { name: "Bo" }).getAttribute("href")).toBe(`/golfers/${BO}`);
    expect(within(item).getByRole("link", { name: "Ann" }).getAttribute("href")).toBe(`/golfers/${ANN}`);
  });

  // Papercut 9: the empty-ledger copy distinguishes two different truths — no counted rounds
  // at all (standings genuinely haven't started building) vs. counted rounds exist but every
  // contributor is off the current roster (the ledger is empty for a DIFFERENT reason).
  it("names the games in the column headers and footnote — no bare 'Points'/'W-L-H'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [{ golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" }],
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel();

    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["Member", "Rounds", "Matches (W–L–H)", "Stableford pts", "Skins"]);
    expect(
      screen.getByText("From this season's counted rounds — match results, Stableford points, and skins for current members."),
    ).toBeTruthy();
  });

  it("zero counted rounds: shows the build-up explainer, not an empty table", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [], partners: [], superlatives: {} });

    renderPanel();

    expect(await screen.findByText("Standings build as rounds are counted.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("counted rounds exist but an empty ledger (departed members, or no games at all): tells the truth instead of the build-up copy", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }],
      ledger: [],
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel();

    expect(await screen.findByText("No standings from these rounds yet — standings build from games between current members.")).toBeTruthy();
    expect(screen.queryByText("Standings build as rounds are counted.")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  // Review finding (task-6): the footnote glosses table columns, so it must not render under
  // either empty-ledger state — it belongs beside the table, not the build-up explainer.
  it("empty ledger: the table footnote does not render (nothing to gloss)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [], partners: [], superlatives: {} });

    renderPanel();

    await screen.findByText("Standings build as rounds are counted.");
    expect(screen.queryByText("From this season's counted rounds — match results, Stableford points, and skins for current members.")).toBeNull();
  });

  // Analytics read-folds spec 2026-07-21 §5: partners + superlatives from a fixture.
  it("renders partners and season superlatives from a fixture", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [
        { golferId: ANN, rounds: 6, wins: 3, losses: 2, halves: 1, points: 120, skins: 2, name: "Ann" },
        { golferId: BO, rounds: 6, wins: 2, losses: 3, halves: 1, points: 100, skins: 1, name: "Bo" },
      ],
      headToHead: [],
      partners: [{ a: ANN, b: BO, nameA: "Ann", nameB: "Bo", wins: 4, losses: 1, halves: 2 }],
      superlatives: {
        lowestNet: { holes: 18, average: 78.4, rounds: 4, golfers: [{ golferId: ANN, name: "Ann" }] },
        mostImproved: [{ golferId: BO, name: "Bo", from: 14.2, to: 11.8 }],
      },
    });

    renderPanel();

    expect(await screen.findByRole("heading", { name: "Partners — four-ball" })).toBeTruthy();
    expect(screen.getByText("Ann & Bo — 4–1 · 2 halved")).toBeTruthy();

    expect(screen.getByRole("heading", { name: "Season superlatives" })).toBeTruthy();
    expect(screen.getByText("Lowest net average — Ann · 78.4 (4 rounds)")).toBeTruthy();
    expect(screen.getByText("Most improved — Bo · 14.2 → 11.8")).toBeTruthy();
  });

  it("a tied lowest net and a 9-hole hole count render correctly; zero halves omits the suffix", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [{ golferId: ANN, rounds: 3, wins: 1, losses: 0, halves: 0, points: 20, skins: 0, name: "Ann" }],
      headToHead: [],
      partners: [{ a: ANN, b: BO, nameA: "Ann", nameB: "Bo", wins: 1, losses: 0, halves: 0 }],
      superlatives: {
        lowestNet: {
          holes: 9,
          average: 4.0,
          rounds: 3,
          golfers: [
            { golferId: ANN, name: "Ann" },
            { golferId: BO, name: "Bo" },
          ],
        },
      },
    });

    renderPanel();

    expect(await screen.findByText("Ann & Bo — 1–0")).toBeTruthy(); // no halves suffix at 0
    expect(screen.getByText("Lowest net average — Ann & Bo · 4.0 (3 rounds · 9 holes)")).toBeTruthy();
    expect(screen.queryByText(/Most improved/)).toBeNull();
  });

  it("empty partners and absent superlatives render NOTHING — no empty-state footnote", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [],
      ledger: [{ golferId: ANN, rounds: 3, wins: 1, losses: 0, halves: 0, points: 20, skins: 0, name: "Ann" }],
      headToHead: [],
      partners: [],
      superlatives: {},
    });

    renderPanel();

    await screen.findByRole("table");
    expect(screen.queryByRole("heading", { name: "Partners — four-ball" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Season superlatives" })).toBeNull();
    expect(screen.queryByText(/Lowest net average/)).toBeNull();
    expect(screen.queryByText(/Most improved/)).toBeNull();
  });

  it("a standings load failure renders an honest quiet message, never a thrown render", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockRejectedValue(new Error("network down"));

    renderPanel();

    expect(await screen.findByText(/could not load this season/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});

describe("SeasonPanel — counted rounds", () => {
  it("counted-round rows link to /rounds/<id>; remove shows ONLY on the caller's own appended rows", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [
        { roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }, // mine
        { roundId: roundId("round-2"), finalizedAt: 1_700_100_000_000, appendedBy: BO }, // not mine
      ],
      ledger: [],
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel(ANN);

    const list = await screen.findByRole("list", { name: /counted rounds/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const mine = items.find((li) => within(li).getByRole("link").getAttribute("href") === "/rounds/round-1")!;
    const theirs = items.find((li) => within(li).getByRole("link").getAttribute("href") === "/rounds/round-2")!;
    expect(within(mine).getByRole("button", { name: /remove/i })).toBeTruthy();
    expect(within(theirs).queryByRole("button", { name: /remove/i })).toBeNull();

    fireEvent.click(within(mine).getByRole("link"));
    expect(await screen.findByTestId("archive-probe")).toBeTruthy();
  });

  // Review finding (task-3): a closed season 409s removeCountedRound (season-closed) for ANY
  // caller, including the round's own appender — the same "door the server has closed" rule
  // the count-a-round affordance below already honors. Without this gate, the appender's own
  // Remove button stayed clickable-and-doomed on a closed season.
  it("a closed season hides Remove even on the caller's own appended round", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "closed",
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }], // mine
      ledger: [],
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel(ANN);

    const list = await screen.findByRole("list", { name: /counted rounds/i });
    expect(within(list).queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("removing a counted round DELETEs it and refreshes standings", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings
      .mockResolvedValueOnce({
        seasonId: "season-1",
        name: "2026",
        status: "open",
        rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }],
        ledger: [],
        headToHead: [], partners: [], superlatives: {},
      })
      .mockResolvedValueOnce({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [], partners: [], superlatives: {} });
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
    { roundId: roundId("round-9"), courseName: "Casa Verde GC", tee: "white", holes: 18, par: 72, courseHandicap: 8, ags: 84, differential: 12.3, distribution, finalizedAt: 1_700_000_000_000 },
    { roundId: roundId("round-1"), courseName: "Old Muni", tee: "blue", holes: 18, par: 72, courseHandicap: 14, ags: 90, differential: 18.1, distribution, finalizedAt: 1_699_000_000_000 },
  ];

  it("lists my finalized rounds not yet counted in THIS season; the empty state is honest", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({
      seasonId: "season-1",
      name: "2026",
      status: "open",
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_699_000_000_000, appendedBy: ANN }], // already counted this season
      ledger: [],
      headToHead: [], partners: [], superlatives: {},
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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [], partners: [], superlatives: {} });
    mockedGetMyRounds.mockResolvedValue({ rounds: [] });

    renderPanel();
    await screen.findByText(/standings build as rounds are counted/i);

    fireEvent.click(screen.getByRole("button", { name: /count a round/i }));

    expect(await screen.findByText(/you have no uncounted finalized rounds/i)).toBeTruthy();
  });

  it("picking a round POSTs the append and refreshes standings", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings
      .mockResolvedValueOnce({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [], partners: [], superlatives: {} })
      .mockResolvedValueOnce({
        seasonId: "season-1",
        name: "2026",
        status: "open",
        rounds: [{ roundId: roundId("round-9"), finalizedAt: 1_700_000_000_000, appendedBy: ANN }],
        ledger: [],
        headToHead: [], partners: [], superlatives: {},
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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [], partners: [], superlatives: {} });
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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue({ seasonId: "season-1", name: "2026", status: "open", rounds: [], ledger: [], headToHead: [], partners: [], superlatives: {} });
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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
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
      headToHead: [], partners: [], superlatives: {},
    });

    renderPanel();

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(heading.textContent).toContain("2026");
    expect(within(heading).getByText(/closed/i)).toBeTruthy();
  });
});

// close-season spec 2026-07-21 §2: the organizer's verb, the badge, and the closed door — an
// open season gives the organizer Close (behind a confirm carrying the EXACT teaching line the
// spec pins), a closed season shows the badge + Reopen (no confirm — spec §1.3, "first-class,
// not an apology") and hides the count-a-round affordance, and a non-organizer sees the badge
// alone either way.
describe("SeasonPanel — close/reopen season", () => {
  const openSeason: SeasonStandingsResponse = {
    seasonId: "season-1",
    name: "2026",
    status: "open",
    rounds: [],
    ledger: [],
    headToHead: [],
    partners: [],
    superlatives: {},
  };
  const closedSeason: SeasonStandingsResponse = { ...openSeason, status: "closed" };

  it("organizer + open season: Close season renders (no badge); confirming shows the EXACT teaching line", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue(openSeason);

    renderPanel(ANN, true);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).queryByText(/closed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close season" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirm close season" });
    expect(within(dialog).getByText("Closing locks this season's counted rounds and awards its titles — you can reopen it later.")).toBeTruthy();
  });

  it("confirming Close POSTs close and refreshes standings through the existing reload path (api-then-refetch)", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValueOnce(openSeason).mockResolvedValueOnce(closedSeason);
    mockedCloseSeason.mockResolvedValue({ season: { seasonId: "season-1", name: "2026", status: "closed", createdAtMs: 1, startsAtMs: 1, closedAtMs: 2 } });

    renderPanel(ANN, true);

    fireEvent.click(await screen.findByRole("button", { name: "Close season" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm close season" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mockedCloseSeason).toHaveBeenCalledWith(idToken, CREW, "season-1"));
    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("organizer + closed season: badge + Reopen render; the count-a-round affordance is NOT offered", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue(closedSeason);

    renderPanel(ANN, true);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).getByText(/closed/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close season" })).toBeNull();
    expect(screen.queryByRole("button", { name: /count a round/i })).toBeNull();
  });

  it("tapping Reopen POSTs reopen with no confirm step, and refreshes standings", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValueOnce(closedSeason).mockResolvedValueOnce(openSeason);
    mockedReopenSeason.mockResolvedValue({ season: { seasonId: "season-1", name: "2026", status: "open", createdAtMs: 1, startsAtMs: 1 } });

    renderPanel(ANN, true);

    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    await waitFor(() => expect(mockedReopenSeason).toHaveBeenCalledWith(idToken, CREW, "season-1"));
    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Close season" })).toBeTruthy();
  });

  it("non-organizer + closed season: badge only, no Close/Reopen verb anywhere", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue(closedSeason);

    renderPanel(ANN, false);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).getByText(/closed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close season" })).toBeNull();
  });

  it("non-organizer + open season: no Close verb, no badge", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue(openSeason);

    renderPanel(ANN, false);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).queryByText(/closed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Close season" })).toBeNull();
  });

  it("a close failure renders the honest fallback line, never raw error text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue(openSeason);
    mockedCloseSeason.mockRejectedValue(new ApiError("season-already-closed", 409, "season season-1 of crew crew-1 is already closed"));

    renderPanel(ANN, true);

    fireEvent.click(await screen.findByRole("button", { name: "Close season" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm close season" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not update the season — try again.");
    expect(document.body.textContent).not.toMatch(/season season-1 of crew crew-1/);
  });

  it("a reopen failure renders the honest fallback line, never raw error text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValue(closedSeason);
    mockedReopenSeason.mockRejectedValue(new ApiError("season-not-closed", 409, "season season-1 of crew crew-1 is not closed"));

    renderPanel(ANN, true);

    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not update the season — try again.");
    expect(document.body.textContent).not.toMatch(/season season-1 of crew crew-1/);
  });
});
