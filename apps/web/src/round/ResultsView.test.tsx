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
  gameId,
  golferId,
  opId,
  playGoldenRoundLog,
  reduceRound,
  roundId,
  scoreGame,
  settleRound,
} from "@swng/domain";
import type { GameConfig, RoundState, ScoreCell } from "@swng/domain";
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

// The Final totals list's own rows, as plain text (GolferLink + literal suffix concatenated) —
// scoped by the list's own aria-label since RTL's getByText can't bridge a nested <a> boundary,
// but a located element's native .textContent always can (this codebase's own established idiom
// for asserting rendered text that spans a link, e.g. SetupPanel's roster-row assertions).
const finalTotalsTexts = (): readonly (string | null)[] => within(screen.getByRole("list", { name: "Final totals" })).getAllByRole("listitem").map((li) => li.textContent);

// Independent of ResultsView's own grossForHoles: walks a golden deck's raw scores + corrections
// arrays directly (never cellAt/scoredStrokes/grossForHoles) — a mismatch against what ResultsView
// renders is a real bug in the component, not a restatement of its own arithmetic. Mirrors spec
// §2d exactly: a "picked-up" or never-recorded (null) hole makes the WHOLE round's gross
// undefined, never a silent zero-fill (task-4 fix round 1 — the deck's own Ann/h17 pickup is what
// exercises this for real, not a hand-built corner case).
const expectedGrossOf = (
  scores: Readonly<Record<string, ReadonlyArray<number | "picked-up" | null>>>,
  corrections: readonly { readonly golfer: string; readonly hole: number; readonly score: number | "picked-up" }[],
  golferId: string,
): number | undefined => {
  const raw = [...scores[golferId]!];
  for (const correction of corrections) if (correction.golfer === golferId) raw[correction.hole - 1] = correction.score;
  if (raw.some((entry) => typeof entry !== "number")) return undefined;
  return (raw as number[]).reduce((sum, entry) => sum + entry, 0);
};

// U+2212 restated as its own tiny oracle (not a call into ResultsView's own signedNumber) — this
// codebase's glyph for a negative number, same as SeasonPanel's index delta.
const signedNumber = (n: number): string => (n < 0 ? `−${-n}` : String(n));

// strokes is non-negative by construction (spec §2a) — the exact rendering rule ResultsView's own
// strokesLabel applies, restated here only to build an expected STRING, not to re-derive the
// number itself (gross/strokes both come from independent oracles above/below). An undefined
// gross dashes the whole line — grossForHoles's own "no partial number" rule, not a fallback.
const expectedFinalTotalsLine = (name: string, gross: number | undefined, strokes: number): string =>
  gross === undefined ? `${name} — –` : `${name} — ${gross} gross · ${strokes === 0 ? "0" : `−${strokes}`} · ${signedNumber(gross - strokes)} net`;

afterEach(() => cleanup());

describe("ResultsView — the agreement assertion (brief-mandated)", () => {
  const { players, fourball, skins, scores, corrections, expected } = fieldDeck18;

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
    render(<ResultsView state={state} games={localGames} />);

    for (const game of localGames) {
      const { line } = describeGame(game, state);
      expect(screen.getByText(line)).toBeTruthy();
    }
    // Matches the brief's own literal target strings for this exact fixture.
    expect(screen.getByText("Ann & Bo win 1 up")).toBeTruthy();
    expect(screen.getByText("Bo 5 · Dee 10 · 3 carried out")).toBeTruthy();
  });

  it("the Final totals list totals each player's whole round — gross, the deck's own strokes, and net", () => {
    render(<ResultsView state={state} games={localGames} />);
    const texts = finalTotalsTexts();
    for (const p of players) {
      const gross = expectedGrossOf(scores, corrections, p.golferId);
      const strokes = expected.strokes[p.golferId]!;
      expect(texts).toContain(expectedFinalTotalsLine(p.name, gross, strokes));
    }
  });

  // The link sweep (navigation spec, task 6): every rendered noun's name is its address — both
  // the roster and the Final-totals list's own names link to /golfers/:golferId.
  it("the link sweep: roster and Final-totals-row names link to /golfers/:golferId", () => {
    render(<ResultsView state={state} games={localGames} />);

    const ann = players[0]!;
    const rosterList = screen.getByRole("list", { name: "Roster" });
    const rosterLink = within(rosterList).getByRole("link", { name: ann.name });
    expect(rosterLink.getAttribute("href")).toBe(`/golfers/${ann.golferId}`);

    const totalsList = screen.getByRole("list", { name: "Final totals" });
    const totalsLink = within(totalsList).getByRole("link", { name: ann.name });
    expect(totalsLink.getAttribute("href")).toBe(`/golfers/${ann.golferId}`);
  });

  it("the archived card reuses ScorecardGrid, read-only — a cell tap is inert", () => {
    render(<ResultsView state={state} games={localGames} />);
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

    render(<ResultsView state={state} games={localGames} />);
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
    render(<ResultsView state={state} games={localGames} />);
    expect(screen.queryByRole("button", { name: "Share round" })).toBeNull();
  });

  it("renders 'Share round' when shareToken is provided (RoundPage's own archived-card shape)", () => {
    render(<ResultsView state={state} games={localGames} shareToken="participant-token" />);
    expect(screen.getByRole("button", { name: "Share round" })).toBeTruthy();
  });
});

// The ResultsViewProps.response field this describe block was originally named for is deleted
// (review fix, task-4 fix round 1: it was unused dead weight in the interface, kept alive by
// nothing but a comment) — every render here already IS the WS-pushed-final scenario the title
// described, since ResultsView now computes everything off `state` alone regardless of which tab
// called finalizeRound.
describe("ResultsView — WS-pushed final (this tab never called finalizeRound itself)", () => {
  it("renders the Final totals list correctly from state alone", () => {
    const { players, fourball, skins, scores, corrections, expected } = fieldDeck18;
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
    const state = reduceRound(events);
    const localGames = state.games.map((config) => scoreGame(config, state));

    render(<ResultsView state={state} games={localGames} />);

    const texts = finalTotalsTexts();
    for (const p of players) {
      const gross = expectedGrossOf(scores, corrections, p.golferId);
      const strokes = expected.strokes[p.golferId]!;
      expect(texts).toContain(expectedFinalTotalsLine(p.name, gross, strokes));
    }
  });

  it("still renders per-game results (from local games() alone) and the read-only card", () => {
    const { players, fourball, skins, scores, corrections } = fieldDeck18;
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
    const state = reduceRound(events);
    const localGames = state.games.map((config) => scoreGame(config, state));

    render(<ResultsView state={state} games={localGames} />);

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

    render(<ResultsView state={state} games={games} />);

    const stablefordChip = screen.getByRole("button", { name: /Stableford/ });
    const matchChip = screen.getByRole("button", { name: /Match play/ });
    expect(stablefordChip.getAttribute("aria-expanded")).toBe("false");
    expect(matchChip.getAttribute("aria-expanded")).toBe("false");
    expect(matchChip.textContent).toMatch(/Ended/i);
    expect(screen.queryByRole("region")).toBeNull(); // nothing expanded by default
  });

  // Review fix (task-4 fix round 1): this test used to pin "Ann — 5 gross · −8 · −3 net" for a
  // card with only 1 of 18 holes recorded — a fabricated partial gross and a nonsensical negative
  // net, the exact invented-number dishonesty this arc exists to delete. grossForHoles now
  // correctly reports undefined for any undecided hole, so the whole line dashes instead — no
  // crash, no completeness-gate special case, just spec §2d's own rule applied honestly.
  it("an undecided card (one hole recorded, the rest never played) dashes — no fabricated gross", () => {
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

    render(<ResultsView state={state} games={[]} />);
    expect(finalTotalsTexts()).toContain(expectedFinalTotalsLine("Ann", undefined, 8)); // "Ann — –"
  });

  // The positive case beside the dash above: once every hole IS decided, the line renders real
  // numbers, not a dash — the two tests together pin both arms of grossForHoles' own rule.
  it("a fully-decided card renders real gross/strokes/net", () => {
    const ann = golferId("ann");
    const cells: Record<string, ScoreCell> = {};
    for (const hole of fixtureLinks18.teeSets[0]!.holes) {
      cells[cellKey(ann, hole.number)] = {
        result: { kind: "strokes", strokes: hole.par + 1 }, // a bogey every hole
        recordedBy: ann,
        hlc: { wallMs: hole.number, counter: 0, deviceId: deviceId("d") },
        opId: opId(`op-${hole.number}`),
      };
    }
    const state: RoundState = {
      id: roundId("r-full"),
      status: "final",
      card: fixtureLinks18,
      participants: [{ golferId: ann, name: "Ann", tee: "white", basis: { kind: "strokes", strokes: 9 }, strokes: 9 }],
      games: [],
      cells,
      terminatedGameIds: new Set(),
    };

    render(<ResultsView state={state} games={[]} />);
    // par 72 + 18 (a bogey on every hole) = 90 gross; strokes 9 → net 81.
    expect(finalTotalsTexts()).toContain(expectedFinalTotalsLine("Ann", 90, 9)); // "Ann — 90 gross · −9 · 81 net"
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
    render(<ResultsView state={finalState()} games={[]} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows.find((li) => /Ann/.test(li.textContent ?? ""))).toBeTruthy();
    expect(rows.find((li) => /Bo/.test(li.textContent ?? ""))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });

  it("signed in: still a plain names roster — no 'This is me' anywhere (proof-of-negative)", async () => {
    signIn();
    const fetchMock = vi.fn(async () => fakeResponse(200, { golfer: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ResultsView state={finalState()} games={[]} />);

    // Let the AuthProvider's GET /me settle so a claim button, if any survived, would have shown.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });
});
