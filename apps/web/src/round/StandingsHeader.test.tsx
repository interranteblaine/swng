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
  terminatedGameIds: new Set(),
  ...overrides,
});

const gameStates: readonly GameState[] = [
  { kind: "stroke-play", id: strokePlayConfig.id, scoring: "gross", lines: [], complete: false, leaders: [] },
  { kind: "stableford", id: stablefordConfig.id, lines: [], complete: false, leaders: [] },
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

  it("tapping the active chip opens that game's sheet; tapping an inactive chip only selects", async () => {
    const onSelect = vi.fn();
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={onSelect} />);

    // The inactive (stableford) chip still just selects — no dialog.
    fireEvent.click(screen.getByRole("tab", { name: /Stableford/ }));
    expect(onSelect).toHaveBeenCalledWith(stablefordConfig.id);
    expect(screen.queryByRole("dialog")).toBeNull();

    // The active (stroke-play) chip opens its sheet instead of re-selecting.
    onSelect.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: /Stroke play/ }));
    expect(onSelect).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Stroke play (gross) standings" });
    expect(dialog).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the active chip shows the › open cue", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} />);

    const strokeTab = screen.getByRole("tab", { name: /Stroke play/ });
    const stablefordTab = screen.getByRole("tab", { name: /Stableford/ });
    expect(strokeTab.textContent).toContain("›");
    expect(stablefordTab.textContent).not.toContain("›");
  });
});

// M7 Task 6: game termination affordance — an overflow "End game…" per chip (live rounds
// only), a confirm dialog naming the game, and an "ended" badge once terminated.
describe("StandingsHeader — terminate a game", () => {
  it("shows no overflow control at all when onTerminate isn't provided (ResultsView's own archived reuse)", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /End /i })).toBeNull();
  });

  it("shows no overflow control on an already-terminated chip — nothing left to end", () => {
    const state = baseState({ terminatedGameIds: new Set([strokePlayConfig.id]) });
    render(<StandingsHeader state={state} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} onTerminate={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /End Stroke play/i })).toBeNull();
    expect(screen.getByRole("button", { name: /End Stableford/i })).toBeTruthy();
  });

  it("clicking the overflow control opens a confirm dialog naming the game; Cancel closes it without calling onTerminate", () => {
    const onTerminate = vi.fn();
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} onTerminate={onTerminate} />);

    fireEvent.click(screen.getByRole("button", { name: /End Stableford/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/Stableford/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it("confirming calls onTerminate(gameId) and closes the dialog on success", async () => {
    const onTerminate = vi.fn().mockResolvedValue(undefined);
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} onTerminate={onTerminate} />);

    fireEvent.click(screen.getByRole("button", { name: /End Stableford/i }));
    fireEvent.click(screen.getByRole("button", { name: "End game" }));

    expect(onTerminate).toHaveBeenCalledWith(stablefordConfig.id);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a fixed friendly error — never the raw rejection message — and stays open when onTerminate rejects", async () => {
    // A message shaped like the server's own unknown-game text (carries a uuid) — the exact
    // class of leak papercut 1 killed in the finalize dialog, banned here too.
    const onTerminate = vi.fn().mockRejectedValue(new Error('no game "3f2b9c1d-raw-uuid" in this round'));
    render(<StandingsHeader state={baseState()} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} onTerminate={onTerminate} />);

    fireEvent.click(screen.getByRole("button", { name: /End Stableford/i }));
    fireEvent.click(screen.getByRole("button", { name: "End game" }));

    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not end the game — try again.");
    expect(document.body.textContent).not.toMatch(/3f2b9c1d-raw-uuid/);
    expect(screen.getByRole("dialog")).toBeTruthy(); // stays open so the golfer can retry
  });

  it("a terminated game's chip shows an Ended badge and no overflow control, even though it's still selectable", () => {
    const state = baseState({ terminatedGameIds: new Set([stablefordConfig.id]) });
    render(<StandingsHeader state={state} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} onTerminate={vi.fn()} />);

    const stablefordTab = screen.getByRole("tab", { name: /Stableford/ });
    expect(stablefordTab.textContent).toMatch(/Ended/i);
    expect(screen.queryByRole("button", { name: /End Stableford/i })).toBeNull();
  });

  it("no overflow control on any chip once the round is final (archived reuse defense-in-depth, even if a caller passed onTerminate)", () => {
    const state = baseState({ status: "final" });
    render(<StandingsHeader state={state} games={gameStates} activeGameId={strokePlayConfig.id} onSelect={vi.fn()} onTerminate={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /End /i })).toBeNull();
  });
});
