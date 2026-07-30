import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { GameConfig } from "./game.js";
import { gameKindBlurb, gameKindFits, gameKindLabel, gameTreatment, strokesNote, underPar } from "./present.js";

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
  // NOT "uses the strokes on the card" (spec §3's first wording, corrected in §11): the card shows
  // each player's FULL number and a game shows the difference from its own field's lowest, so that
  // line was false for any game played by a subset of the roster.
  it("states the net treatment as the game's own field, with no percentage and no card claim", () => {
    expect(gameTreatment(strokePlay("net"))).toBe("Net — everyone plays off the lowest in this game");
    expect(gameTreatment(skins("net"))).toBe("Net — everyone plays off the lowest in this game");
    expect(gameTreatment(stableford)).toBe("Net — everyone plays off the lowest in this game");
  });
  it("names the field for the two kinds whose field is not simply everyone in the game", () => {
    expect(gameTreatment(singles)).toBe("Strokes are the difference between you two");
    expect(gameTreatment(fourball)).toBe("Everyone plays off the lowest of the four");
  });
  it("gross has no strokes at all, by definition — on either kind that offers the choice", () => {
    expect(gameTreatment(strokePlay("gross"))).toBe("Gross — raw scores, no strokes");
    expect(gameTreatment(skins("gross"))).toBe("Gross — raw scores, no strokes");
  });
});

describe("strokesNote", () => {
  it("names WHO RECEIVES for the two match kinds — the fact their treatment line doesn't carry", () => {
    // Neither says "plays off scratch" (controller ruling, post-task-1): handicap-era vocabulary
    // for playing to par, and false about an anchor who is simply the lowest in the field.
    expect(strokesNote("singles-match")).toBe("Only the higher number gets strokes — the lower gets none.");
    expect(strokesNote("fourball-match")).toBe("Only the three higher numbers get strokes — the lowest gets none.");
  });
  it("stays undefined for the three kinds whose treatment line already states their field", () => {
    // The net treatment line IS "everyone plays off the lowest in this game" — a note repeating it
    // would render the same sentence twice under the same heading.
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
