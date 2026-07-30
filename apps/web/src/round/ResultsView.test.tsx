import type { ReactElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cellKey,
  roundStrokeAllocation,
  deviceId,
  fieldDeck18,
  fixtureLinks18,
  fixtureWhite18,
  gameId,
  golferId,
  opId,
  playGoldenRoundLog,
  reduceRound,
  roundId,
  scoreGame,
  settleRound,
} from "@swng/domain";
import type { CourseCard, GameConfig, RoundState, ScoreCell } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { describeGame } from "../games/describeGame";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { ResultsView } from "./ResultsView";

// ResultsView renders a plain-names roster (the claim affordance it once hosted is deleted with
// the whole ghost/claim flow, accounts-only identity spec §3). The AuthProvider wrapper stays so
// the signed-in proof-of-negative at the foot of this file can prove no claim button renders even
// in the state that used to show one. Names are GolferLinks now (the link sweep, task 6) — every
// render needs a Router ancestor too.
const render = (ui: ReactElement) =>
  rtlRender(
    <MemoryRouter>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  );

// The handicapping list's own rows, as plain text (GolferLink + literal suffix concatenated) —
// scoped by the list's own aria-label since RTL's getByText can't bridge a nested <a> boundary,
// but a located element's native .textContent always can (this codebase's own established idiom
// for asserting rendered text that spans a link, e.g. SetupPanel's roster-row assertions).
const handicappingTexts = (): readonly (string | null)[] => within(screen.getByRole("list", { name: "Posted to handicaps" })).getAllByRole("listitem").map((li) => li.textContent);

afterEach(() => cleanup());

describe("ResultsView — the agreement assertion (brief-mandated)", () => {
  const { players, fourball, skins, scores, corrections } = fieldDeck18;

  // A full, finalized log for the M5 field deck — the same fixture fieldDeck18.test.ts pins
  // fourballFinal/skinsFinal against.
  const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
  const state = reduceRound(events);
  const localGames = state.games.map((config) => scoreGame(config, state));

  // The faked API response: literally what settleRound produces for this SAME log — not a
  // hand-invented payload, so it genuinely CAN disagree with localGames if either side has a
  // bug (the brief's own framing: "same domain, same log; a mismatch is a real bug").
  const archive = settleRound(events);
  const response: FinalizeRoundResponse = { results: archive.results, handicapping: archive.handicapping };

  it("round is genuinely final and every game resolved — sanity, not the assertion itself", () => {
    expect(state.status).toBe("final");
    expect(response.results).toHaveLength(2);
  });

  it("the response's per-game results field-for-field match local games() for the same games", () => {
    const fourballResult = response.results.find((r) => r.id === fourball.id);
    const fourballLocal = localGames.find((g) => g.id === fourball.id);
    expect(fourballResult).toMatchObject({ kind: "fourball-match", outcome: { winner: "a", closing: "1 up" } });
    expect(fourballLocal).toMatchObject({ outcome: { winner: "a", closing: "1 up" } });
    expect(fourballResult?.kind === "fourball-match" && fourballLocal?.kind === "fourball-match" && fourballLocal.outcome).toEqual(
      fourballResult?.kind === "fourball-match" ? fourballResult.outcome : undefined,
    );

    const skinsResult = response.results.find((r) => r.id === skins.id);
    const skinsLocal = localGames.find((g) => g.id === skins.id);
    // resultOf's `won` is every configured player (including 0-skin ones), same shape/order as
    // GameState's own `lines` — not filtered to winners only.
    expect(skinsResult?.kind === "skins" ? skinsResult.won : undefined).toEqual(skinsLocal?.kind === "skins" ? skinsLocal.lines : undefined);
    expect(skinsResult?.kind === "skins" ? skinsResult.carriedOut : undefined).toBe(skinsLocal?.kind === "skins" ? skinsLocal.carriedOut : undefined);
  });

  it("ResultsView renders exactly what describeGame(games()...) renders locally — the brief's literal check", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);

    for (const game of localGames) {
      const { line } = describeGame(game, state);
      expect(screen.getByText(line)).toBeTruthy();
    }
    // Matches the brief's own literal target strings for this exact fixture.
    expect(screen.getByText("Ann & Bo win 1 up")).toBeTruthy();
    expect(screen.getByText("Bo 5 · Dee 10 · 3 carried out")).toBeTruthy();
  });

  it("handicapping rows render the server's response verbatim — no local recomputation when a response exists", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);
    const texts = handicappingTexts();
    for (const row of response.handicapping) {
      if (row.kind !== "complete") continue;
      const name = state.participants.find((p) => p.golferId === row.golferId)!.name;
      expect(texts).toContain(`${name} — adjusted score ${row.ags} · posts ${row.differential.toFixed(1)}`);
    }
  });

  // The link sweep (navigation spec, task 6): every rendered noun's name is its address — both
  // the roster and the handicapping list's own names link to /golfers/:golferId.
  it("the link sweep: roster and handicapping-row names link to /golfers/:golferId", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);

    const ann = players[0]!;
    const rosterList = screen.getByRole("list", { name: "Roster" });
    const rosterLink = within(rosterList).getByRole("link", { name: ann.name });
    expect(rosterLink.getAttribute("href")).toBe(`/golfers/${ann.golferId}`);

    const handicapList = screen.getByRole("list", { name: "Posted to handicaps" });
    const handicapLink = within(handicapList).getByRole("link", { name: ann.name });
    expect(handicapLink.getAttribute("href")).toBe(`/golfers/${ann.golferId}`);
  });

  it("the archived card reuses ScorecardGrid, read-only — a cell tap is inert", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole 1` });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  // The standard card (spec 2026-07-19 §2a: the card never changes) — StandingsHeader's chips
  // still switch which game's OWN standings/strokes panel is active, but the grid underneath
  // is chip-independent: its dots are always the golfer's own ROUND strokes, never a game's.
  it("StandingsHeader chips do NOT change the grid — dots are the round's strokes, chip-independent", () => {
    const annId = players[0]!.golferId;
    // An independent oracle (domain's own roundStrokeAllocation, not the component under
    // test) for Ann's per-hole standard-card dots.
    const chDots = roundStrokeAllocation(state.participants, state.card).get(annId)!;
    const hole = [...chDots.keys()].find((h) => (chDots.get(h) ?? 0) > 0);
    expect(hole).toBeDefined();

    render(<ResultsView state={state} games={localGames} response={response} />);
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole ${hole}` });
    const beforeTap = cell.querySelector('span[aria-hidden]')?.textContent;
    expect(beforeTap).toBe("●".repeat(chDots.get(hole!)!));

    fireEvent.click(screen.getByRole("button", { name: /skins/i }));

    // The chip tap only expands/collapses that game's own panel (StandingsHeader's own test
    // suite covers that) — the grid's dots are unaffected either way.
    expect(cell.querySelector('span[aria-hidden]')?.textContent).toBe(beforeTap);
  });
});

// M9 Task 3 (share): shareToken is OPTIONAL and additive — absent by default (every describe
// block above never passes it and still passes unchanged), present only when the caller (i.e.
// RoundPage, never WatchPage's own spectator reuse of this component) has a real participant
// token to mint a link with.
describe("ResultsView — share affordance (M9 Task 3)", () => {
  const { players, fourball, skins, scores, corrections } = fieldDeck18;
  const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
  const state = reduceRound(events);
  const localGames = state.games.map((config) => scoreGame(config, state));

  it("renders no 'Share round' button when shareToken is omitted (the WatchPage/spectator shape)", () => {
    render(<ResultsView state={state} games={localGames} response={undefined} />);
    expect(screen.queryByRole("button", { name: "Share round" })).toBeNull();
  });

  it("renders 'Share round' when shareToken is provided (RoundPage's own archived-card shape)", () => {
    render(<ResultsView state={state} games={localGames} response={undefined} shareToken="participant-token" />);
    expect(screen.getByRole("button", { name: "Share round" })).toBeTruthy();
  });
});

describe("ResultsView — no response (WS-pushed final, brief's other tab)", () => {
  it("derives handicapping locally, matching settleRound's own numbers for the identical log", () => {
    const { players, fourball, skins, scores, corrections } = fieldDeck18;
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
    const state = reduceRound(events);
    const localGames = state.games.map((config) => scoreGame(config, state));
    const archive = settleRound(events); // the true source — this tab never called finalize, only settleRound did (server-side)

    render(<ResultsView state={state} games={localGames} response={undefined} />);

    const texts = handicappingTexts();
    for (const row of archive.handicapping) {
      const name = state.participants.find((p) => p.golferId === row.golferId)!.name;
      if (row.kind === "complete") {
        expect(texts).toContain(`${name} — adjusted score ${row.ags} · posts ${row.differential.toFixed(1)}`);
      } else {
        expect(texts).toContain(`${name} — card incomplete, nothing posted`);
      }
    }
  });

  it("still renders per-game results (from local games() alone) and the read-only card", () => {
    const { players, fourball, skins, scores, corrections } = fieldDeck18;
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
    const state = reduceRound(events);
    const localGames = state.games.map((config) => scoreGame(config, state));

    render(<ResultsView state={state} games={localGames} response={undefined} />);

    expect(screen.getByText("Ann & Bo win 1 up")).toBeTruthy();
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole 1` });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  // spec 2026-07-19 §2b: there is no more "default active game" — chips are pure disclosure
  // toggles that all start collapsed. A terminated game's chip still renders (with its own
  // Ended badge) right alongside a live one, and both are equally tappable to view.
  it("a terminated game's chip renders alongside a resolved one — both collapsed, no default selection", () => {
    const ann = golferId("ann");
    const bo = golferId("bo");
    const terminatedConfig: GameConfig = { kind: "singles-match", id: gameId("terminated-1"), a: ann, b: bo };
    const resolvedConfig: GameConfig = { kind: "stableford", id: gameId("resolved-1"), players: [ann, bo] };
    const state: RoundState = {
      id: roundId("r-archive-term"),
      status: "final",
      card: fixtureLinks18,
      participants: [
        { golferId: ann, name: "Ann", tee: "white", basis: { kind: "strokes", strokes: 8 }, strokes: 8 },
        { golferId: bo, name: "Bo", tee: "white", basis: { kind: "strokes", strokes: 2 }, strokes: 2 },
      ],
      games: [terminatedConfig, resolvedConfig],
      cells: {},
      terminatedGameIds: new Set([terminatedConfig.id]),
    };
    const games = [scoreGame(terminatedConfig, state), scoreGame(resolvedConfig, state)];

    render(<ResultsView state={state} games={games} response={undefined} />);

    const stablefordChip = screen.getByRole("button", { name: /Stableford/ });
    const matchChip = screen.getByRole("button", { name: /Match play/ });
    expect(stablefordChip.getAttribute("aria-expanded")).toBe("false");
    expect(matchChip.getAttribute("aria-expanded")).toBe("false");
    expect(matchChip.textContent).toMatch(/Ended/i);
    expect(screen.queryByRole("region")).toBeNull(); // nothing expanded by default
  });

  it("a golfer with an undecided card (a pickup mid-round, no finalize response) shows 'incomplete', not a crash", () => {
    // A tiny hand-built round: one participant, one hole recorded, never finished — the round
    // is marked final anyway (mirrors the WS-push scenario: this tab just observes status).
    const ann = golferId("ann");
    const cellValue: ScoreCell = { result: { kind: "strokes", strokes: 5 }, recordedBy: ann, hlc: { wallMs: 1, counter: 0, deviceId: deviceId("d") }, opId: opId("op-1") };
    const state: RoundState = {
      id: roundId("r1"),
      status: "final",
      card: fixtureLinks18,
      participants: [{ golferId: ann, name: "Ann", tee: "white", basis: { kind: "strokes", strokes: 8 }, strokes: 8 }],
      games: [],
      cells: { [cellKey(ann, 1)]: cellValue },
      terminatedGameIds: new Set(),
    };

    render(<ResultsView state={state} games={[]} response={undefined} />);
    expect(handicappingTexts()).toContain("Ann — card incomplete, nothing posted");
  });
});

// unrated-courses arc: a round played on an unrated tee (no rating/slope) is fully scored and
// has an AGS, but no differential to post to a handicap. Its handicapping row is a THIRD kind,
// "unrated" — it must render its AGS and say it isn't posted, NEVER collapse into "incomplete"
// (which means an undecided card, a different thing entirely).
describe("ResultsView — unrated handicapping row", () => {
  const ann = golferId("ann");

  // An unrated 18-hole tee (fixtureWhite18's holes, with rating/slope stripped), fully scored at
  // par by Ann — so adjustedGrossScore holds (the card is decided) but scoreDifferential is never
  // reached (isRated is false). handicappingFor returns { kind: "unrated", ags }.
  const unratedCard: CourseCard = { courseName: "Unrated GC", teeSets: [{ name: "white", holes: fixtureWhite18.holes }] };
  const fullyScoredCells = (): Record<string, ScoreCell> => {
    const cells: Record<string, ScoreCell> = {};
    for (const hole of fixtureWhite18.holes) {
      cells[cellKey(ann, hole.number)] = {
        result: { kind: "strokes", strokes: hole.par },
        recordedBy: ann,
        hlc: { wallMs: hole.number, counter: 0, deviceId: deviceId("d") },
        opId: opId(`op-${hole.number}`),
      };
    }
    return cells;
  };
  const unratedState = (): RoundState => ({
    id: roundId("r-unrated"),
    status: "final",
    card: unratedCard,
    participants: [{ golferId: ann, name: "Ann", tee: "white", basis: { kind: "strokes", strokes: 8 }, strokes: 8 }],
    games: [],
    cells: fullyScoredCells(),
    terminatedGameIds: new Set(),
  });

  it("derives an unrated row (no response) → renders its AGS and 'unrated (not posted)', not 'incomplete'", () => {
    render(<ResultsView state={unratedState()} games={[]} response={undefined} />);

    // par-72 card, all pars, no net-double-bogey adjustment → AGS 72.
    expect(handicappingTexts()).toContain("Ann — adjusted score 72 · unrated course, not posted");
    expect(screen.queryByText(/card incomplete/)).toBeNull();
  });

  it("renders a server response's own unrated row verbatim (the finalize-tab path)", () => {
    const response: FinalizeRoundResponse = { results: [], handicapping: [{ golferId: ann, kind: "unrated", ags: 84 }] };
    render(<ResultsView state={unratedState()} games={[]} response={response} />);

    expect(handicappingTexts()).toContain("Ann — adjusted score 84 · unrated course, not posted");
    expect(screen.queryByText(/card incomplete/)).toBeNull();
  });
});

// The wall (accounts-only identity spec §3): there are no ghosts, so there is nothing to claim —
// the "This is me" affordance is deleted. The finalized roster is a plain names list, and no
// claim button renders in ANY auth state, including the signed-in one that used to show it.
describe("ResultsView — no claim affordance (accounts-only)", () => {
  const ann = golferId("ann");
  const bo = golferId("bo");

  const finalState = (): RoundState => ({
    id: roundId("r-claim"),
    status: "final",
    card: fixtureLinks18,
    participants: [
      { golferId: ann, name: "Ann", tee: "white", basis: { kind: "strokes", strokes: 8 }, strokes: 8 },
      { golferId: bo, name: "Bo", tee: "white", basis: { kind: "strokes", strokes: 2 }, strokes: 2 },
    ],
    games: [],
    cells: {},
    terminatedGameIds: new Set(),
  });

  const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  const base64url = (obj: unknown): string =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const signIn = () => {
    const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
    tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
  };

  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    vi.stubGlobal("sessionStorage", createMemoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("not signed in: the finalized roster renders names, with no claim affordance", () => {
    render(<ResultsView state={finalState()} games={[]} response={undefined} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows.find((li) => /Ann/.test(li.textContent ?? ""))).toBeTruthy();
    expect(rows.find((li) => /Bo/.test(li.textContent ?? ""))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });

  it("signed in: still a plain names roster — no 'This is me' anywhere (proof-of-negative)", async () => {
    signIn();
    const fetchMock = vi.fn(async () => fakeResponse(200, { golfer: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ResultsView state={finalState()} games={[]} response={undefined} />);

    // Let the AuthProvider's GET /me settle so a claim button, if any survived, would have shown.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });
});
