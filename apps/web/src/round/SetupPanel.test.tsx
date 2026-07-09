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

  it("groups roster by game and shows per-game dots once a game exists", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false }];

    render(<SetupPanel state={state} games={games} joinCode="ABC123" onAddGame={noopAddGame} />);

    // "Stableford" also appears as an <option> in the Add Game kind picker — scope to the
    // game group's own heading to disambiguate.
    expect(screen.getByRole("heading", { name: "Stableford" })).toBeTruthy();
    const expectedDots = playingHandicap(8, defaultAllowance("stableford"));
    expect(screen.getByText(new RegExp(`${expectedDots} dots`))).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "Stableford" })).toBeTruthy();
  });
});
