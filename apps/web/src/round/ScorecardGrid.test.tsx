import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cellKey, deviceId, fieldDeck18, fixtureLinks, fixtureLinks18, fixtureWhite18, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, GameState, GolferId, HoleResult, Participant, RoundState, ScoreCell } from "@swng/domain";
import { gameDots } from "./dots";
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
    render(<ScorecardGrid state={twoPlayerState()} activeGame={undefined} recordScore={recordScore} />);

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
    render(<ScorecardGrid state={twoPlayerState()} activeGame={undefined} recordScore={recordScore} />);

    fireEvent.click(cellButton("Ann", 2));
    fireEvent.click(screen.getByRole("button", { name: "Picked up" }));

    expect(recordScore).toHaveBeenCalledWith(ANN, 2, { kind: "picked-up" });
  });

  it("scoring for ANOTHER golfer posts their golferId, not the tapper's own", () => {
    const recordScore = vi.fn();
    render(<ScorecardGrid state={twoPlayerState()} activeGame={undefined} recordScore={recordScore} />);

    fireEvent.click(cellButton("Bo", 3));
    fireEvent.click(screen.getByRole("button", { name: "4" }));

    expect(recordScore).toHaveBeenCalledWith(BO, 3, { kind: "strokes", strokes: 4 });
  });

  it("correcting an already-filled cell is still exactly 2 taps and posts the new value", () => {
    const recordScore = vi.fn();
    const state = twoPlayerState({ cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 6 }, ANN) } });
    render(<ScorecardGrid state={state} activeGame={undefined} recordScore={recordScore} />);

    // The filled cell already shows the prior gross score...
    expect(within(cellButton("Ann", 1)).getByText("6")).toBeTruthy();

    fireEvent.click(cellButton("Ann", 1));
    fireEvent.click(screen.getByRole("button", { name: "3" }));

    expect(recordScore).toHaveBeenCalledWith(ANN, 1, { kind: "strokes", strokes: 3 });
  });
});

describe("ScorecardGrid — dots", () => {
  it("with zero games, cells show plain gross and no dot glyphs", () => {
    const state = twoPlayerState({ cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 5 }, ANN) } });
    render(<ScorecardGrid state={state} activeGame={undefined} recordScore={vi.fn()} />);

    const cell = cellButton("Ann", 1);
    expect(within(cell).getByText("5")).toBeTruthy();
    expect(cell.textContent).not.toMatch("●");
  });

  it("renders the active fourball game's relative dots — Ann gets 1 dot on each of SI 1–5 of fixtureWhite18, none elsewhere", () => {
    const { players, fourball } = fieldDeck18;
    const state: RoundState = {
      id: roundId("round-2"),
      status: "live",
      card: fixtureLinks18,
      participants: players,
      games: [fourball],
      cells: {},
      terminatedGameIds: new Set(),
    };
    const activeGame: GameState = { kind: "fourball-match", id: fourball.id, up: 0, thru: 0, remaining: 18, dormie: false };

    render(<ScorecardGrid state={state} activeGame={activeGame} recordScore={vi.fn()} />);

    const expectedAnnDots = gameDots(fourball, players, fixtureLinks18).get(players[0]!.golferId)!;
    const dottedHoles = fixtureWhite18.holes.filter((h) => h.strokeIndex <= 5).map((h) => h.number);
    expect(dottedHoles).toHaveLength(5);

    for (const hole of fixtureWhite18.holes) {
      const cell = cellButton("Ann", hole.number);
      const expectedDots = expectedAnnDots.get(hole.number) ?? 0;
      if (expectedDots > 0) {
        expect(cell.textContent).toMatch("●".repeat(expectedDots));
      } else {
        expect(cell.textContent).not.toMatch("●");
      }
    }
  });

  it("shows net small alongside gross where dots apply", () => {
    const { players, fourball } = fieldDeck18;
    // Ann's SI-1 hole (hole 2, per fixtureWhite18) — she has a dot there per the fourball's
    // relative allocation (Ann 5 dots on SI 1–5).
    const state: RoundState = {
      id: roundId("round-3"),
      status: "live",
      card: fixtureLinks18,
      participants: players,
      games: [fourball],
      cells: { [cellKey(players[0]!.golferId, 2)]: scoreCell({ kind: "strokes", strokes: 5 }, players[0]!.golferId) },
      terminatedGameIds: new Set(),
    };
    const activeGame: GameState = { kind: "fourball-match", id: fourball.id, up: 0, thru: 0, remaining: 18, dormie: false };

    render(<ScorecardGrid state={state} activeGame={activeGame} recordScore={vi.fn()} />);

    const cell = cellButton("Ann", 2);
    expect(within(cell).getByText("5")).toBeTruthy(); // gross
    expect(within(cell).getByText("4")).toBeTruthy(); // net = 5 - 1 dot
  });

  // A plus handicap (course handicap below 0) GIVES a stroke back rather than receiving one. Before
  // this it drew nothing at all (the `dots > 0` guard) — now it renders through strokeGrant as a
  // hollow ○, and the net reads gross + 1 (net = gross − dots, and dots is negative here). In skins
  // (full allowance) a -1 course handicap allocates exactly one give-back on the easiest hole (SI 18).
  it("renders a plus player's GIVEN stroke as a hollow ○ with net = gross + 1 (the give-back finally on the screen)", () => {
    const annPlus = participant(ANN, "Ann", "white", -1); // a plus handicap: gives a stroke back
    const boScratch = participant(BO, "Bo", "white", 0);
    const skins: GameConfig = { kind: "skins", id: gameId("skins"), players: [ANN, BO] };
    const si18Hole = fixtureWhite18.holes.find((h) => h.strokeIndex === 18)!; // the easiest hole — where a single give-back lands
    const state: RoundState = {
      id: roundId("round-giveback"),
      status: "live",
      card: fixtureLinks18,
      participants: [annPlus, boScratch],
      games: [skins],
      cells: { [cellKey(ANN, si18Hole.number)]: scoreCell({ kind: "strokes", strokes: 5 }, ANN) },
      terminatedGameIds: new Set(),
    };
    const activeGame: GameState = { kind: "skins", id: skins.id, lines: [], carrying: 0, carriedOut: 0, complete: false, holesDecided: 0 };

    // The domain allocates exactly one give-back (-1) on the SI-18 hole for a -1 course handicap.
    expect(gameDots(skins, state.participants, fixtureLinks18).get(ANN)!.get(si18Hole.number)).toBe(-1);

    render(<ScorecardGrid state={state} activeGame={activeGame} recordScore={vi.fn()} />);

    const cell = cellButton("Ann", si18Hole.number);
    expect(cell.textContent).toMatch("○"); // a GIVEN stroke draws hollow...
    expect(cell.textContent).not.toMatch("●"); // ...never a filled received-stroke glyph
    expect(within(cell).getByText("5")).toBeTruthy(); // gross
    expect(within(cell).getByText("6")).toBeTruthy(); // net = 5 − (−1) = gross + 1
  });

  it("a player whose relative playing handicap is 19+ gets a second dot on the SI-1 hole, but only one on SI-18", () => {
    // singles-match plays full (100%) allowance and its dots are relative — chHigh - chLow —
    // so a 19-course-handicap gap against a 0-handicap opponent lands Bo's relative playing
    // handicap at 19: allocateStrokes' "one lap + 1 extra" rule (strokes.ts) puts that 19th
    // stroke on the hardest hole (SI 1), the only hole on an 18-hole card that gets 2 dots.
    const ann0 = participant(ANN, "Ann", "white", 0);
    const bo19 = participant(BO, "Bo", "white", 19);
    const singles: GameConfig = { kind: "singles-match", id: gameId("singles"), a: ANN, b: BO };
    const state: RoundState = {
      id: roundId("round-4"),
      status: "live",
      card: fixtureLinks18,
      participants: [ann0, bo19],
      games: [singles],
      cells: {},
      terminatedGameIds: new Set(),
    };
    const activeGame: GameState = { kind: "singles-match", id: singles.id, up: 0, thru: 0, remaining: 18, dormie: false };

    render(<ScorecardGrid state={state} activeGame={activeGame} recordScore={vi.fn()} />);

    const expectedBoDots = gameDots(singles, state.participants, fixtureLinks18).get(BO)!;
    const si1Hole = fixtureWhite18.holes.find((h) => h.strokeIndex === 1)!;
    const si18Hole = fixtureWhite18.holes.find((h) => h.strokeIndex === 18)!;
    expect(expectedBoDots.get(si1Hole.number)).toBe(2);
    expect(expectedBoDots.get(si18Hole.number)).toBe(1);

    expect(cellButton("Bo", si1Hole.number).textContent).toMatch("●●");
    expect(cellButton("Bo", si18Hole.number).textContent).toMatch("●");
    expect(cellButton("Bo", si18Hole.number).textContent).not.toMatch("●●");
  });

  // M7 Task 6: terminated games drop out of dots (brief) — a terminated game's chip stays
  // selectable (StandingsHeader keeps it with an "ended" badge), but its grid never shows dots
  // as if it were still consuming scores.
  it("shows no dots for the active game once it's terminated, even though it's still explicitly selected", () => {
    const { players, fourball } = fieldDeck18;
    const state: RoundState = {
      id: roundId("round-terminated"),
      status: "live",
      card: fixtureLinks18,
      participants: players,
      games: [fourball],
      cells: {},
      terminatedGameIds: new Set([fourball.id]),
    };
    const activeGame: GameState = { kind: "fourball-match", id: fourball.id, up: 0, thru: 0, remaining: 18, dormie: false };

    render(<ScorecardGrid state={state} activeGame={activeGame} recordScore={vi.fn()} />);

    for (const hole of fixtureWhite18.holes) {
      expect(cellButton("Ann", hole.number).textContent).not.toMatch("●");
    }
  });
});

describe("ScorecardGrid — readOnly (the archived card, Task 6)", () => {
  it("a cell tap never opens the pad, and recordScore is never called — native disabled, not just an inert recordScore", () => {
    const recordScore = vi.fn();
    const state = twoPlayerState({ cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 4 }, ANN) } });
    render(<ScorecardGrid state={state} activeGame={undefined} recordScore={recordScore} readOnly />);

    expect(cellButton("Ann", 1).hasAttribute("disabled")).toBe(true);
    fireEvent.click(cellButton("Ann", 1));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(recordScore).not.toHaveBeenCalled();
  });

  it("defaults to interactive (readOnly omitted) — every existing live call site is unaffected", () => {
    render(<ScorecardGrid state={twoPlayerState()} activeGame={undefined} recordScore={vi.fn()} />);
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
    render(<ScorecardGrid state={state} activeGame={undefined} recordScore={vi.fn()} />);

    expect(within(cellButton("Ann", 1)).getByText("PU")).toBeTruthy();
    expect(within(cellButton("Bo", 1)).getByText("CN")).toBeTruthy();
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
    render(<ScorecardGrid state={state} activeGame={undefined} recordScore={vi.fn()} />);

    const row1 = screen.getByRole("row", { name: /^Hole 1/ });
    const row2 = screen.getByRole("row", { name: /^Hole 2/ });
    expect(row1.getAttribute("aria-current")).not.toBe("true");
    expect(row2.getAttribute("aria-current")).toBe("true");
  });
});
