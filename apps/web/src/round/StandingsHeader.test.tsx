import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, gameId, golferId, roundId } from "@swng/domain";
import type { GameState, RosterEntry, RoundState } from "@swng/domain";
import { StandingsHeader } from "./StandingsHeader";

const ANN = golferId("ann");
const BO = golferId("bo");
const participants: readonly RosterEntry[] = [
  { golferId: ANN, name: "Ann", tee: "white", strokes: 8 },
  { golferId: BO, name: "Bo", tee: "white", strokes: 2 },
];

const strokePlayConfig = { kind: "stroke-play" as const, id: gameId("g1"), scoring: "gross" as const, players: [ANN, BO] };
const stablefordConfig = { kind: "stableford" as const, id: gameId("g2"), players: [ANN, BO] };

const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  playedAtMs: 1_000,
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

// spec 2026-07-19 §2b: chips are disclosure buttons — one tap expands that game's panel
// inline below the chip row; tapping another chip switches; tapping the open chip closes it.
// No modal, no tablist/tab roles, no per-chip "⋯", no second-tap-to-open logic. Default: all
// collapsed (StandingsHeader.tsx no longer drives the grid at all — Task 3's own game-agnostic
// card change means chips only ever control which panel, if any, is open).
describe("StandingsHeader", () => {
  it("renders one chip per game, titled and described via describeGame — the only kind-switch site", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);

    // describeGame's own output for an empty stroke-play/stableford line — proves the chip
    // text is genuinely routed through describeGame, not a hand-rolled label here.
    expect(screen.getByRole("button", { name: /Stroke play \(gross\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stableford/ })).toBeTruthy();
  });

  it("renders nothing when there are no games yet", () => {
    const { container } = render(<StandingsHeader state={baseState({ games: [] })} games={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("all chips start collapsed — no panel renders by default", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("button", { name: /Stroke play/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /Stableford/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("tapping a chip expands that game's panel inline, below the chip row, with aria-expanded true", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);

    fireEvent.click(screen.getByRole("button", { name: /Stroke play/ }));

    const region = screen.getByRole("region", { name: "Stroke play (gross) standings" });
    expect(region).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stroke play/ }).getAttribute("aria-expanded")).toBe("true");
    // No modal ever appears just from expanding — the panel is inline, not a dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tapping another chip switches which panel is open — only one at a time", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);

    fireEvent.click(screen.getByRole("button", { name: /Stroke play/ }));
    expect(screen.getByRole("region", { name: "Stroke play (gross) standings" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    expect(screen.queryByRole("region", { name: "Stroke play (gross) standings" })).toBeNull();
    expect(screen.getByRole("region", { name: "Stableford standings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stroke play/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /Stableford/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("tapping the open chip again closes its panel", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);

    const strokeChip = screen.getByRole("button", { name: /Stroke play/ });
    fireEvent.click(strokeChip);
    expect(screen.getByRole("region")).toBeTruthy();

    fireEvent.click(strokeChip);
    expect(screen.queryByRole("region")).toBeNull();
    expect(strokeChip.getAttribute("aria-expanded")).toBe("false");
  });

  it("the trailing glyph flips ▾/▴ with expand state, aria-hidden", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);
    const strokeChip = screen.getByRole("button", { name: /Stroke play/ });

    expect(strokeChip.textContent).toContain("▾");
    fireEvent.click(strokeChip);
    expect(strokeChip.textContent).toContain("▴");
    expect(strokeChip.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it("no tablist/tab roles anywhere — chips are plain buttons", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("no per-chip '⋯' overflow button anywhere, even with onTerminate provided", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} onTerminate={vi.fn()} />);
    expect(screen.queryByText("⋯")).toBeNull();
  });
});

// M7 Task 6 (moved into the panel this arc): game termination — the trigger now lives in the
// open panel's own footer, not a per-chip overflow control; the confirm bottom-sheet itself is
// unchanged (kept as a dialog).
describe("StandingsHeader — terminate a game", () => {
  it("shows no End affordance when onTerminate isn't provided (ResultsView's own archived reuse)", () => {
    render(<StandingsHeader state={baseState()} games={gameStates} />);
    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    expect(screen.queryByRole("button", { name: "End game…" })).toBeNull();
  });

  it("shows no End affordance on an already-terminated game's panel — nothing left to end", () => {
    const state = baseState({ terminatedGameIds: new Set([stablefordConfig.id]) });
    render(<StandingsHeader state={state} games={gameStates} onTerminate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    expect(screen.queryByRole("button", { name: "End game…" })).toBeNull();
    // "Ended" renders both on the chip and inside the open panel's own header.
    expect(screen.getAllByText("Ended").length).toBeGreaterThan(0);
  });

  it("the panel's End game… control opens a confirm dialog naming the game; Cancel closes it without calling onTerminate", () => {
    const onTerminate = vi.fn();
    render(<StandingsHeader state={baseState()} games={gameStates} onTerminate={onTerminate} />);

    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    fireEvent.click(screen.getByRole("button", { name: "End game…" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/Stableford/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it("confirming calls onTerminate(gameId) and closes the dialog on success", async () => {
    const onTerminate = vi.fn().mockResolvedValue(undefined);
    render(<StandingsHeader state={baseState()} games={gameStates} onTerminate={onTerminate} />);

    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    fireEvent.click(screen.getByRole("button", { name: "End game…" }));
    fireEvent.click(screen.getByRole("button", { name: "End game" }));

    expect(onTerminate).toHaveBeenCalledWith(stablefordConfig.id);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a fixed friendly error — never the raw rejection message — and stays open when onTerminate rejects", async () => {
    // A message shaped like the server's own unknown-game text (carries a uuid) — the exact
    // class of leak papercut 1 killed in the finalize dialog, banned here too.
    const onTerminate = vi.fn().mockRejectedValue(new Error('no game "3f2b9c1d-raw-uuid" in this round'));
    render(<StandingsHeader state={baseState()} games={gameStates} onTerminate={onTerminate} />);

    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    fireEvent.click(screen.getByRole("button", { name: "End game…" }));
    fireEvent.click(screen.getByRole("button", { name: "End game" }));

    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not end the game — try again.");
    expect(document.body.textContent).not.toMatch(/3f2b9c1d-raw-uuid/);
    expect(screen.getByRole("dialog")).toBeTruthy(); // stays open so the golfer can retry
  });

  it("a terminated game's chip shows an Ended badge, still selectable to view its (End-affordance-free) panel", () => {
    const state = baseState({ terminatedGameIds: new Set([stablefordConfig.id]) });
    render(<StandingsHeader state={state} games={gameStates} onTerminate={vi.fn()} />);

    const stablefordChip = screen.getByRole("button", { name: /Stableford/ });
    expect(stablefordChip.textContent).toMatch(/Ended/i);

    fireEvent.click(stablefordChip);
    expect(screen.getByRole("region", { name: "Stableford standings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End game…" })).toBeNull();
  });

  it("no End affordance on any panel once the round is final (archived reuse defense-in-depth, even if a caller passed onTerminate)", () => {
    const state = baseState({ status: "final" });
    render(<StandingsHeader state={state} games={gameStates} onTerminate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    expect(screen.queryByRole("button", { name: "End game…" })).toBeNull();
  });
});
