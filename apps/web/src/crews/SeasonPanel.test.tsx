import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  getMe: vi.fn(),
  updateSeason: vi.fn(),
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

import { getMe, getSeasonStandings, updateSeason } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { SeasonPanel } from "./SeasonPanel";

const mockedGetSeasonStandings = vi.mocked(getSeasonStandings);
const mockedGetMe = vi.mocked(getMe);
const mockedUpdateSeason = vi.mocked(updateSeason);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetSeasonStandings.mockReset();
  mockedGetMe.mockReset();
  mockedUpdateSeason.mockReset();
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
// `startsAt`) never needs re-stating. `scoreboard`/`rounds`/`ledger`/`headToHead`/`partners`
// all default empty — no `superlatives` (crew-scoreboard spec §3c: superseded, gone from the
// wire), no `appendedBy` on rounds (a shared round is DERIVED, nobody appended it). No `status`
// (spec 2026-07-22 §1: time is the season's only lifecycle, never a stored/served flag).
const baseStandings: SeasonStandingsResponse = {
  seasonId: "season-1",
  name: "2026",
  startsAt: "2026-01-01",
  endsAt: "2026-12-31",
  scoreboard: [],
  rounds: [],
  ledger: [],
  headToHead: [],
  partners: [],
};

// Renders SeasonPanel directly (not through CrewPage) — CrewPage.test.tsx only pins that
// selecting a season wires the right crewId/seasonId/isOrganizer through; SeasonPanel's own full
// behavior (scoreboard, standings, head-to-head, played-together, season editing) is pinned here
// in isolation. `isOrganizer` defaults false — the season-edit describe block below opts in.
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
  mockedGetMe.mockResolvedValue({ golfer: { golferId: ANN, name: "Ann" } });
};

describe("SeasonPanel — window header", () => {
  // Spec 2026-07-22 "the season is the record" §1/§5: both dates are REQUIRED and always
  // visible now — no more "Since {start}" open-ended reading, no closed badge (there is no
  // `status` left to render one from).
  it("always names both ends of the window, from the date strings verbatim", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, startsAt: "2026-01-01", endsAt: "2026-06-15" });

    renderPanel();

    expect(await screen.findByText("Jan 1 – Jun 15, 2026")).toBeTruthy();
  });

  // Spec §5's "wide dates" all-time case (the feature the spec's own "Want an all-time board?
  // Give it wide dates." line makes first-class): a single trailing year would be ambiguous
  // across a cross-year window, so both ends carry their own year — the index-chart's own
  // cross-year idiom (2026-07-21-index-chart-polish-design.md).
  it("a cross-year window names the year on both ends", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, startsAt: "2020-01-01", endsAt: "2030-12-31" });

    renderPanel();

    expect(await screen.findByText("Jan 1, 2020 – Dec 31, 2030")).toBeTruthy();
  });

  it("a standings load failure renders an honest quiet message, never a thrown render", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockRejectedValue(new Error("network down"));

    renderPanel();

    expect(await screen.findByText(/could not load this season/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});

// Spec 2026-07-22 §1/§5 (Spec §7's own test plan): Live vs. Final is derived, never stored — a
// date-string compare against today's UTC date, frozen here so it's assertable (an inline
// `new Date()` can't be pinned otherwise).
describe("SeasonPanel — Live/Final marker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("today's UTC date past endsAt: renders a Final marker", async () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, startsAt: "2026-01-01", endsAt: "2026-12-31" });

    renderPanel();

    expect(await screen.findByText("Jan 1 – Dec 31, 2026")).toBeTruthy();
    expect(screen.getByText("Final")).toBeTruthy();
  });

  it("today's UTC date on or before endsAt: no marker", async () => {
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, startsAt: "2026-01-01", endsAt: "2026-12-31" });

    renderPanel();

    expect(await screen.findByText("Jan 1 – Dec 31, 2026")).toBeTruthy();
    expect(screen.queryByText("Final")).toBeNull();
  });
});

// Spec 2026-07-22 §2: editing the end date IS the whole lifecycle — an organizer-only Edit swaps
// the header for name + two date inputs + Save/Cancel.
describe("SeasonPanel — season edit", () => {
  it("a non-organizer sees no Edit button", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel(false);

    await screen.findByText("2026");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("the organizer sees an Edit button; tapping it swaps the header for an editable form prefilled from the current season", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" });

    renderPanel(true);
    await screen.findByText("2026");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect((screen.getByLabelText("Season name") as HTMLInputElement).value).toBe("2026");
    expect((screen.getByLabelText("Season starts") as HTMLInputElement).value).toBe("2026-01-01");
    expect((screen.getByLabelText("Season ends") as HTMLInputElement).value).toBe("2026-12-31");
  });

  it("Save PUTs the edited name/dates and reloads standings from the server", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValueOnce({ ...baseStandings, name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" });
    mockedUpdateSeason.mockResolvedValue({
      season: { seasonId: "season-1", name: "2026", createdAtMs: 1_700_000_000_000, startsAt: "2026-01-01", endsAt: "2050-06-30" },
    });
    mockedGetSeasonStandings.mockResolvedValueOnce({ ...baseStandings, name: "2026", startsAt: "2026-01-01", endsAt: "2050-06-30" });

    renderPanel(true);
    await screen.findByText("2026");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Season ends"), { target: { value: "2050-06-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mockedUpdateSeason).toHaveBeenCalledWith(expect.any(String), CREW, "season-1", { name: "2026", startsAt: "2026-01-01", endsAt: "2050-06-30" });
    expect(await screen.findByText("Jan 1, 2026 – Jun 30, 2050")).toBeTruthy();
    expect(screen.queryByLabelText("Season name")).toBeNull();
  });

  it("Cancel discards the edit without calling updateSeason", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" });

    renderPanel(true);
    await screen.findByText("2026");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Season name"), { target: { value: "Nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Season name")).toBeNull();
    expect(screen.getByText("2026")).toBeTruthy();
    expect(mockedUpdateSeason).not.toHaveBeenCalled();
  });

  it("an invalid-season-window failure shows honest copy, never the raw server text", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, name: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" });
    mockedUpdateSeason.mockRejectedValue(new Error("startsAt must be on or before endsAt"));

    renderPanel(true);
    await screen.findByText("2026");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not update this season/i);
    expect(document.body.textContent).not.toMatch(/startsAt must be on or before endsAt/);
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
        { golferId: BO, name: "Bo", rounds: 4, average: 26, spread: 4.2, best18: { gross: 82, toPar: 10 } },
        { golferId: ANN, name: "Ann", rounds: 2 },
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const rows = within(table).getAllByRole("row").slice(1); // drop the header row
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([expect.stringContaining("Bo"), expect.stringContaining("Ann")]);
  });

  it("links each scoreboard row's name to /golfers/:golferId", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 3 }] });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const link = within(table).getByRole("link", { name: "Ann" });
    expect(link.getAttribute("href")).toBe(`/golfers/${ANN}`);
  });

  it("every dash arm: rounds present, everything else absent renders — for all four optional cells", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 1 }] });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const row = within(table).getAllByRole("row")[1]!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]!.textContent).toBe("1"); // rounds
    expect(cells[2]!.textContent).toBe("—"); // best18
    expect(cells[3]!.textContent).toBe("—"); // netPer18
    expect(cells[4]!.textContent).toBe("—"); // index
  });

  // Best 18 moved to the LAST column (spec 2026-07-29 §6's own order) — cell index 4.
  it("best18 renders '{gross} ({vs par})' — over and under par both", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, best18: { gross: 82, toPar: 10 } },
        { golferId: BO, name: "Bo", rounds: 5, best18: { gross: 68, toPar: -4 } },
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getAllByRole("cell")[4]!.textContent).toBe("82 (+10)");
    expect(within(rows[1]!).getAllByRole("cell")[4]!.textContent).toBe("68 (-4)");
  });

  // The average is a signed vs-par figure, rendered through formatOverPar (spec 2026-07-29 §4) —
  // over par, under par, and dead level. Column index 2: Golfer · Rounds · Average · Spread · Best 18.
  it("the average renders as a signed vs-par figure — over, under, and even", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, average: 26 },
        { golferId: BO, name: "Bo", rounds: 5, average: -2 },
        { golferId: golferId("cy-g"), name: "Cy", rounds: 5, average: 0 },
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getAllByRole("cell")[2]!.textContent).toBe("+26");
    expect(within(rows[1]!).getAllByRole("cell")[2]!.textContent).toBe("-2"); // under par reads as a plain minus
    expect(within(rows[2]!).getAllByRole("cell")[2]!.textContent).toBe("E");
  });

  // A spread is a MAGNITUDE, never signed: "±4.2" is the whole notation, so it deliberately does
  // NOT go through formatOverPar. Held back below 5 scored rounds (the domain's own floor), where
  // the cell reads "—".
  it("the spread renders as ±N.N, and as a dash when it has not built up", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, average: 26, spread: 4.2 },
        { golferId: BO, name: "Bo", rounds: 3, average: 10 }, // below the 5-round floor
        { golferId: golferId("cy-g"), name: "Cy", rounds: 5, average: 10, spread: 0 }, // a golfer who shoots his number exactly
      ],
    });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getAllByRole("cell")[3]!.textContent).toBe("±4.2");
    expect(within(rows[1]!).getAllByRole("cell")[3]!.textContent).toBe("—");
    expect(within(rows[2]!).getAllByRole("cell")[3]!.textContent).toBe("±0.0");
  });

  it("a member with no scored round shows a dash for both average and spread, with their real round count", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 2 }] });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const cells = within(within(table).getAllByRole("row")[1]!).getAllByRole("cell");
    expect(cells[1]!.textContent).toBe("2"); // the rounds happened...
    expect(cells[2]!.textContent).toBe("—"); // ...but none of them carried a score
    expect(cells[3]!.textContent).toBe("—");
    expect(cells[4]!.textContent).toBe("—");
  });

  it("renders the column headers in spec order: Rounds · Average · Spread · Best 18", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 0 }] });

    renderPanel();

    const table = await screen.findByRole("table", { name: "Standings" });
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["Golfer", "Rounds", "Average", "Spread", "Best 18"]);
  });

  it("renders the table footnote naming Average / Spread / Best 18, including the 5-round floor", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({ ...baseStandings, scoreboard: [{ golferId: ANN, name: "Ann", rounds: 1 }] });

    renderPanel();

    expect(
      await screen.findByText(
        "Average — score minus par over this season's rounds, a nine counting double · Spread — how much those rounds vary; builds at 5 rounds · Best 18 — lowest gross, fully holed out.",
      ),
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

    await screen.findByRole("table", { name: "Standings" });
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

    await screen.findByRole("table", { name: "Standings" });
    expect(screen.queryByText("Rounds appear here automatically when members finalize them.")).toBeNull();
  });
});

// Spec 2026-07-29 §6: comparing two crew-mates who never played together is the difference of
// their season averages — the SAME rule a round applies at join, applied to the board's own
// numbers. One line, the CLOSEST pair by average among members who both have one.
describe("SeasonPanel — head-to-head strokes line", () => {
  it("names the strokes between two members who have both played", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: BO, name: "Ravi", rounds: 9, average: 10 },
        { golferId: ANN, name: "Blaine", rounds: 12, average: 26 },
      ],
    });

    renderPanel();

    expect(await screen.findByText("If you played tomorrow, Blaine gets 16.")).toBeTruthy();
  });

  it("says nothing about a pair where either has no average", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 2 }, // no scored round yet — no average
        { golferId: BO, name: "Bo", rounds: 5, average: 10 },
      ],
    });

    renderPanel();

    await screen.findByRole("table", { name: "Standings" });
    expect(screen.queryByText(/If you played tomorrow/)).toBeNull();
  });

  // Only one member (or zero) ever has an average yet: there is no PAIR to compare, so nothing
  // renders — same as the no-average-on-one-side case above, just the other way a pair fails to
  // exist.
  it("fewer than two members with an average: no line", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [{ golferId: ANN, name: "Ann", rounds: 5, average: 10 }],
    });

    renderPanel();

    await screen.findByRole("table", { name: "Standings" });
    expect(screen.queryByText(/If you played tomorrow/)).toBeNull();
  });

  // Three-plus members: the CLOSEST pair, not the first pair encountered in served order — Ann
  // (0) and Bo (20) are 20 apart; Bo (20) and Cy (22) are only 2 apart, so Cy's line renders and
  // Bo-vs-Ann's 20 does not.
  it("more than two members: names the CLOSEST pair by average, not the first pair encountered", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, average: 0 },
        { golferId: BO, name: "Bo", rounds: 5, average: 20 },
        { golferId: golferId("cy-g"), name: "Cy", rounds: 5, average: 22 },
      ],
    });

    renderPanel();

    expect(await screen.findByText("If you played tomorrow, Cy gets 2.")).toBeTruthy();
    expect(screen.queryByText(/Bo gets 20/)).toBeNull();
  });

  // Decision (task 6 dispatch): a tied closest pair is a real, interesting answer to "what would
  // a match look like" — not suppressed, and not "X gets 0" (a nonsensical sentence once strokes
  // are a non-negative count: a zero-stroke player has never "gotten" anything). Rendered as its
  // own sentence in the same register, naming both golfers and the fact that neither gives
  // strokes — mirroring dots.ts's own "everyone in this game plays level" idiom for the identical
  // zero-strokes case.
  it("the closest pair is tied: names both and says neither gives strokes, rather than suppressing the line or printing zero", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      scoreboard: [
        { golferId: ANN, name: "Ann", rounds: 5, average: 10 },
        { golferId: BO, name: "Bo", rounds: 5, average: 10 },
      ],
    });

    renderPanel();

    expect(await screen.findByText("If you played tomorrow, Ann and Bo play level — nobody gets strokes.")).toBeTruthy();
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

    const table = await screen.findByRole("table", { name: "Games together" });
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

    const table = await screen.findByRole("table", { name: "Games together" });
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

    await screen.findByRole("table", { name: "Games together" });
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

    const table = await screen.findByRole("table", { name: "Games together" });
    const headers = within(table).getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["Member", "Rounds", "Matches (W–L–H)", "Stableford pts", "Skins"]);
    expect(screen.getByText("From this season's shared rounds — match results, Stableford points, and skins for current members.")).toBeTruthy();
  });

  it("zero shared rounds: shows the automatic build-up explainer, not an empty table", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel();

    expect(await screen.findByText("Appears when members play a round together.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Games together" })).toBeNull();
  });

  it("shared rounds exist but an empty ledger (departed members, or no games at all): tells the truth instead of the build-up copy", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, courseName: "Casa Verde GC" }],
    });

    renderPanel();

    expect(await screen.findByText("No games between current members in these rounds yet — matches, points, and skins show up here.")).toBeTruthy();
    expect(screen.queryByText("Appears when members play a round together.")).toBeNull();
    expect(screen.queryByRole("table", { name: "Games together" })).toBeNull();
  });

  it("empty ledger: the season-standings footnote does not render (nothing to gloss)", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel();

    await screen.findByText("Appears when members play a round together.");
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

    await screen.findByRole("table", { name: "Games together" });
    expect(screen.queryByRole("heading", { name: "Partners — four-ball" })).toBeNull();
  });
});

describe("SeasonPanel — played together", () => {
  it("rounds link to /rounds/<id>; no Remove affordance anywhere (a shared round is derived, never appended)", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      rounds: [
        { roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, courseName: "Casa Verde GC" },
        { roundId: roundId("round-2"), finalizedAt: 1_700_100_000_000, courseName: "Casa Verde GC" },
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

  it("Played together renders each round's canonical label (course · date), a whole-row link — never a bare locale date", async () => {
    signInAsAnn();
    const day = Date.UTC(2026, 6, 12, 14, 0);
    mockedGetSeasonStandings.mockResolvedValue({
      ...baseStandings,
      rounds: [
        { roundId: roundId("r-morning"), finalizedAt: day + 1, courseName: "Casa Verde GC", createdAt: Date.UTC(2026, 6, 12, 8, 0) },
        { roundId: roundId("r-afternoon"), finalizedAt: day + 2, courseName: "Casa Verde GC", createdAt: Date.UTC(2026, 6, 12, 15, 0) },
      ],
    });
    renderPanel();
    // The canonical roundLabel — course + date, so each link's accessible name carries the course
    // name (the old toLocaleDateString rendered NONE); links point at /rounds/:id, newest-first.
    const links = await screen.findAllByRole("link", { name: /Casa Verde GC · /i });
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/rounds/r-morning", "/rounds/r-afternoon"]);
    // The bare locale date the section used to show is gone from the section.
    expect(screen.queryByText(new Date(day + 1).toLocaleDateString())).toBeNull();
  });

  it("no shared rounds: the empty state is honest", async () => {
    signInAsAnn();
    mockedGetSeasonStandings.mockResolvedValue(baseStandings);

    renderPanel();

    expect(await screen.findByText("No rounds played together yet.")).toBeTruthy();
  });
});

