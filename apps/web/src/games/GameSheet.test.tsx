import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, gameId, golferId, roundId } from "@swng/domain";
import type { GameConfig, GameState, Participant, RoundState } from "@swng/domain";
import { GameSheet } from "./GameSheet";

const ANN = golferId("ann");
const BO = golferId("bo");
const CY = golferId("cy");
const PAT = golferId("pat");
const ALEX = golferId("alex");

const baseState = (games: readonly GameConfig[], participants: readonly Participant[], overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  participants,
  games,
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

afterEach(() => cleanup());

describe("GameSheet", () => {
  it("stroke play lists EVERY player sorted by total, not just leaders", () => {
    const participants: readonly Participant[] = [
      { golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 },
      { golferId: BO, name: "Bo", tee: "white", courseHandicap: 2 },
      { golferId: CY, name: "Cy", tee: "white", courseHandicap: 12 },
    ];
    const config: GameConfig = { kind: "stroke-play", id: gameId("g1"), scoring: "net", players: [ANN, BO, CY] };
    // Net totals 40/38/44 — Bo (38) leads, but ALL THREE must render, in ascending order.
    // leaders is deliberately just Bo, proving the table doesn't filter to leaders.
    const game: GameState = {
      kind: "stroke-play",
      id: config.id,
      scoring: "net",
      complete: true,
      leaders: [BO],
      lines: [
        { golferId: ANN, thru: 18, gross: { total: 42, pickups: 0 }, net: { total: 40, pickups: 0 }, relativeToPar: 4 },
        { golferId: BO, thru: 18, gross: { total: 40, pickups: 0 }, net: { total: 38, pickups: 0 }, relativeToPar: 2 },
        { golferId: CY, thru: 18, gross: { total: 46, pickups: 0 }, net: { total: 44, pickups: 0 }, relativeToPar: 8 },
      ],
    };
    const state = baseState([config], participants);

    render(<GameSheet game={game} state={state} onClose={vi.fn()} />);

    const rows = screen.getAllByRole("row");
    // rows[0] is the header; the three data rows must read 38, 40, 44 in that order.
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Bo", "38", "18", "(+2)"]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Ann", "40", "18", "(+4)"]);
    expect(within(rows[3]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Cy", "44", "18", "(+8)"]);
  });

  it("stableford leads with the decoder ring", () => {
    const participants: readonly Participant[] = [
      { golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 },
      { golferId: BO, name: "Bo", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "stableford", id: gameId("g2"), players: [ANN, BO] };
    const game: GameState = {
      kind: "stableford",
      id: config.id,
      complete: true,
      leaders: [ANN], // deliberately just Ann — Bo must still render.
      lines: [
        { golferId: ANN, thru: 18, points: 30 },
        { golferId: BO, thru: 18, points: 25 },
      ],
    };
    const state = baseState([config], participants);

    render(<GameSheet game={game} state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Eagle 4 · Birdie 3 · Par 2 · Bogey 1 · worse 0")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Ann", "30", "18"]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Bo", "25", "18"]);
  });

  it("a dormie match is explained in plain words", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "singles-match", id: gameId("m1"), a: PAT, b: ALEX };
    const game: GameState = {
      kind: "singles-match",
      id: config.id,
      up: 2,
      leader: PAT,
      thru: 16,
      remaining: 2,
      dormie: true,
      holes: [],
    };
    const state = baseState([config], participants);

    render(<GameSheet game={game} state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Pat is 2 UP with 2 to play — dormie: Alex must win every remaining hole to tie.")).toBeTruthy();
  });

  it("the match trail renders a row per side with ● won and · halved", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "singles-match", id: gameId("m2"), a: PAT, b: ALEX };
    const game: GameState = {
      kind: "singles-match",
      id: config.id,
      up: 1,
      leader: PAT,
      thru: 3,
      remaining: 15,
      dormie: false,
      holes: [
        { hole: 1, winner: "halved" },
        { hole: 2, winner: "a" },
        { hole: 3, winner: "b" },
      ],
    };
    const state = baseState([config], participants);

    render(<GameSheet game={game} state={state} onClose={vi.fn()} />);

    const rows = screen.getAllByRole("row");
    // Header row (hole numbers), then side "a" (Pat), then side "b" (Alex) — the JSX's own order.
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["·", "●", ""]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["·", "", "●"]);
    expect(screen.getByRole("rowheader", { name: "Pat" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Alex" })).toBeTruthy();
  });

  it("the skins story collapses carry runs", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "skins", id: gameId("s1"), players: [PAT, ALEX] };
    const game: GameState = {
      kind: "skins",
      id: config.id,
      lines: [
        { golferId: PAT, skins: 3 },
        { golferId: ALEX, skins: 0 },
      ],
      carrying: 0,
      carriedOut: 0,
      complete: false,
      holesDecided: 4,
      holes: [
        { hole: 1, pot: 1 },
        { hole: 2, pot: 2 },
        { hole: 3, winner: PAT, pot: 3 },
        { hole: 4, pot: 1 },
      ],
    };
    const state = baseState([config], participants);

    render(<GameSheet game={game} state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Holes 1–2 — carried")).toBeTruthy();
    expect(screen.getByText("Hole 3 — Pat takes 3")).toBeTruthy();
    expect(screen.getByText("Hole 4 — carried")).toBeTruthy();
  });

  it("the header names the allowance in words and the blurb teaches", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "skins", id: gameId("s2"), players: [PAT, ALEX] };
    const game: GameState = {
      kind: "skins",
      id: config.id,
      lines: [
        { golferId: PAT, skins: 0 },
        { golferId: ALEX, skins: 0 },
      ],
      carrying: 0,
      carriedOut: 0,
      complete: false,
      holesDecided: 0,
      holes: [],
    };
    const state = baseState([config], participants);

    render(<GameSheet game={game} state={state} onClose={vi.fn()} />);

    // Skins' default allowance is 100% (WHS) — no explicit config.allowance.
    expect(screen.getByText("Full handicap (standard)")).toBeTruthy();
    expect(screen.getByText("Every hole is worth a skin. Win the hole outright to take it — ties carry it to the next hole.")).toBeTruthy();
  });

  it("close calls onClose", async () => {
    const participants: readonly Participant[] = [
      { golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 },
      { golferId: BO, name: "Bo", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "stroke-play", id: gameId("g3"), scoring: "gross", players: [ANN, BO] };
    const game: GameState = { kind: "stroke-play", id: config.id, scoring: "gross", complete: false, leaders: [], lines: [] };
    const state = baseState([config], participants);
    const onClose = vi.fn();

    render(<GameSheet game={game} state={state} onClose={onClose} />);

    // The dialog's aria-label pins the exact "{title} standings" copy while we're here.
    expect(screen.getByRole("dialog", { name: "Stroke play (gross) standings" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
