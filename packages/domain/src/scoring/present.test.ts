import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { GameConfig } from "./game.js";
import type { Participant } from "../round/participant.js";
import type { HoleSelection } from "../round/holes.js";
import { nineHoleContribution } from "../golfer/average.js";
import { gameStrokeAllocation, totalDots } from "./allocation.js";
import { fixtureLinks18 } from "./golden/fixtureCourse.js";
import { formatOverPar, formatScoreVsPar, gameKindBlurb, gameKindFits, gameKindLabel, gameTreatment, holeSelectionLabel, strokesNote, underPar } from "./present.js";

const A = golferId("a");
const B = golferId("b");
const C = golferId("c");
const D = golferId("d");
// One config per kind — both sentences read a whole config, not a bare kind: whether a game
// allocates at all is the config's own `scoring` choice, and whose numbers are compared is its own
// field.
const strokePlay = (scoring: "gross" | "net"): GameConfig => ({ kind: "stroke-play", id: gameId("sp"), scoring, players: [A, B] });
const skins = (scoring: "gross" | "net"): GameConfig => ({ kind: "skins", id: gameId("sk"), scoring, players: [A, B] });
const stableford: GameConfig = { kind: "stableford", id: gameId("st"), players: [A, B] };
const singles: GameConfig = { kind: "singles-match", id: gameId("sm"), a: A, b: B };
const fourball: GameConfig = { kind: "fourball-match", id: gameId("fb"), a: [A, B], b: [C, D] };

// A roster seat: name and tee are incidental to gameTreatment, the strokes number is the whole
// subject (the allocation.test.ts precedent).
const participant = (id: ReturnType<typeof golferId>, name: string, strokes: number): Participant => ({ golferId: id, name, tee: "white", strokes });

describe("gameKindLabel", () => {
  it("names every kind in golf's own plainest terms", () => {
    expect(gameKindLabel("stroke-play")).toBe("Stroke play");
    expect(gameKindLabel("singles-match")).toBe("Match play");
    expect(gameKindLabel("stableford")).toBe("Stableford");
    expect(gameKindLabel("fourball-match")).toBe("Four-ball");
    expect(gameKindLabel("skins")).toBe("Skins");
  });
});

// The one label table for which holes a round set out to play (spec 2026-08-02 §6/task 8b) —
// CreateRoundPage's and SetupPanel's own local tables render through this instead of carrying
// their own copies, and the strings pinned here must not move: existing web tests already assert
// them ("18 holes"/"Front 9"/"Back 9").
describe("holeSelectionLabel", () => {
  it("names all three arms in the pinned, existing wording", () => {
    expect(holeSelectionLabel("all")).toBe("18 holes");
    expect(holeSelectionLabel("front")).toBe("Front 9");
    expect(holeSelectionLabel("back")).toBe("Back 9");
  });

  // The idiom this repo uses for a runtime value that bypasses the type system (scoreGame's own
  // "unknown-game-kind", resultOf's "unknown-game-kind") — throw, don't fall back. SetupPanel's
  // retired `?? "18 holes"` would have rendered the WRONG label for a future fourth arm instead of
  // surfacing the gap.
  it("throws on a selection outside the known three, rather than falling back to a default label", () => {
    expect(() => holeSelectionLabel("nine" as unknown as HoleSelection)).toThrow();
  });
});

describe("gameKindBlurb", () => {
  it("teaches each game in one plain line", () => {
    expect(gameKindBlurb("stroke-play")).toBe("Classic card golf — lowest total score wins.");
    expect(gameKindBlurb("singles-match")).toBe("Head-to-head, hole by hole. Win more holes to win the match.");
    expect(gameKindBlurb("stableford")).toBe("Points every hole — one blow-up hole can't sink you. Most points wins.");
    expect(gameKindBlurb("fourball-match")).toBe("2 v 2 — each side counts its better ball, hole by hole.");
    expect(gameKindBlurb("skins")).toBe("Every hole is worth a skin. Win the hole outright to take it — ties carry it to the next hole.");
  });
});

describe("gameKindFits", () => {
  it("states who each game fits", () => {
    expect(gameKindFits("singles-match")).toBe("2 players");
    expect(gameKindFits("fourball-match")).toBe("4 players");
    expect(gameKindFits("stroke-play")).toBe("2+ players");
    expect(gameKindFits("stableford")).toBe("2+ players");
    expect(gameKindFits("skins")).toBe("2+ players");
  });
});

describe("gameTreatment", () => {
  // A card is absolute, a match is relative (spec 2026-07-30 §3) — two true sentences, not one
  // softened to cover both. The medal kinds (stroke play, Stableford, skins) use each player's own
  // roster number, so their line names the CARD; a match uses the difference, so its line names
  // the DIFFERENCE.
  it("says a medal game uses the strokes on the card", () => {
    expect(gameTreatment({ kind: "skins", id: gameId("g"), scoring: "net", players: [] }, [])).toBe("Net — uses the strokes on the card");
  });
  it("states the medal treatment identically across every net kind — one sentence, not per-kind drift", () => {
    expect(gameTreatment(strokePlay("net"), [])).toBe("Net — uses the strokes on the card");
    expect(gameTreatment(skins("net"), [])).toBe("Net — uses the strokes on the card");
    expect(gameTreatment(stableford, [])).toBe("Net — uses the strokes on the card");
  });
  it("gross has no strokes at all, by definition — on either kind that offers the choice", () => {
    expect(gameTreatment(strokePlay("gross"), [])).toBe("Gross — raw scores, no strokes");
    expect(gameTreatment(skins("gross"), [])).toBe("Gross — raw scores, no strokes");
  });
  it("says a match is played off the difference", () => {
    // `a`/`b` are 2-tuples on FourballOutcome's own GameConfig arm, not bare arrays — filled with
    // placeholder ids here since this line reads no roster at all (it's fixed by kind alone).
    expect(gameTreatment({ kind: "fourball-match", id: gameId("f"), a: [A, B], b: [C, D] }, [])).toBe("Played off the difference — everyone off the lowest of the four");
  });
  it("four-ball names the fixed rule from the config alone — no roster needed, unlike singles", () => {
    expect(gameTreatment(fourball, [])).toBe("Played off the difference — everyone off the lowest of the four");
  });
  it("singles names who receives and how many, from the roster's own strokes", () => {
    const participants = [participant(A, "Ann", 6), participant(B, "Bo", 2)];
    expect(gameTreatment(singles, participants)).toBe("Played off the difference — Ann gets 4");
  });
  it("flips which side receives when b is the higher number", () => {
    const participants = [participant(A, "Ann", 2), participant(B, "Bo", 6)];
    expect(gameTreatment(singles, participants)).toBe("Played off the difference — Bo gets 4");
  });
  // Not "Bo gets 0" — the SeasonPanel precedent (crews/SeasonPanel.tsx): a tie is a real, honest
  // answer, and "{name} gets 0" reads as a nonsensical sentence once strokes are a real count.
  it("says the level truth for equal strokes — never '{name} gets 0'", () => {
    const participants = [participant(A, "Ann", 5), participant(B, "Bo", 5)];
    expect(gameTreatment(singles, participants)).toBe("Played off the difference — level, nobody receives");
  });
  // The roster is a REQUIRED argument now (whole-branch review Minor 5), so an empty one is a
  // deliberate statement by the caller rather than something a forgotten argument produces.
  it("degrades to the level line rather than crashing when the roster handed in is empty", () => {
    expect(gameTreatment(singles, [])).toBe("Played off the difference — level, nobody receives");
  });
});

describe("strokesNote", () => {
  it("states the general RULE for the two match kinds — gameTreatment's own singles arm names the concrete instance instead", () => {
    // Neither says "plays off scratch" (controller ruling, post-task-1): handicap-era vocabulary
    // for playing to par, and false about a golfer who is simply the lowest in the field.
    const pair = [participant(A, "Ann", 6), participant(B, "Bo", 2)];
    expect(strokesNote(singles, pair)).toBe("Only the higher number gets strokes — the lower gets none.");
    const four = [participant(A, "Ann", 20), participant(B, "Bo", 10), participant(C, "Cy", 5), participant(D, "Dee", 0)];
    expect(strokesNote(fourball, four)).toBe("Only the numbers above the lowest get strokes — the lowest gets none.");
  });

  // Whole-branch review I1. Every seat starts on 0 (spec 2026-07-30 §2), so this IS the state of
  // every four-ball the moment it is added — and the old sentence ("only the three higher numbers
  // get strokes") asserted that three people were receiving when nobody was, directly under a
  // strokes line saying everyone plays level. Nothing to say is the honest answer.
  it("says NOTHING when every member is level — including the all-zeros default of a fresh round", () => {
    const level = [participant(A, "Ann", 0), participant(B, "Bo", 0), participant(C, "Cy", 0), participant(D, "Dee", 0)];
    expect(strokesNote(fourball, level)).toBeUndefined();
    expect(strokesNote(singles, level)).toBeUndefined();
    // Level at a real number is the same answer: two players who both typed 20 give each other none.
    const both20 = [participant(A, "Ann", 20), participant(B, "Bo", 20)];
    expect(strokesNote(singles, both20)).toBeUndefined();
  });

  // The four-ball wording states a RULE, never a count, because a bottom TIE is ordinary: at
  // 20/20/10/10 exactly two of the four receive, so "the three higher numbers" was false.
  it("stays true for a four-ball tied at the bottom, where only two of the four receive", () => {
    const tied = [participant(A, "Ann", 20), participant(B, "Bo", 20), participant(C, "Cy", 10), participant(D, "Dee", 10)];
    expect(strokesNote(fourball, tied)).toBe("Only the numbers above the lowest get strokes — the lowest gets none.");
  });

  // The reuse proof (the unresolvedGames precedent): the sentence claims exactly the set
  // gameStrokeAllocation actually gives dots to. Run the REAL allocation over the same tied field
  // and check the two agree — so a change to the allocation rule can't leave the copy behind.
  it("names exactly the players gameStrokeAllocation gives dots to — the copy can't drift from the dots", () => {
    const tied = [participant(A, "Ann", 20), participant(B, "Bo", 20), participant(C, "Cy", 10), participant(D, "Dee", 10)];
    const allocation = gameStrokeAllocation(fourball, tied, fixtureLinks18, "all");
    const receiving = tied.filter((p) => totalDots(allocation.get(p.golferId) ?? new Map()) > 0).map((p) => p.golferId);
    expect(receiving).toEqual([A, B]); // two, not three — the count the old sentence asserted
    const lowest = Math.min(...tied.map((p) => p.strokes));
    expect(tied.filter((p) => p.strokes > lowest).map((p) => p.golferId)).toEqual(receiving);
    expect(strokesNote(fourball, tied)).toBeDefined(); // somebody receives, so there is something to say
  });

  it("stays undefined for the three kinds whose treatment line already states their field", () => {
    // The net treatment line IS "Net — uses the strokes on the card" — a note repeating it would
    // render the same sentence twice under the same heading.
    const two = [participant(A, "Ann", 6), participant(B, "Bo", 2)];
    expect(strokesNote(strokePlay("net"), two)).toBeUndefined();
    expect(strokesNote(stableford, two)).toBeUndefined();
    expect(strokesNote(skins("net"), two)).toBeUndefined();
  });
});

describe("underPar", () => {
  it("underPar is golf's red-numbers convention: strictly below par", () => {
    expect(underPar(3, 4)).toBe(true);
    expect(underPar(4, 4)).toBe(false);
    expect(underPar(5, 4)).toBe(false);
  });
});

// Task-5 fix round (spec 2026-07-30 §10 review): the one formatter for a raw (score, par) pair,
// so RecordSections.tsx's history row never subtracts `score - par` inline again.
describe("formatScoreVsPar", () => {
  it("formats a raw (score, par) pair through formatOverPar", () => {
    expect(formatScoreVsPar(76, 72)).toBe("+4");
    expect(formatScoreVsPar(70, 72)).toBe("-2");
    expect(formatScoreVsPar(72, 72)).toBe("E");
  });

  // The nine-hole "counts" line feeds THIS SAME helper with each input pre-doubled via
  // nineHoleContribution separately, rather than doubling their difference — proving the
  // distributivity the present.ts comment claims: nineHoleContribution(score) -
  // nineHoleContribution(par) equals nineHoleContribution(score - par). All three signed cases
  // pinned (task-5 fix round 3 review) — over par, under par, and level — not just the positive
  // one.
  it("composes with nineHoleContribution applied per-input to match the doubled figure", () => {
    const doubled = (score: number, par: number) => formatScoreVsPar(nineHoleContribution(score), nineHoleContribution(par));

    // Over par: 47 - 36 = +11, doubled = +22.
    expect(doubled(47, 36)).toBe(formatOverPar(nineHoleContribution(47 - 36)));
    expect(doubled(47, 36)).toBe("+22");

    // Under par: 34 - 36 = -2, doubled = -4.
    expect(doubled(34, 36)).toBe(formatOverPar(nineHoleContribution(34 - 36)));
    expect(doubled(34, 36)).toBe("-4");

    // Level: 36 - 36 = E, doubled = E.
    expect(doubled(36, 36)).toBe(formatOverPar(nineHoleContribution(36 - 36)));
    expect(doubled(36, 36)).toBe("E");
  });
});
