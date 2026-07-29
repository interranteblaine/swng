import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cellKey, deviceId, fixtureLinks, fixtureLinks18, fixtureWhite, fixtureWhite18, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, GolferId, HoleResult, Participant, RoundState, ScoreCell } from "@swng/domain";
import { ScorecardGrid } from "./ScorecardGrid";

const ANN = golferId("ann");
const BO = golferId("bo");

const participant = (id: GolferId, name: string, tee: string, courseHandicap: number): Participant => ({ golferId: id, name, tee, courseHandicap });

let opCounter = 0;
// A minimal, valid ScoreCell — only `result` and `recordedBy` matter to any test here; hlc/opId
// just need to be well-formed (reduceRound's own resolution isn't under test in this file).
const scoreCell = (result: ScoreCell["result"], recordedBy: GolferId): ScoreCell => ({
  result,
  recordedBy,
  hlc: { wallMs: 1, counter: 0, deviceId: deviceId("d") },
  opId: opId(`op-${(opCounter += 1)}`),
});

const twoPlayerState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  participants: [participant(ANN, "Ann", "white", 8), participant(BO, "Bo", "white", 4)],
  games: [],
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

afterEach(() => cleanup());

// Finds the tappable cell for a golfer/hole — every cell carries a stable aria-label so tests
// don't depend on the cell's rendered gross/dots content to locate it.
const cellButton = (golferName: string, hole: number) => screen.getByRole("button", { name: `${golferName} hole ${hole}` });

describe("ScorecardGrid — two-tap entry", () => {
  it("idle → tap cell → pad opens → tap a value → recordScore fires and the pad closes, in exactly 2 pointer interactions", () => {
    const recordScore = vi.fn<(golferId: GolferId, hole: number, result: HoleResult) => void>();
    render(<ScorecardGrid state={twoPlayerState()} recordScore={recordScore} />);

    expect(screen.queryByRole("dialog")).toBeNull();

    let pointerInteractions = 0;
    fireEvent.click(cellButton("Ann", 1));
    pointerInteractions += 1;
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "5" }));
    pointerInteractions += 1;

    expect(pointerInteractions).toBe(2);
    expect(recordScore).toHaveBeenCalledTimes(1);
    expect(recordScore).toHaveBeenCalledWith(ANN, 1, { kind: "strokes", strokes: 5 });
    expect(screen.queryByRole("dialog")).toBeNull(); // pad closes on post, no confirm step
  });

  it("posts a first-class picked-up result", () => {
    const recordScore = vi.fn();
    render(<ScorecardGrid state={twoPlayerState()} recordScore={recordScore} />);

    fireEvent.click(cellButton("Ann", 2));
    fireEvent.click(screen.getByRole("button", { name: "Picked up" }));

    expect(recordScore).toHaveBeenCalledWith(ANN, 2, { kind: "picked-up" });
  });

  it("scoring for ANOTHER golfer posts their golferId, not the tapper's own", () => {
    const recordScore = vi.fn();
    render(<ScorecardGrid state={twoPlayerState()} recordScore={recordScore} />);

    fireEvent.click(cellButton("Bo", 3));
    fireEvent.click(screen.getByRole("button", { name: "4" }));

    expect(recordScore).toHaveBeenCalledWith(BO, 3, { kind: "strokes", strokes: 4 });
  });

  it("correcting an already-filled cell is still exactly 2 taps and posts the new value", () => {
    const recordScore = vi.fn();
    const state = twoPlayerState({ cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 6 }, ANN) } });
    render(<ScorecardGrid state={state} recordScore={recordScore} />);

    // The filled cell already shows the prior gross score...
    expect(within(cellButton("Ann", 1)).getByText("6")).toBeTruthy();

    fireEvent.click(cellButton("Ann", 1));
    fireEvent.click(screen.getByRole("button", { name: "3" }));

    expect(recordScore).toHaveBeenCalledWith(ANN, 1, { kind: "strokes", strokes: 3 });
  });
});

// The standard card (spec 2026-07-19 §2a: the card never changes): dots are ALWAYS each
// player's own full course handicap allocated by stroke index — no game, no
// chip selection. `ScorecardGridProps` carries no game-typed prop at all; every test below
// passes only `{ state, recordScore }`.
describe("ScorecardGrid — course-handicap dots (the standard card)", () => {
  it("a course handicap of 0 shows plain gross and no dot glyphs", () => {
    const state = twoPlayerState({
      participants: [participant(ANN, "Ann", "white", 0), participant(BO, "Bo", "white", 0)],
      cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 5 }, ANN) },
    });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const cell = cellButton("Ann", 1);
    expect(within(cell).getByText("5")).toBeTruthy();
    expect(cell.textContent).not.toMatch("●");
  });

  it("a CH-5 player shows ● on their 5 hardest SI holes and net = gross − dot under scored cells, with NO game in state", () => {
    const ann5 = participant(ANN, "Ann", "white", 5);
    const bo0 = participant(BO, "Bo", "white", 0);
    // Hole 2 is SI 1 on fixtureWhite (the 9-hole fixture card) — one of Ann's 5 hardest holes.
    const state = twoPlayerState({ participants: [ann5, bo0], games: [], cells: { [cellKey(ANN, 2)]: scoreCell({ kind: "strokes", strokes: 5 }, ANN) } });

    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const dottedHoles = fixtureWhite.holes.filter((h) => h.strokeIndex <= 5).map((h) => h.number);
    expect(dottedHoles).toHaveLength(5);
    for (const hole of fixtureWhite.holes) {
      const cell = cellButton("Ann", hole.number);
      if (dottedHoles.includes(hole.number)) {
        expect(cell.textContent).toMatch("●");
      } else {
        expect(cell.textContent).not.toMatch("●");
      }
    }

    const scoredCell = cellButton("Ann", 2);
    expect(within(scoredCell).getByText("5")).toBeTruthy(); // gross
    expect(within(scoredCell).getByText("4")).toBeTruthy(); // net = 5 − 1 dot
  });

  // The card never changes (spec 2026-07-19 §2a): the SAME participants/cells rendered under
  // two different sets of concurrent games produce byte-identical grid output — no game, active
  // or otherwise, is read by this component at all.
  it("a second render with different games in state produces identical cells — the card is game-agnostic", () => {
    const ann5 = participant(ANN, "Ann", "white", 5);
    const bo0 = participant(BO, "Bo", "white", 0);
    const cells = { [cellKey(ANN, 2)]: scoreCell({ kind: "strokes", strokes: 5 }, ANN) };
    const singles: GameConfig = { kind: "singles-match", id: gameId("g1"), a: ANN, b: BO };
    const skins: GameConfig = { kind: "skins", id: gameId("g2"), scoring: "net", players: [ANN, BO] };

    const { container: containerA } = render(<ScorecardGrid state={twoPlayerState({ participants: [ann5, bo0], games: [singles], cells })} recordScore={vi.fn()} />);
    const textA = containerA.textContent;
    cleanup();

    const { container: containerB } = render(<ScorecardGrid state={twoPlayerState({ participants: [ann5, bo0], games: [skins], cells })} recordScore={vi.fn()} />);
    const textB = containerB.textContent;

    expect(textB).toBe(textA);
  });

  // A plus handicap (course handicap below 0) GIVES a stroke back rather than receiving one —
  // it renders through strokeGrant as a hollow ○, and the net reads gross + 1 (net = gross −
  // dots, and dots is negative here). This is the participant's OWN course handicap; no game is
  // involved at all.
  it("renders a plus player's GIVEN stroke as a hollow ○ with net = gross + 1, with no game in state at all", () => {
    const annPlus = participant(ANN, "Ann", "white", -1); // a plus handicap: gives a stroke back
    const boScratch = participant(BO, "Bo", "white", 0);
    const si9Hole = fixtureWhite.holes.find((h) => h.strokeIndex === 9)!; // the easiest hole on the 9-hole fixture — where a single give-back lands
    const state: RoundState = {
      id: roundId("round-giveback"),
      status: "live",
      card: fixtureLinks,
      participants: [annPlus, boScratch],
      games: [],
      cells: { [cellKey(ANN, si9Hole.number)]: scoreCell({ kind: "strokes", strokes: 5 }, ANN) },
      terminatedGameIds: new Set(),
    };

    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const cell = cellButton("Ann", si9Hole.number);
    expect(cell.textContent).toMatch("○"); // a GIVEN stroke draws hollow...
    expect(cell.textContent).not.toMatch("●"); // ...never a filled received-stroke glyph
    expect(within(cell).getByText("5")).toBeTruthy(); // gross
    expect(within(cell).getByText("6")).toBeTruthy(); // net = 5 − (−1) = gross + 1
  });

  it("a course handicap of 19 gets a second dot on the SI-1 hole of an 18-hole card, but only one on SI-18", () => {
    const ann0 = participant(ANN, "Ann", "white", 0);
    const bo19 = participant(BO, "Bo", "white", 19);
    const state: RoundState = {
      id: roundId("round-4"),
      status: "live",
      card: fixtureLinks18,
      participants: [ann0, bo19],
      games: [],
      cells: {},
      terminatedGameIds: new Set(),
    };

    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const si1Hole = fixtureWhite18.holes.find((h) => h.strokeIndex === 1)!;
    const si18Hole = fixtureWhite18.holes.find((h) => h.strokeIndex === 18)!;

    expect(cellButton("Bo", si1Hole.number).textContent).toMatch("●●");
    expect(cellButton("Bo", si18Hole.number).textContent).toMatch("●");
    expect(cellButton("Bo", si18Hole.number).textContent).not.toMatch("●●");
  });
});

describe("ScorecardGrid — readOnly (the archived card, Task 6)", () => {
  it("a cell tap never opens the pad, and recordScore is never called — native disabled, not just an inert recordScore", () => {
    const recordScore = vi.fn();
    const state = twoPlayerState({ cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 4 }, ANN) } });
    render(<ScorecardGrid state={state} recordScore={recordScore} readOnly />);

    expect(cellButton("Ann", 1).hasAttribute("disabled")).toBe(true);
    fireEvent.click(cellButton("Ann", 1));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(recordScore).not.toHaveBeenCalled();
  });

  it("defaults to interactive (readOnly omitted) — every existing live call site is unaffected", () => {
    render(<ScorecardGrid state={twoPlayerState()} recordScore={vi.fn()} />);
    expect(cellButton("Ann", 1).hasAttribute("disabled")).toBe(false);
  });
});

describe("ScorecardGrid — picked-up / conceded glyphs", () => {
  it("a picked-up cell shows PU and a conceded cell shows CN, not a numeric gross", () => {
    const state = twoPlayerState({
      cells: {
        [cellKey(ANN, 1)]: scoreCell({ kind: "picked-up" }, ANN),
        [cellKey(BO, 1)]: scoreCell({ kind: "conceded" }, BO),
      },
    });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    expect(within(cellButton("Ann", 1)).getByText("PU")).toBeTruthy();
    expect(within(cellButton("Bo", 1)).getByText("CN")).toBeTruthy();
  });
});

describe("ScorecardGrid — cleared cells", () => {
  // A mis-tap undone: cellAt (round/state.ts) hides a cleared cell from every reader — the grid
  // renders it exactly like a genuinely-unscored cell, with no extra branch of its own.
  it("a cleared cell renders identically to an unscored cell — no PU/CN/numeric glyph, just the placeholder", () => {
    const ann0 = participant(ANN, "Ann", "white", 0);
    const bo0 = participant(BO, "Bo", "white", 0);
    const state = twoPlayerState({ participants: [ann0, bo0], cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "cleared" }, ANN) } });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const clearedCell = cellButton("Ann", 1);
    const unscoredCell = cellButton("Bo", 1); // Bo has no cell for hole 1 at all — the ground truth of "unscored"
    expect(clearedCell.textContent).toBe(unscoredCell.textContent);
    expect(within(clearedCell).getByText("–")).toBeTruthy();
    expect(clearedCell.textContent).not.toMatch(/PU|CN/);
  });
});

// Wiring proof for the pad's `current` prop (ScorePad.test.tsx pins the button's own
// presence/behavior in isolation) — this is the ONE call site that reads the tapped cell's
// result via cellAt and threads it through, so the button shows up live off real grid state.
describe("ScorecardGrid — Clear score", () => {
  it("tapping an already-scored cell opens a pad with Clear score; posting it fires recordScore with { kind: 'cleared' }", () => {
    const recordScore = vi.fn<(golferId: GolferId, hole: number, result: HoleResult) => void>();
    const state = twoPlayerState({ cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 6 }, ANN) } });
    render(<ScorecardGrid state={state} recordScore={recordScore} />);

    fireEvent.click(cellButton("Ann", 1));
    fireEvent.click(screen.getByRole("button", { name: "Clear score" }));

    expect(recordScore).toHaveBeenCalledWith(ANN, 1, { kind: "cleared" });
    expect(screen.queryByRole("dialog")).toBeNull(); // closes on post, same as any other tap
  });

  it("tapping an unscored cell opens a pad with no Clear score button", () => {
    const recordScore = vi.fn();
    render(<ScorecardGrid state={twoPlayerState()} recordScore={recordScore} />);

    fireEvent.click(cellButton("Bo", 1));

    expect(screen.queryByRole("button", { name: "Clear score" })).toBeNull();
  });

  // A stored-cleared cell must read as unscored to the pad too, not just to the grid glyph:
  // cellAt hides cleared cells from every reader, so ScorePad's `current` prop sees `undefined`
  // and shows no Clear score button — pinned directly rather than by inference from the glyph.
  it("tapping a cell whose stored result is cleared opens a pad with no Clear score button", () => {
    const recordScore = vi.fn();
    const state = twoPlayerState({ cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "cleared" }, ANN) } });
    render(<ScorecardGrid state={state} recordScore={recordScore} />);

    fireEvent.click(cellButton("Ann", 1));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear score" })).toBeNull();
  });
});

describe("ScorecardGrid — current hole", () => {
  it("highlights the first hole where not every participant has a cell", () => {
    const state = twoPlayerState({
      cells: {
        [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 4 }, ANN),
        [cellKey(BO, 1)]: scoreCell({ kind: "strokes", strokes: 5 }, BO),
        [cellKey(ANN, 2)]: scoreCell({ kind: "strokes", strokes: 4 }, ANN),
        // Bo hole 2 missing — hole 2 is current.
      },
    });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const row1 = screen.getByRole("row", { name: /^Hole 1/ });
    const row2 = screen.getByRole("row", { name: /^Hole 2/ });
    expect(row1.getAttribute("aria-current")).not.toBe("true");
    expect(row2.getAttribute("aria-current")).toBe("true");
  });

  // Regression: a cleared cell is RETAINED in state.cells (the fold invariant) — a mis-tap
  // undone on the current hole must bring the highlight BACK to that hole, not leave it
  // pointing past a hole that now needs re-entry. currentHoleNumber must read through cellAt
  // (which hides cleared cells), never a raw key-presence check on `cells`.
  it("clearing a cell on the current hole moves the highlight back to that hole", () => {
    const state = twoPlayerState({
      cells: {
        [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 4 }, ANN),
        [cellKey(BO, 1)]: scoreCell({ kind: "strokes", strokes: 5 }, BO),
        // Both players scored hole 1, so hole 2 would be current if hole 1 stayed "done"...
        [cellKey(ANN, 2)]: scoreCell({ kind: "cleared" }, ANN),
        // ...but Ann's hole-2 cell was cleared (a mis-tap undone) — hole 2 must be current again.
        [cellKey(BO, 2)]: scoreCell({ kind: "strokes", strokes: 4 }, BO),
      },
    });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const row1 = screen.getByRole("row", { name: /^Hole 1/ });
    const row2 = screen.getByRole("row", { name: /^Hole 2/ });
    expect(row1.getAttribute("aria-current")).not.toBe("true");
    expect(row2.getAttribute("aria-current")).toBe("true");
  });
});
