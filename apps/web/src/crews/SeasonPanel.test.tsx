import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId, golferId, roundId } from "@swng/domain";
import type { SeasonStandingsResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom) — SeasonPanel owns its own fetching
// (useAuth's withAuth). Crew-scoreboard spec (2026-07-21): standings are derived on read — no
// counting act, so the old counted-round mutations and getMyRounds are no longer called by this
// component at all (this component stopped using them before Task 5 deleted the routes).
vi.mock("../api", () => ({
  getSeasonStandings: vi.fn(),
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

import { ApiError, closeSeason, getMe, getSeasonStandings, reopenSeason } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { SeasonPanel } from "./SeasonPanel";

const mockedGetSeasonStandings = vi.mocked(getSeasonStandings);
const mockedCloseSeason = vi.mocked(closeSeason);
const mockedReopenSeason = vi.mocked(reopenSeason);
const mockedGetMe = vi.mocked(getMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetSeasonStandings.mockReset();
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

// A base standings fixture — every test spreads over this so a field nobody cares about (e.g.
// `startsAtMs`) never needs re-stating. `scoreboard`/`rounds`/`ledger`/`headToHead`/`partners`
// all default empty — no `superlatives` (crew-scoreboard spec §3c: superseded, gone from the
// wire), no `appendedBy` on rounds (a shared round is DERIVED, nobody appended it).
const baseStandings: SeasonStandingsResponse = {
  seasonId: "season-1",
  name: "2026",
  status: "open",
  startsAtMs: Date.UTC(2026, 0, 1),
  scoreboard: [],
  rounds: [],
  ledger: [],
  headToHead: [],
  partners: [],
};

// Renders SeasonPanel directly (not through CrewPage) — CrewPage.test.tsx only pins that
// selecting a season wires the right crewId/seasonId/isOrganizer through; SeasonPanel's own full
// behavior (scoreboard, standings, head-to-head, played-together, close/reopen) is pinned here in
// isolation. `isOrganizer` defaults false — the conservative default for a permissions flag — so
// every test that doesn't exercise the organizer-only verbs keeps behaving exactly the same.
const renderPanel = (isOrganizer = false) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/crews/crew-1"]}>
        <Routes>
          <Route path="/crews/:crewId" element={<SeasonPanel crewId={CREW} seasonId="season-1" isOrganizer={isOrganizer} />} />
          <Route path="/rounds/:roundId" element={<div data-testid="archive-probe">archive</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

const signInAsAnn = () => {
  signIn();
  mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
};

// Noon UTC (mirrors RecordSections.test.tsx's own anchor-date fixtures) — keeps the formatted
// local date stable regardless of which timezone the test runner's own host sits in; a midnight
// UTC timestamp can format as the PRIOR calendar day west of UTC.
const fmtDate = (ms: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(ms));

describe("SeasonPanel — window header", () => {
  it("an open season reads 'Since {date}' — no end date to name yet", async () => {
    signInAsAnn();
    const startsAtMs = Date.UTC(2026, 0, 1, 12, 0);
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, startsAtMs });

    renderPanel();

    expect(await screen.findByText(`Since ${fmtDate(startsAtMs)}`)).toBeTruthy();
  });

  it("a closed season names both ends of its window", async () => {
    signInAsAnn();
    const startsAtMs = Date.UTC(2026, 0, 1, 12, 0);
    const closedAtMs = Date.UTC(2026, 5, 15, 12, 0);
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, status: "closed", startsAtMs, closedAtMs });

    renderPanel();

    expect(await screen.findByText(`${fmtDate(startsAtMs)} – ${fmtDate(closedAtMs)}`)).toBeTruthy();
  });

  it("a closed season renders with a closed badge in the heading", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, status: "closed", closedAtMs: Date.UTC(2026, 5, 15) });

    renderPanel();

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(heading.textContent).toContain("2026");
    expect(within(heading).getByText(/closed/i)).toBeTruthy();
  });

  it("a standings load failure renders an honest quiet message, never a thrown render", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockRejectedValue(new Error("network down"));

    renderPanel();

    expect(await screen.findByText(/could not load this season/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});

describe("SeasonPanel — scoreboard", () => {
  it("renders scoreboard rows in SERVED order — no client sort", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      // Deliberately NOT in name/golferId order — Bo first, even though "Ann" would sort first
      // alphabetically — pinning that the component renders exactly what it's handed.
      scoreboard: [
        { golferId: BO, name: "Bo", rounds: 4, best18: { gross: 82, toPar: 10 }, netPer18: 1.2, index: 14.1, indexDelta: -0.4 },
        { golferId: ANN, name: "Ann", rounds: 2 },
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Scoreboard" });
    const rows = within(table).getAllByRole("row").slice(1); // drop the header row
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([expect.stringContaining("Bo"), expect.stringContaining("Ann")]);
  });

  it("links each scoreboard row's name to /golfers/:golferId", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 3 }] });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Scoreboard" });
    const link = within(table).getByRole("link", { name: "Ann" });
    expect(link.getAttribute("href")).toBe(`/golfers/${ANN}`);
  });

  it("every dash arm: rounds present, everything else absent renders — for all four optional cells", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 1 }] });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Scoreboard" });
    const row = within(table).getAllByRole("row")[1]!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]!.textContent).toBe("1"); // rounds
    expect(cells[2]!.textContent).toBe("—"); // best18
    expect(cells[3]!.textContent).toBe("—"); // netPer18
    expect(cells[4]!.textContent).toBe("—"); // index
  });

  it("best18 renders '{gross} ({vsPar})' — over and under par both", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, best18: { gross: 82, toPar: 10 } },
        { golferId: BO, name: "Bo", rounds: 5, best18: { gross: 68, toPar: -4 } },
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Scoreboard" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getAllByRole("cell")[2]!.textContent).toBe("82 (+10)");
    expect(within(rows[1]!).getAllByRole("cell")[2]!.textContent).toBe("68 (-4)");
  });

  // netPer18 is ALREADY a signed vs-par delta (crewScoreboard's own doc comment: "sum(ags −
  // courseHandicap − par) / sum(holes) × 18") — rendered through vsPar's own sign convention
  // exactly like best18's toPar, over par (positive), under par (negative), and dead even.
  it("netPer18 renders as a signed vs-par delta — over, under, and even", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, netPer18: 1.2 },
        { golferId: BO, name: "Bo", rounds: 5, netPer18: -0.5 },
        { golferId: golferId("cy-g"), name: "Cy", rounds: 5, netPer18: 0 },
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Scoreboard" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getAllByRole("cell")[3]!.textContent).toBe("+1.2");
    expect(within(rows[1]!).getAllByRole("cell")[3]!.textContent).toBe("-0.5");
    expect(within(rows[2]!).getAllByRole("cell")[3]!.textContent).toBe("E");
  });

  it("index renders the delta sign both directions, and with no delta at all", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, index: 14.1, indexDelta: -0.4 }, // improved
        { golferId: BO, name: "Bo", rounds: 5, index: 9.0, indexDelta: 0.6 }, // worsened
        { golferId: golferId("cy-g"), name: "Cy", rounds: 5, index: 20.0 }, // no delta at all
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Scoreboard" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getAllByRole("cell")[4]!.textContent).toBe("14.1 (−0.4)");
    expect(within(rows[1]!).getAllByRole("cell")[4]!.textContent).toBe("9.0 (+0.6)");
    expect(within(rows[2]!).getAllByRole("cell")[4]!.textContent).toBe("20.0");
  });

  it("renders the table footnote naming Best 18 / Net/18 / Index, including the 3-round floor", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 1 }] });

    renderPanel();

    expect(
      await screen.findByText("Best 18 — lowest gross, fully holed out · Net/18 — net vs par per 18 holes, from adjusted scores; builds at 3 rounds · Index — swng index, with change over this season."),
    ).toBeTruthy();
  });

  it("every row at rounds: 0 shows the honest empty line under the table", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 0 },
        { golferId: BO, name: "Bo", rounds: 0 },
      ],
    });

    renderPanel();

    await screen.findByRole("table", { name: "Scoreboard" });
    expect(await screen.findByText("Rounds appear here automatically when members finalize them.")).toBeTruthy();
  });

  it("at least one row with rounds > 0: the empty-board line does not render", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 3 },
        { golferId: BO, name: "Bo", rounds: 0 },
      ],
    });

    renderPanel();

    await screen.findByRole("table", { name: "Scoreboard" });
    expect(screen.queryByText("Rounds appear here automatically when members finalize them.")).toBeNull();
  });
});

describe("SeasonPanel — together records (ledger, head-to-head, partners)", () => {
  it("renders the ledger rows in the order the API serves them", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [
        { golferId: BO, rounds: 10, wins: 6, losses: 3, halves: 1, points: 180, skins: 7, name: "Bo" },
        { golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" },
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Season standings" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([expect.stringContaining("Bo"), expect.stringContaining("Ann")]);
  });

  it("links each ledger row's name to /golfers/:golferId", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [{ golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" }],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Season standings" });
    const annLink = within(table).getByRole("link", { name: "Ann" });
    expect(annLink.getAttribute("href")).toBe(`/golfers/${ANN}`);
  });

  it("never renders a guest label for any ledger row", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [
        { golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" },
        { golferId: BO, rounds: 10, wins: 6, losses: 3, halves: 1, points: 180, skins: 7, name: "Bo" },
      ],
    });

    renderPanel();

    await screen.findByRole("table", { name: "Season standings" });
    expect(screen.queryByText(/guest/i)).toBeNull();
  });

  it("renders a tied head-to-head as a leader-first sentence — 'Ann and Bo are tied 5–5 · 2 halved'", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [
        { golferId: ANN, rounds: 12, wins: 5, losses: 5, halves: 2, points: 0, skins: 0, name: "Ann" },
        { golferId: BO, rounds: 12, wins: 5, losses: 5, halves: 2, points: 0, skins: 0, name: "Bo" },
      ],
      headToHead: [{ a: ANN, b: BO, aWins: 5, bWins: 5, halves: 2 }],
    });

    renderPanel();

    // Names are GolferLinks now (the link sweep, task 6) — RTL's getByText can't bridge a
    // nested <a>, so the sentence is read via the <li>'s own native textContent.
    const list = await screen.findByRole("list", { name: "Head to head" });
    const item = within(list).getByRole("listitem");
    expect(item.textContent).toBe("Ann and Bo are tied 5–5 · 2 halved");
    expect(within(item).getByRole("link", { name: "Ann" }).getAttribute("href")).toBe(`/golfers/${ANN}`);
    expect(within(item).getByRole("link", { name: "Bo" }).getAttribute("href")).toBe(`/golfers/${BO}`);
  });

  it("renders a leading head-to-head as a leader-first sentence, regardless of raw a/b order — 'Bo leads Ann 5–4'", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [
        { golferId: ANN, rounds: 9, wins: 4, losses: 5, halves: 0, points: 0, skins: 0, name: "Ann" },
        { golferId: BO, rounds: 9, wins: 5, losses: 4, halves: 0, points: 0, skins: 0, name: "Bo" },
      ],
      headToHead: [{ a: ANN, b: BO, aWins: 4, bWins: 5, halves: 0 }],
    });

    renderPanel();

    const list = await screen.findByRole("list", { name: "Head to head" });
    const item = within(list).getByRole("listitem");
    expect(item.textContent).toBe("Bo leads Ann 5–4");
  });

  it("names the games in the column headers and footnote — no bare 'Points'/'W-L-H'", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [{ golferId: ANN, rounds: 10, wins: 5, losses: 4, halves: 1, points: 210, skins: 3, name: "Ann" }],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Season standings" });
    const headers = within(table).getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["Member", "Rounds", "Matches (W–L–H)", "Stableford pts", "Skins"]);
    expect(screen.getByText("From this season's shared rounds — match results, Stableford points, and skins for current members.")).toBeTruthy();
  });

  it("zero shared rounds: shows the automatic build-up explainer, not an empty table", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel();

    expect(await screen.findByText("Standings build automatically once members play together.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Season standings" })).toBeNull();
  });

  it("shared rounds exist but an empty ledger (departed members, or no games at all): tells the truth instead of the build-up copy", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000 }],
    });

    renderPanel();

    expect(await screen.findByText("No standings from these rounds yet — standings build from games between current members.")).toBeTruthy();
    expect(screen.queryByText("Standings build automatically once members play together.")).toBeNull();
    expect(screen.queryByRole("table", { name: "Season standings" })).toBeNull();
  });

  it("empty ledger: the season-standings footnote does not render (nothing to gloss)", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel();

    await screen.findByText("Standings build automatically once members play together.");
    expect(screen.queryByText("From this season's shared rounds — match results, Stableford points, and skins for current members.")).toBeNull();
  });

  it("renders partners from a fixture; zero halves omits the suffix", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [{ golferId: ANN, rounds: 3, wins: 1, losses: 0, halves: 0, points: 20, skins: 0, name: "Ann" }],
      partners: [{ a: ANN, b: BO, nameA: "Ann", nameB: "Bo", wins: 1, losses: 0, halves: 0 }],
    });

    renderPanel();

    expect(await screen.findByRole("heading", { name: "Partners — four-ball" })).toBeTruthy();
    expect(screen.getByText("Ann & Bo — 1–0")).toBeTruthy();
  });

  it("empty partners renders NOTHING — no empty-state heading", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      ledger: [{ golferId: ANN, rounds: 3, wins: 1, losses: 0, halves: 0, points: 20, skins: 0, name: "Ann" }],
    });

    renderPanel();

    await screen.findByRole("table", { name: "Season standings" });
    expect(screen.queryByRole("heading", { name: "Partners — four-ball" })).toBeNull();
  });
});

describe("SeasonPanel — played together", () => {
  it("rounds link to /rounds/<id>; no Remove affordance anywhere (a shared round is derived, never appended)", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      rounds: [
        { roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000 },
        { roundId: roundId("round-2"), finalizedAt: 1_700_100_000_000 },
      ],
    });

    renderPanel();

    const list = await screen.findByRole("list", { name: "Played together" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(list).queryByRole("button", { name: /remove/i })).toBeNull();

    const first = items.find((li) => within(li).getByRole("link").getAttribute("href") === "/rounds/round-1")!;
    fireEvent.click(within(first).getByRole("link"));
    expect(await screen.findByTestId("archive-probe")).toBeTruthy();
  });

  it("no shared rounds: the empty state is honest", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel();

    expect(await screen.findByText("No rounds played together yet.")).toBeTruthy();
  });
});

// close-season spec 2026-07-21 §2: the organizer's verb, the badge, and the closed door — an
// open season gives the organizer Close (behind a confirm carrying the crew-scoreboard spec's own
// updated teaching line), a closed season shows the badge + Reopen (no confirm — spec §1.3,
// "first-class, not an apology"), and a non-organizer sees the badge alone either way.
describe("SeasonPanel — close/reopen season", () => {
  it("organizer + open season: Close season renders (no badge); confirming shows the EXACT teaching line", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel(true);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).queryByText(/closed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close season" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirm close season" });
    expect(within(dialog).getByText("Closing ends the season — rounds finalized after this stay out of it, and its titles are awarded. You can reopen it later.")).toBeTruthy();
  });

  it("confirming Close POSTs close and refreshes standings through the existing reload path (api-then-refetch)", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetSeasonStandings.mockResolvedValueOnce(baseStandings).mockResolvedValueOnce({ ...baseStandings, status: "closed", closedAtMs: Date.UTC(2026, 5, 15) });
    mockedCloseSeason.mockResolvedValue({ season: { seasonId: "season-1", name: "2026", status: "closed", createdAtMs: 1, startsAtMs: 1, closedAtMs: 2 } });

    renderPanel(true);

    fireEvent.click(await screen.findByRole("button", { name: "Close season" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm close season" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mockedCloseSeason).toHaveBeenCalledWith(idToken, CREW, "season-1"));
    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("organizer + closed season: badge + Reopen render", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, status: "closed", closedAtMs: Date.UTC(2026, 5, 15) });

    renderPanel(true);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).getByText(/closed/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close season" })).toBeNull();
  });

  it("tapping Reopen POSTs reopen with no confirm step, and refreshes standings", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    const closedSeason = { ...baseStandings, status: "closed" as const, closedAtMs: Date.UTC(2026, 5, 15) };
    mockedGetSeasonStandings.mockResolvedValueOnce(closedSeason).mockResolvedValueOnce(baseStandings);
    mockedReopenSeason.mockResolvedValue({ season: { seasonId: "season-1", name: "2026", status: "open", createdAtMs: 1, startsAtMs: 1 } });

    renderPanel(true);

    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    await waitFor(() => expect(mockedReopenSeason).toHaveBeenCalledWith(idToken, CREW, "season-1"));
    await waitFor(() => expect(mockedGetSeasonStandings).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Close season" })).toBeTruthy();
  });

  it("non-organizer + closed season: badge only, no Close/Reopen verb anywhere", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, status: "closed", closedAtMs: Date.UTC(2026, 5, 15) });

    renderPanel(false);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).getByText(/closed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close season" })).toBeNull();
  });

  it("non-organizer + open season: no Close verb, no badge", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel(false);

    const heading = await screen.findByRole("heading", { level: 3 });
    expect(within(heading).queryByText(/closed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Close season" })).toBeNull();
  });

  it("a close failure renders the honest fallback line, never raw error text", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);
    mockedCloseSeason.mockRejectedValue(new ApiError("season-already-closed", 409, "season season-1 of crew crew-1 is already closed"));

    renderPanel(true);

    fireEvent.click(await screen.findByRole("button", { name: "Close season" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm close season" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not update the season — try again.");
    expect(document.body.textContent).not.toMatch(/season season-1 of crew crew-1/);
  });

  it("a reopen failure renders the honest fallback line, never raw error text", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, status: "closed", closedAtMs: Date.UTC(2026, 5, 15) });
    mockedReopenSeason.mockRejectedValue(new ApiError("season-not-closed", 409, "season season-1 of crew crew-1 is not closed"));

    renderPanel(true);

    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not update the season — try again.");
    expect(document.body.textContent).not.toMatch(/season season-1 of crew crew-1/);
  });
});
