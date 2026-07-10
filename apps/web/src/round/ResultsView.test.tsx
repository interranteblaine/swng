import type { ReactElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cellKey,
  deviceId,
  fieldDeck18,
  fixtureLinks18,
  gameId,
  gameStrokeAllocation,
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

// ResultsView now renders a roster with ClaimAffordance too (M7 Task 6 gap 2 — claim survives
// finalize), which calls useAuth() — every render needs an AuthProvider ancestor, same idiom as
// RoundPage.test.tsx and SetupPanel.test.tsx. This shadowing is the only plumbing change; every
// existing call site below keeps its exact shape and assertions.
const render = (ui: ReactElement) => rtlRender(<AuthProvider>{ui}</AuthProvider>);

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
    expect(fourballResult).toMatchObject({ kind: "fourball-match", outcome: { winner: "a", closing: "2&1" } });
    expect(fourballLocal).toMatchObject({ outcome: { winner: "a", closing: "2&1" } });
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
    expect(screen.getByText("Ann & Bo win 2&1")).toBeTruthy();
    expect(screen.getByText("Bo 7 · Dee 8 · 3 carried out")).toBeTruthy();
  });

  it("handicapping rows render the server's response verbatim — no local recomputation when a response exists", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);
    for (const row of response.handicapping) {
      if (row.kind !== "complete") continue;
      const name = state.participants.find((p) => p.golferId === row.golferId)!.name;
      expect(screen.getByText(new RegExp(`${name} — AGS ${row.ags}, differential ${row.differential.toFixed(1)}`))).toBeTruthy();
    }
  });

  it("the archived card reuses ScorecardGrid, read-only — a cell tap is inert", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole 1` });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  it("StandingsHeader chips switch the archived grid's active game — the games[0]-only limitation is gone", () => {
    // An independent oracle (domain's own gameStrokeAllocation, not the component under test)
    // for Ann's per-hole dots under each config — fourball's relative playingHandicap is 7
    // (fieldDeck18's own pinned expectation), skins' is 8, so the SI-8 hole is Ann's cleanest
    // possible fixture: exactly zero dots under fourball, exactly one under skins.
    const annId = players[0]!.golferId;
    const fourballDots = gameStrokeAllocation(fourball, state.participants, state.card).get(annId)!;
    const skinsDots = gameStrokeAllocation(skins, state.participants, state.card).get(annId)!;
    const hole = [...fourballDots.keys()].find((h) => (fourballDots.get(h) ?? 0) === 0 && (skinsDots.get(h) ?? 0) > 0);
    expect(hole).toBeDefined();

    render(<ResultsView state={state} games={localGames} response={response} />);
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole ${hole}` });

    // fourball is games[0] (fieldDeck18's own [fourball, skins] order) — the default active
    // game before any chip tap, same convention as RoundPage's LiveRound.
    expect(cell.querySelector('span[aria-hidden]')).toBeNull(); // 0 dots renders no glyph at all (Cell's own contract)

    fireEvent.click(screen.getByRole("tab", { name: /skins/i }));

    expect(cell.querySelector('span[aria-hidden]')?.textContent).toBe("●".repeat(skinsDots.get(hole!)!));
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

    for (const row of archive.handicapping) {
      const name = state.participants.find((p) => p.golferId === row.golferId)!.name;
      if (row.kind === "complete") {
        expect(screen.getByText(new RegExp(`${name} — AGS ${row.ags}, differential ${row.differential.toFixed(1)}`))).toBeTruthy();
      } else {
        expect(screen.getByText(`${name} — incomplete`)).toBeTruthy();
      }
    }
  });

  it("still renders per-game results (from local games() alone) and the read-only card", () => {
    const { players, fourball, skins, scores, corrections } = fieldDeck18;
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
    const state = reduceRound(events);
    const localGames = state.games.map((config) => scoreGame(config, state));

    render(<ResultsView state={state} games={localGames} response={undefined} />);

    expect(screen.getByText("Ann & Bo win 2&1")).toBeTruthy();
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole 1` });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  // M7 Task 6: terminated games drop out of the default active-game selection here too — the
  // exact same rule as RoundPage's LiveRound (the archive gets the same chip-selected default
  // a live round does, per this file's own M6 Task 5 precedent).
  it("the default active game skips a terminated one, falling through to the next game", () => {
    const ann = golferId("ann");
    const bo = golferId("bo");
    const terminatedConfig: GameConfig = { kind: "singles-match", id: gameId("terminated-1"), a: ann, b: bo };
    const resolvedConfig: GameConfig = { kind: "stableford", id: gameId("resolved-1"), players: [ann, bo] };
    const state: RoundState = {
      id: roundId("r-archive-term"),
      status: "final",
      card: fixtureLinks18,
      participants: [
        { golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 },
        { golferId: bo, name: "Bo", tee: "white", courseHandicap: 2 },
      ],
      games: [terminatedConfig, resolvedConfig], // terminated one FIRST — the erroneous default without the fix
      cells: {},
      terminatedGameIds: new Set([terminatedConfig.id]),
    };
    const games = [scoreGame(terminatedConfig, state), scoreGame(resolvedConfig, state)];

    render(<ResultsView state={state} games={games} response={undefined} />);

    expect(screen.getByRole("tab", { name: /Stableford/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /Singles match/ }).getAttribute("aria-selected")).toBe("false");
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
      participants: [{ golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 }],
      games: [],
      cells: { [cellKey(ann, 1)]: cellValue },
      terminatedGameIds: new Set(),
    };

    render(<ResultsView state={state} games={[]} response={undefined} />);
    expect(screen.getByText("Ann — incomplete")).toBeTruthy();
  });
});

// M7 Task 6, gap 2: a round could previously never be claimed once it finalized (the roster,
// ClaimAffordance's only home, stopped rendering when RoundPage swapped in ResultsView) — which
// killed the "sign in that evening and claim your round" story. ResultsView now renders its own
// roster, additively, alongside the results it already rendered — none of the describe blocks
// above changed behavior or assertions.
describe("ResultsView — claim a ghost after finalize (gap 2)", () => {
  const ann = golferId("ann");
  const bo = golferId("bo");

  const finalState = (): RoundState => ({
    id: roundId("r-claim"),
    status: "final",
    card: fixtureLinks18,
    participants: [
      { golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 },
      { golferId: bo, name: "Bo", tee: "white", courseHandicap: 2 },
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
    tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
  };

  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    vi.stubGlobal("sessionStorage", createMemoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("not signed in: the finalized roster still renders (name only), with no claim affordances at all", () => {
    render(<ResultsView state={finalState()} games={[]} response={undefined} />);

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });

  it("signed in + unlinked: every finalized-roster row is claimable", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: null })),
    );

    render(<ResultsView state={finalState()} games={[]} response={undefined} />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "This is me" })).toHaveLength(2)); // Ann, Bo
  });

  it("This is me -> confirm -> POST /golfers/claim -> success re-fetches /me, even after finalize", async () => {
    signIn();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/golfers/claim") return fakeResponse(200, { golfer: { golferId: "bo", name: "Bo" } });
        if (path === "/me") return fakeResponse(200, { golfer: calls.includes("POST /golfers/claim") ? { golferId: "bo", name: "Bo" } : null });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    render(<ResultsView state={finalState()} games={[]} response={undefined} />);

    const boRow = await waitFor(() => {
      const row = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
      expect(row).toBeTruthy();
      return row!;
    });

    fireEvent.click(within(boRow).getByRole("button", { name: "This is me" }));
    expect(within(boRow).getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(boRow).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(within(boRow).getByRole("status")).toBeTruthy());
    expect(calls).toContain("POST /golfers/claim");
    expect(calls.filter((c) => c === "GET /me").length).toBeGreaterThanOrEqual(2);
  });
});
