import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { GameConfig } from "./game.js";
import type { Participant } from "../round/participant.js";
import { nineHoleContribution } from "../golfer/average.js";
import { formatOverPar, formatScoreVsPar, gameKindBlurb, gameKindFits, gameKindLabel, gameTreatment, strokesNote, underPar } from "./present.js";

const A = golferId("a");
const B = golferId("b");
const C = golferId("c");
const D = golferId("d");
// One config per kind — gameTreatment reads a whole config now, not a bare kind, because whether a
// game allocates at all is the config's own `scoring` choice. (strokesNote still takes a kind: the
// two kinds it speaks for have no gross arm.)
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
    expect(gameTreatment({ kind: "skins", id: gameId("g"), scoring: "net", players: [] })).toBe("Net — uses the strokes on the card");
  });
  it("states the medal treatment identically across every net kind — one sentence, not per-kind drift", () => {
    expect(gameTreatment(strokePlay("net"))).toBe("Net — uses the strokes on the card");
    expect(gameTreatment(skins("net"))).toBe("Net — uses the strokes on the card");
    expect(gameTreatment(stableford)).toBe("Net — uses the strokes on the card");
  });
  it("gross has no strokes at all, by definition — on either kind that offers the choice", () => {
    expect(gameTreatment(strokePlay("gross"))).toBe("Gross — raw scores, no strokes");
    expect(gameTreatment(skins("gross"))).toBe("Gross — raw scores, no strokes");
  });
  it("says a match is played off the difference", () => {
    // `a`/`b` are 2-tuples on FourballOutcome's own GameConfig arm, not bare arrays — filled with
    // placeholder ids here since this line reads no roster at all (it's fixed by kind alone).
    expect(gameTreatment({ kind: "fourball-match", id: gameId("f"), a: [A, B], b: [C, D] })).toBe("Played off the difference — everyone off the lowest of the four");
  });
  it("four-ball names the fixed rule from the config alone — no roster needed, unlike singles", () => {
    expect(gameTreatment(fourball)).toBe("Played off the difference — everyone off the lowest of the four");
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
  it("degrades to the level line rather than crashing when no roster is supplied at all", () => {
    expect(gameTreatment(singles)).toBe("Played off the difference — level, nobody receives");
  });
});

describe("strokesNote", () => {
  it("states the general RULE for the two match kinds — gameTreatment's own singles arm names the concrete instance instead", () => {
    // Neither says "plays off scratch" (controller ruling, post-task-1): handicap-era vocabulary
    // for playing to par, and false about a golfer who is simply the lowest in the field.
    expect(strokesNote("singles-match")).toBe("Only the higher number gets strokes — the lower gets none.");
    expect(strokesNote("fourball-match")).toBe("Only the three higher numbers get strokes — the lowest gets none.");
  });
  it("stays undefined for the three kinds whose treatment line already states their field", () => {
    // The net treatment line IS "Net — uses the strokes on the card" — a note repeating it would
    // render the same sentence twice under the same heading.
    expect(strokesNote("stroke-play")).toBeUndefined();
    expect(strokesNote("stableford")).toBeUndefined();
    expect(strokesNote("skins")).toBeUndefined();
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
  // nineHoleContribution(par) equals nineHoleContribution(score - par).
  it("composes with nineHoleContribution applied per-input to match the doubled figure", () => {
    const doubled = formatScoreVsPar(nineHoleContribution(47), nineHoleContribution(36));
    expect(doubled).toBe(formatOverPar(nineHoleContribution(47 - 36)));
    expect(doubled).toBe("+22");
  });
});
