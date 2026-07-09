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
});

const gamesFor = (state: RoundState): readonly GameState[] => [scoreGame(config, state)];

const hole1Incomplete = stateWith({ [cellKey(ANN, 1)]: cell({ kind: "strokes", strokes: 5 }, ANN) });
const hole1Complete = stateWith({ ...hole1Incomplete.cells, [cellKey(BO, 1)]: cell({ kind: "strokes", strokes: 4 }, BO) });
const hole2Partial = stateWith({ ...hole1Complete.cells, [cellKey(ANN, 2)]: cell({ kind: "strokes", strokes: 4 }, ANN) });
const hole1Corrected = stateWith({ [cellKey(ANN, 1)]: cell({ kind: "strokes", strokes: 6 }, ANN), [cellKey(BO, 1)]: cell({ kind: "strokes", strokes: 4 }, BO) });

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
});
