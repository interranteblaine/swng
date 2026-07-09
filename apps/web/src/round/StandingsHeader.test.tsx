import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, gameId, golferId, roundId } from "@swng/domain";
import type { GameState, Participant, RoundState } from "@swng/domain";
import { StandingsHeader } from "./StandingsHeader";

const ANN = golferId("ann");
const BO = golferId("bo");
const participants: readonly Participant[] = [
  { golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: BO, name: "Bo", tee: "white", courseHandicap: 2 },
];

const strokePlayConfig = { kind: "stroke-play" as const, id: gameId("g1"), scoring: "gross" as const, players: [ANN, BO] };
const stablefordConfig = { kind: "stableford" as const, id: gameId("g2"), players: [ANN, BO] };

const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  participants,
  games: [strokePlayConfig, stablefordConfig],
  cells: {},
  ...overrides,
});

const gameStates: readonly GameState[] = [
  { kind: "stroke-play", id: strokePlayConfig.id, scoring: "gross", lines: [], complete: false },
  { kind: "stableford", id: stablefordConfig.id, lines: [], complete: false },
];

afterEach(() => cleanup());

describe("StandingsHeader", () => {
  it("renders one chip per game, titled and described via describeGame — the only kind-switch site", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} />);

    // describeGame's own output for an empty stroke-play/stableford line — proves the chip
    // text is genuinely routed through describeGame, not a hand-rolled label here.
    expect(screen.getByRole("tab", { name: /Stroke play \(gross\)/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Stableford/ })).toBeTruthy();
  });

  it("renders nothing when there are no games yet", () => {
    const { container } = render(<StandingsHeader state={baseState({ games: [] })} games={[]} activeGameId={undefined} onSelect={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("tapping a chip reports that game's id, and only that one shows as active", () => {
    const onSelect = vi.fn();
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={onSelect} />);

    const strokeTab = screen.getByRole("tab", { name: /Stroke play/ });
    const stablefordTab = screen.getByRole("tab", { name: /Stableford/ });
    expect(strokeTab.getAttribute("aria-selected")).toBe("true");
    expect(stablefordTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(stablefordTab);
    expect(onSelect).toHaveBeenCalledWith(stablefordConfig.id);
  });

  it("marks the active chip with a non-color structural cue, not color alone", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} />);

    const strokeTab = screen.getByRole("tab", { name: /Stroke play/ });
    const stablefordTab = screen.getByRole("tab", { name: /Stableford/ });

    // A sighted, color-blind user must be able to tell the active chip apart from its border
    // alone: active gets a solid current-color border + bold text; inactive gets a transparent
    // (layout-preserving) border and regular weight.
    expect(strokeTab.className).toMatch(/border-2 border-current/);
    expect(strokeTab.className).toMatch(/font-semibold/);
    expect(stablefordTab.className).toMatch(/border border-transparent/);
    expect(stablefordTab.className).not.toMatch(/font-semibold/);
  });
});
