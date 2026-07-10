import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cellKey, deviceId, fixtureLinks, gameId, golferId, opId, roundId, scoreGame } from "@swng/domain";
import type { GameConfig, GameState, RoundState, ScoreCell } from "@swng/domain";
import { describeGame } from "../games/describeGame";
import { HoleDigest, useHoleDigest } from "./HoleDigest";

const ANN = golferId("ann");
const BO = golferId("bo");
const participants = [
  { golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: BO, name: "Bo", tee: "white", courseHandicap: 2 },
];
const config: GameConfig = { kind: "stableford", id: gameId("s1"), players: [ANN, BO] };

let opCounter = 0;
const cell = (result: ScoreCell["result"], recordedBy: typeof ANN): ScoreCell => ({
  result,
  recordedBy,
  hlc: { wallMs: 1, counter: 0, deviceId: deviceId("d") },
  opId: opId(`op-${(opCounter += 1)}`),
});

const stateWith = (cells: RoundState["cells"]): RoundState => ({
  id: roundId("r1"),
  status: "live",
  card: fixtureLinks,
  participants,
  games: [config],
  cells,
  terminatedGameIds: new Set(),
});

const gamesFor = (state: RoundState): readonly GameState[] => [scoreGame(config, state)];

const hole1Incomplete = stateWith({ [cellKey(ANN, 1)]: cell({ kind: "strokes", strokes: 5 }, ANN) });
const hole1Complete = stateWith({ ...hole1Incomplete.cells, [cellKey(BO, 1)]: cell({ kind: "strokes", strokes: 4 }, BO) });
const hole2Partial = stateWith({ ...hole1Complete.cells, [cellKey(ANN, 2)]: cell({ kind: "strokes", strokes: 4 }, ANN) });
const hole1Corrected = stateWith({ [cellKey(ANN, 1)]: cell({ kind: "strokes", strokes: 6 }, ANN), [cellKey(BO, 1)]: cell({ kind: "strokes", strokes: 4 }, BO) });

// Simulates an offline device reconnecting and draining several queued scores in one sync
// pass: holes 1 AND 2 both go from not-yet-complete to complete between one render and the
// next (no intermediate render where only hole 1 is complete), the way a real snapshot jump
// from @swng/client's sync loop looks.
const hole1And2Complete = stateWith({
  ...hole1Complete.cells,
  [cellKey(ANN, 2)]: cell({ kind: "strokes", strokes: 4 }, ANN),
  [cellKey(BO, 2)]: cell({ kind: "strokes", strokes: 5 }, BO),
});
const hole1CorrectedAfterBatch = stateWith({ ...hole1And2Complete.cells, [cellKey(ANN, 1)]: cell({ kind: "strokes", strokes: 6 }, ANN) });

function Harness({ state }: { state: RoundState }) {
  const { digest, dismiss } = useHoleDigest(state, gamesFor(state));
  return digest ? <HoleDigest digest={digest} onDismiss={dismiss} /> : null;
}

afterEach(() => cleanup());

describe("useHoleDigest — trigger semantics", () => {
  it("does not fire on mount, even for a hole that's already complete (mounting isn't a transition)", () => {
    render(<Harness state={hole1Complete} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("fires exactly once, the render a hole first becomes complete", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />);
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<Harness state={hole1Complete} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("After 1")).toBeTruthy();
  });

  it("dismisses by tap", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />);
    rerender(<Harness state={hole1Complete} />);
    expect(screen.getByRole("status")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses on the next score entry, even one that doesn't itself complete a hole", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />);
    rerender(<Harness state={hole1Complete} />);
    expect(screen.getByRole("status")).toBeTruthy();

    rerender(<Harness state={hole2Partial} />); // Ann's hole 2 — hole 2 itself stays incomplete (Bo hasn't posted)
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a correction to an already-complete hole never re-fires its digest", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />);
    rerender(<Harness state={hole1Complete} />); // fires once
    rerender(<Harness state={hole1Corrected} />); // Ann's hole 1 corrected 5 -> 6; still complete, not NEWLY complete

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("content: each game's current line, plus what changed (the pre-completion line) when it differs", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />);
    rerender(<Harness state={hole1Complete} />);

    const card = screen.getByRole("status");
    const afterLine = describeGame(gamesFor(hole1Complete)[0]!, hole1Complete).line;
    const beforeLine = describeGame(gamesFor(hole1Incomplete)[0]!, hole1Incomplete).line;
    expect(card.textContent).toContain(afterLine);
    expect(beforeLine).not.toBe(afterLine); // sanity: this fixture's before/after genuinely differ
    expect(card.textContent).toContain(beforeLine);
  });

  it("collapses a multi-hole catch-up batch into ONE digest labeled by the HIGHEST newly-completed hole, diffed against the pre-batch snapshot", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />); // partially complete: only Ann's hole 1 so far
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<Harness state={hole1And2Complete} />); // holes 1 AND 2 both complete in the same snapshot transition
    expect(screen.getAllByRole("status")).toHaveLength(1); // one card for the whole batch, not one per hole
    expect(screen.getByText("After 2")).toBeTruthy(); // labeled by the highest hole in the batch...
    expect(screen.queryByText("After 1")).toBeNull(); // ...not the lowest

    const card = screen.getByRole("status");
    const afterLine = describeGame(gamesFor(hole1And2Complete)[0]!, hole1And2Complete).line;
    const beforeLine = describeGame(gamesFor(hole1Incomplete)[0]!, hole1Incomplete).line; // pre-BATCH snapshot (before hole 1 completed), not just pre-hole-2
    expect(card.textContent).toContain(afterLine);
    expect(card.textContent).toContain(beforeLine); // the diff spans the whole batch, not just the labeled hole's own change
  });

  it("a batch's swallowed (non-labeled) holes never get a delayed digest of their own", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />);
    rerender(<Harness state={hole1And2Complete} />); // batch fires "After 2"; hole 1 is marked digested too, silently

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<Harness state={hole1CorrectedAfterBatch} />); // correction to hole 1 only; still complete, not NEWLY complete
    expect(screen.queryByRole("status")).toBeNull(); // the swallowed hole must not surface a late digest of its own
  });

  it("a single-hole completion still labels normally (the batch collapse doesn't affect the common case)", () => {
    const { rerender } = render(<Harness state={hole1Incomplete} />);
    rerender(<Harness state={hole1Complete} />);
    expect(screen.getByText("After 1")).toBeTruthy();
  });

  // M7 Task 6: terminated games drop out of digest lines (brief) — a game that's stopped
  // consuming scores shouldn't get a "what changed" line every time another hole completes.
  it("excludes a terminated game's line from the digest", () => {
    const terminatedState: RoundState = { ...hole1Complete, terminatedGameIds: new Set([config.id]) };
    const incompleteWithTermination: RoundState = { ...hole1Incomplete, terminatedGameIds: new Set([config.id]) };

    const { rerender } = render(<Harness state={incompleteWithTermination} />);
    rerender(<Harness state={terminatedState} />);

    expect(screen.getByRole("status")).toBeTruthy(); // the hole still completed — the digest itself still fires
    expect(screen.queryByText(/Stableford/)).toBeNull(); // but the terminated game's own line is gone
  });
});
