import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cellKey, deviceId, fixtureLinks, fixtureLinks18, fixtureWhite, fixtureWhite18, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, GolferId, HoleResult, RosterEntry, RoundState, ScoreCell } from "@swng/domain";
import { ScorecardGrid } from "./ScorecardGrid";

const ANN = golferId("ann");
const BO = golferId("bo");

// The card renders each seat's own asserted strokes (spec 2026-07-30 §2).
const participant = (id: GolferId, name: string, tee: string, strokes: number): RosterEntry => ({
  golferId: id,
  name,
  tee,
  strokes,
});

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
  playedAtMs: 1_000,
  participants: [participant(ANN, "Ann", "white", 8), participant(BO, "Bo", "white", 4)],
  games: [],
  cells: {},
  terminatedGameIds: new Set(),
  holes: "all",
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

// The standard card (spec 2026-07-19 §2a: the card never changes): dots are ALWAYS each player's
// own ROUND strokes allocated by stroke index — no game, no chip selection.
// `ScorecardGridProps` carries no game-typed prop at all; every test below passes only
// `{ state, recordScore }`.
describe("ScorecardGrid — round-stroke dots (the standard card)", () => {
  it("a seat with no strokes shows plain gross and no dot glyphs", () => {
    const state = twoPlayerState({
      participants: [participant(ANN, "Ann", "white", 0), participant(BO, "Bo", "white", 0)],
      cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "strokes", strokes: 5 }, ANN) },
    });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const cell = cellButton("Ann", 1);
    expect(within(cell).getByText("5")).toBeTruthy();
    expect(cell.textContent).not.toMatch("●");
  });

  it("a 5-stroke player shows ● on their 5 hardest SI holes and net = gross − dot under scored cells, with NO game in state", () => {
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

  // The hollow ○ give-back test that stood here is DELETED WITH ITS BRANCH, exactly as its own
  // comment instructed (task 3 restored it deliberately, on the rule that live code gets a test).
  // Nobody gives strokes back (spec 2026-07-30 §2) — the request schema bounds a roster number at
  // 0 and a match subtracts the lowest of its own members — so there is no give-back state left to
  // cover. The one value that could still arrive out of range is covered at the bottom of this
  // file, where the render degrades rather than throwing.

  it("19 strokes get a second dot on the SI-1 hole of an 18-hole card, but only one on SI-18", () => {
    const ann0 = participant(ANN, "Ann", "white", 0);
    const bo19 = participant(BO, "Bo", "white", 19);
    const state: RoundState = {
      id: roundId("round-4"),
      status: "live",
      card: fixtureLinks18,
      playedAtMs: 1_000,
      participants: [ann0, bo19],
      games: [],
      cells: {},
      terminatedGameIds: new Set(),
      holes: "all",
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

  // A pad opened while the card was live is still mounted — and still posts — when readOnly is
  // raised UNDER it. Disabling the cells alone leaves that hole open, which matters for the live
  // caller that raises the flag mid-session: RoundPage locks the card for the duration of a
  // finalize attempt, and a score posted from a pad that survived the lock would push after
  // `round-finalized` and be refused forever.
  it("an already-open pad closes when readOnly is raised under it — the flag covers the pad, not just the cells", () => {
    const recordScore = vi.fn();
    const { rerender } = render(<ScorecardGrid state={twoPlayerState()} recordScore={recordScore} />);

    fireEvent.click(cellButton("Ann", 1));
    expect(screen.getByRole("dialog", { name: "Score for Ann, hole 1" })).toBeTruthy();

    rerender(<ScorecardGrid state={twoPlayerState()} recordScore={recordScore} readOnly />);

    expect(screen.queryByRole("dialog", { name: "Score for Ann, hole 1" })).toBeNull();
    expect(recordScore).not.toHaveBeenCalled();
  });
});

describe("ScorecardGrid — picked-up glyph", () => {
  it("a picked-up cell shows PU, not a bare numeric gross", () => {
    const state = twoPlayerState({
      cells: {
        [cellKey(ANN, 1)]: scoreCell({ kind: "picked-up" }, ANN),
        [cellKey(BO, 1)]: scoreCell({ kind: "strokes", strokes: 5 }, BO),
      },
    });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    expect(within(cellButton("Ann", 1)).getByText("PU")).toBeTruthy();
    expect(within(cellButton("Bo", 1)).getByText("5")).toBeTruthy();
  });

  it("a scored hole renders its net sub-line and under-par ink together", () => {
    // The standard card is roundStrokeAllocation — each player's own roster strokes allocated
    // directly by stroke index, never a difference (that is a MATCH game's rule, and it lives in
    // gameStrokeAllocation). Ann's 8 strokes land one dot on every hole except
    // fixtureWhite's easiest (SI 9, hole 3) — hole 2 is SI1, so Ann carries a dot there.
    const ann8 = participant(ANN, "Ann", "white", 8);
    const bo0 = participant(BO, "Bo", "white", 0);
    // Hole 2 is par 4 (fixtureWhite) — a 3 is a birdie gross AND nets to 2 (3 − 1 dot), also
    // under par, so both inks are exercised, not just the number.
    const state = twoPlayerState({
      participants: [ann8, bo0],
      cells: { [cellKey(ANN, 2)]: scoreCell({ kind: "strokes", strokes: 3 }, ANN) },
    });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const cell = cellButton("Ann", 2);
    const grossGlyph = within(cell).getByText("3");
    expect(grossGlyph.className).toMatch(/text-oxblood/); // gross 3 is under par 4
    expect(within(cell).getByText("2")).toBeTruthy(); // net = 3 − 1 dot
    const netLine = within(cell).getByText("2");
    expect(netLine.className).toMatch(/text-oxblood/); // net 2 is also under par 4
  });
});

describe("ScorecardGrid — cleared cells", () => {
  // A mis-tap undone: cellAt (round/state.ts) hides a cleared cell from every reader — the grid
  // renders it exactly like a genuinely-unscored cell, with no extra branch of its own.
  it("a cleared cell renders identically to an unscored cell — no PU/numeric glyph, just the placeholder", () => {
    const ann0 = participant(ANN, "Ann", "white", 0);
    const bo0 = participant(BO, "Bo", "white", 0);
    const state = twoPlayerState({ participants: [ann0, bo0], cells: { [cellKey(ANN, 1)]: scoreCell({ kind: "cleared" }, ANN) } });
    render(<ScorecardGrid state={state} recordScore={vi.fn()} />);

    const clearedCell = cellButton("Ann", 1);
    const unscoredCell = cellButton("Bo", 1); // Bo has no cell for hole 1 at all — the ground truth of "unscored"
    expect(clearedCell.textContent).toBe(unscoredCell.textContent);
    expect(within(clearedCell).getByText("–")).toBeTruthy();
    expect(clearedCell.textContent).not.toMatch(/PU/);
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

// The card totals like any paper scorecard: OUT (front nine), IN (back nine, omitted on a
// 9-hole card) and TOT, each carrying the hole column's par sum and every player's own gross
// over net.
describe("ScorecardGrid — totals (OUT/IN/TOT)", () => {
  const BLAINE = golferId("blaine");

  // One 18-hole card, one participant ("Blaine"), 24 strokes over the card's 72 par (96 gross
  // total) — the exact per-hole numbers don't matter beyond summing to 96/51/45; only the
  // OUT/IN/TOT totals are under test. strokes: 20 gives a total-dots sum of 20 across the whole
  // card (dotsByHole's own documented invariant: its allocation always sums exactly to its input
  // strokes), so TOT net = 96 − 20 = 76.
  const fullCardStrokes: Readonly<Record<number, number>> = {
    1: 6, 2: 6, 3: 5, 4: 7, 5: 6, 6: 5, 7: 5, 8: 6, 9: 5, // OUT: par 36 + 15 = 51
    10: 5, 11: 4, 12: 6, 13: 5, 14: 5, 15: 6, 16: 4, 17: 5, 18: 5, // IN: par 36 + 9 = 45
  };
  const fullCardCells: Record<string, ScoreCell> = Object.fromEntries(
    Object.entries(fullCardStrokes).map(([hole, strokes]) => [cellKey(BLAINE, Number(hole)), scoreCell({ kind: "strokes", strokes }, BLAINE)]),
  );
  const stateWithFullCard: RoundState = {
    id: roundId("round-totals"),
    status: "live",
    card: fixtureLinks18,
    playedAtMs: 1_000,
    participants: [participant(BLAINE, "Blaine", "white", 20)],
    games: [],
    cells: fullCardCells,
    terminatedGameIds: new Set(),
    holes: "all",
  };

  it("totals the card like a scorecard — OUT, IN and TOT each carry their own par/gross/net", () => {
    render(<ScorecardGrid state={stateWithFullCard} recordScore={() => {}} />);

    // strokes: 20 on an 18-hole card → base 1 dot/hole + the remainder (2) to the two hardest SI
    // holes (fixtureWhite18's SI1 is hole 2, front nine; SI2 is hole 10, back nine) — one extra
    // dot lands in EACH segment, so OUT and IN each carry 10 of the 20 total dots.
    const out = within(screen.getByRole("row", { name: "OUT" }));
    expect(out.getByText("Par 36")).toBeTruthy();
    expect(out.getByText("51")).toBeTruthy(); // Blaine gross, front nine
    expect(out.getByText("41")).toBeTruthy(); // net = 51 − 10 dots

    const inRow = within(screen.getByRole("row", { name: "IN" }));
    expect(inRow.getByText("Par 36")).toBeTruthy();
    expect(inRow.getByText("45")).toBeTruthy(); // Blaine gross, back nine
    expect(inRow.getByText("35")).toBeTruthy(); // net = 45 − 10 dots

    const tot = within(screen.getByRole("row", { name: "TOT" }));
    expect(tot.getByText("Par 72")).toBeTruthy();
    expect(tot.getByText("96")).toBeTruthy(); // Blaine gross
    expect(tot.getByText("76")).toBeTruthy(); // Blaine net
  });

  // Review fix (task-4 fix round 1): a picked-up (or otherwise undecided) hole must dash ONLY the
  // segment(s) that actually contain it — a sibling segment with a fully decided card still
  // totals normally. Hole 3 sits in OUT, so OUT (containing it) and TOT (containing everything)
  // both dash, while IN — fully scored, untouched by the pickup — still shows real numbers. No
  // information is lost for IN; nothing is fabricated for OUT/TOT.
  it("a picked-up hole dashes its own segment and TOT, but a fully-scored sibling segment still totals", () => {
    const ann2: RosterEntry = { golferId: ANN, name: "Ann", tee: "white", strokes: 2 };
    const parOf = (holeNumber: number): number => fixtureWhite18.holes.find((h) => h.number === holeNumber)!.par;
    const cells: Record<string, ScoreCell> = {};
    for (const hole of fixtureWhite18.holes) {
      cells[cellKey(ANN, hole.number)] = hole.number === 3 ? scoreCell({ kind: "picked-up" }, ANN) : scoreCell({ kind: "strokes", strokes: parOf(hole.number) }, ANN);
    }
    const state: RoundState = { id: roundId("round-scoped-dash"), status: "live", card: fixtureLinks18, playedAtMs: 1_000, participants: [ann2], games: [], cells, terminatedGameIds: new Set(), holes: "all" };

    render(<ScorecardGrid state={state} recordScore={() => {}} />);

    expect(within(screen.getByRole("row", { name: "OUT" })).getByText("–")).toBeTruthy();
    expect(within(screen.getByRole("row", { name: "TOT" })).getByText("–")).toBeTruthy();

    // strokes: 2 → the two hardest SI holes get a dot (SI1 = hole 2, front; SI2 = hole 10, back);
    // IN carries exactly one of them (hole 10), so IN's own net differs from its gross by 1.
    const inRow = within(screen.getByRole("row", { name: "IN" }));
    expect(inRow.getByText("Par 36")).toBeTruthy();
    expect(inRow.getByText("36")).toBeTruthy(); // gross: every back-nine hole scored at its own par
    expect(inRow.getByText("35")).toBeTruthy(); // net = 36 − 1 dot (hole 10)
  });

  // Review fix (task-4 fix round 1): the brief's own OUT/IN/TOT split, applied literally to a
  // 9-hole card, printed OUT and TOT as byte-identical rows (both cover the same 9 holes) — a
  // confusing duplicate, not a real front/back split. OUT (and IN) only mean something once a card
  // actually has a back nine to split from; TOT alone unambiguously means the whole round.
  it("a 9-hole card has no OUT/IN split — only TOT", () => {
    const state = twoPlayerState({ participants: [participant(ANN, "Ann", "white", 0)], cells: {} });
    render(<ScorecardGrid state={state} recordScore={() => {}} />);

    expect(screen.queryByRole("row", { name: "OUT" })).toBeNull();
    expect(screen.queryByRole("row", { name: "IN" })).toBeNull();
    expect(screen.getByRole("row", { name: "TOT" })).toBeTruthy();
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

// Review fix round 1 (Minor 10): the non-negative invariant has exactly ONE enforcement point,
// `strokesInputSchema`'s `min(0)` at the request ingress — the stored/fold schema is deliberately
// unbounded (Arc A's placement rule), so a value that cannot legitimately exist can still reach a
// fold. This pins the degradation: the render draws no dot rather than throwing RangeError out of
// `"●".repeat(-1)`, which would blank the entire card for every player.
describe("ScorecardGrid — a negative strokes value degrades instead of blanking the card", () => {
  it("renders the card, with no dot span, for a seat whose strokes are negative", () => {
    const state = twoPlayerState({ participants: [participant(ANN, "Ann", "white", -3)] });

    expect(() => render(<ScorecardGrid state={state} recordScore={vi.fn()} />)).not.toThrow();

    // Hole 2 is fixtureLinks' SI 1 — the first hole any positive allocation would dot, so its
    // silence is the strongest available evidence nothing was drawn.
    expect(screen.getByRole("button", { name: "Ann hole 2" }).textContent).not.toMatch(/●/);
    // ...and the card itself is still on screen for every player, which is what a thrown
    // RangeError would have taken away.
    expect(screen.getByRole("button", { name: "Ann hole 1" })).toBeTruthy();
  });
});
