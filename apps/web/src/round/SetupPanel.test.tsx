import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAllowance, fixtureLinks, gameId, golferId, playingHandicap, roundId } from "@swng/domain";
import type { GameConfig, GameState, Participant, RoundState } from "@swng/domain";
import { SetupPanel } from "./SetupPanel";

const ANN = golferId("ann");
const BO = golferId("bo");
const CAL = golferId("cal");
const DEE = golferId("dee");

const participant = (id: ReturnType<typeof golferId>, name: string, tee: string, courseHandicap: number): Participant => ({ golferId: id, name, tee, courseHandicap });

const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  participants: [participant(ANN, "Ann", "white", 8), participant(BO, "Bo", "white", 4), participant(CAL, "Cal", "white", 14), participant(DEE, "Dee", "white", 2)],
  games: [],
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

const noopAddGame = vi.fn().mockResolvedValue(undefined);

beforeEach(() => noopAddGame.mockClear());
afterEach(() => cleanup());

describe("SetupPanel", () => {
  it("shows the join code prominently", () => {
    render(<SetupPanel state={baseState()} games={[]} joinCode="ABC123" onAddGame={noopAddGame} />);

    expect(screen.getByText("ABC123")).toBeTruthy();
  });

  it("shows the plain roster (name, tee, courseHandicap) when no games exist yet", () => {
    render(<SetupPanel state={baseState()} games={[]} joinCode="ABC123" onAddGame={noopAddGame} />);

    expect(screen.getByText("Ann")).toBeTruthy();
    expect(screen.getByText(/CH 8/)).toBeTruthy();
    expect(screen.queryByText(/^Games/)).toBeNull(); // no games section before any game exists
  });

  it("shows per-game dots once a game exists, on the same roster row as name/tee/CH", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false }];

    render(<SetupPanel state={state} games={games} joinCode="ABC123" onAddGame={noopAddGame} />);

    const expectedDots = playingHandicap(8, defaultAllowance("stableford"));
    const annRow = screen.getAllByRole("listitem").find((li) => /CH 8/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    // Same row carries both the identity (name/tee/CH) and the game's dots — one roster, not
    // a second list keyed off dots alone.
    expect(within(annRow!).getByText(new RegExp(`Stableford: ${expectedDots} dots`))).toBeTruthy();
  });

  it("renders each participant's identity row exactly once even once games exist — no second, dots-only roster", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false }];

    render(<SetupPanel state={state} games={games} joinCode="ABC123" onAddGame={noopAddGame} />);

    // Scope to <li> rows specifically (not the Add Game form's player checkboxes, which are
    // <label> elements, not list items) — Ann must appear as exactly one roster row.
    const annRows = screen.getAllByRole("listitem").filter((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRows).toHaveLength(1);
    // And that single row still carries the full identity — tee and courseHandicap didn't
    // get dropped in favor of a dots-only line.
    expect(annRows[0]?.textContent).toMatch(/white/);
    expect(annRows[0]?.textContent).toMatch(/CH 8/);

    // Bo has no game yet — still gets an identity row (just no dots badge).
    const boRows = screen.getAllByRole("listitem").filter((li) => /Bo/.test(li.textContent ?? ""));
    expect(boRows).toHaveLength(1);
    expect(boRows[0]?.textContent).toMatch(/CH 4/);
  });

  it("adds a fourball-match game with the exact {kind, a, b} shape (ids from participants) and no id field", async () => {
    render(<SetupPanel state={baseState()} games={[]} joinCode="ABC123" onAddGame={noopAddGame} />);
    noopAddGame.mockClear();

    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "fourball-match" } });
    fireEvent.change(screen.getByLabelText(/side a.*player 1/i), { target: { value: ANN } });
    fireEvent.change(screen.getByLabelText(/side a.*player 2/i), { target: { value: BO } });
    fireEvent.change(screen.getByLabelText(/side b.*player 1/i), { target: { value: CAL } });
    fireEvent.change(screen.getByLabelText(/side b.*player 2/i), { target: { value: DEE } });
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    expect(noopAddGame).toHaveBeenCalledTimes(1);
    const sent = noopAddGame.mock.calls[0]![0];
    expect(sent).toMatchObject({ kind: "fourball-match", a: [ANN, BO], b: [CAL, DEE] });
    expect(sent).not.toHaveProperty("id");
  });

  it("never renders the submitted game optimistically — it only appears once state.games reflects it", async () => {
    const { rerender } = render(<SetupPanel state={baseState()} games={[]} joinCode="ABC123" onAddGame={noopAddGame} />);

    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "stableford" } });
    fireEvent.click(within(screen.getByRole("group", { name: /players/i })).getByLabelText("Ann"));
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    expect(noopAddGame).toHaveBeenCalled();
    // Props are unchanged (still zero games) — the new game must not appear from the click
    // alone. Confirms the why-comment in SetupPanel: game-added arrives back through the
    // session, not from a local optimistic write.
    expect(screen.queryByText(/^Games/)).toBeNull();

    // Only once the parent re-renders with the new game (as the real session would, after the
    // game-added event round-trips) does it show up.
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-9"), players: [ANN] };
    rerender(<SetupPanel state={baseState({ games: [stableford] })} games={[]} joinCode="ABC123" onAddGame={noopAddGame} />);
    const expectedDots = playingHandicap(8, defaultAllowance("stableford"));
    expect(screen.getByText(new RegExp(`Stableford: ${expectedDots} dots`))).toBeTruthy();
  });

  it("sends a hand-edited allowance value (not the per-kind default) in onAddGame's config", async () => {
    render(<SetupPanel state={baseState()} games={[]} joinCode="ABC123" onAddGame={noopAddGame} />);
    noopAddGame.mockClear();

    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "stableford" } });
    fireEvent.click(within(screen.getByRole("group", { name: /players/i })).getByLabelText("Ann"));
    // 0.5 isn't stableford's default allowance (0.95, per defaultAllowance) — picking a value
    // that differs from the default is the point: this guards the step="any" fix (a stricter
    // step would have silently blocked this exact submit).
    fireEvent.change(screen.getByLabelText(/allowance/i), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    expect(noopAddGame).toHaveBeenCalledTimes(1);
    const sent = noopAddGame.mock.calls[0]![0];
    expect(sent).toMatchObject({ kind: "stableford", players: [ANN], allowance: 0.5 });
  });
});
