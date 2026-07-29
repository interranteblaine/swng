import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { GameConfig } from "./game.js";
import { gameKindBlurb, gameKindFits, gameKindLabel, gameTreatment, strokesNote, underPar } from "./present.js";

const A = golferId("a");
const B = golferId("b");
const C = golferId("c");
const D = golferId("d");
// One config per kind — gameTreatment/strokesNote read a whole config now, not a bare kind,
// because whether a game allocates at all is the config's own `scoring` choice.
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
  it("states the net treatment without a percentage — there is no allowance table left", () => {
    expect(gameTreatment(strokePlay("net"))).toBe("Net — uses the strokes on the card");
    expect(gameTreatment(skins("net"))).toBe("Net — uses the strokes on the card");
    expect(gameTreatment(stableford)).toBe("Net — uses the strokes on the card");
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
  it("names WHOSE strokes each net game's field is measured against", () => {
    expect(strokesNote(strokePlay("net"))).toBe("Everyone in this game plays off the lowest in it.");
    expect(strokesNote(stableford)).toBe("Everyone in this game plays off the lowest in it.");
    expect(strokesNote(skins("net"))).toBe("Everyone in this game plays off the lowest in it.");
    expect(strokesNote(singles)).toBe("Only the higher number gets strokes — the lower plays off scratch.");
    expect(strokesNote(fourball)).toBe("All four play off the lowest of the four.");
  });
  it("stays undefined for a gross game — it allocates nothing, so there is no field to describe", () => {
    expect(strokesNote(strokePlay("gross"))).toBeUndefined();
    expect(strokesNote(skins("gross"))).toBeUndefined();
  });
});

describe("underPar", () => {
  it("underPar is golf's red-numbers convention: strictly below par", () => {
    expect(underPar(3, 4)).toBe(true);
    expect(underPar(4, 4)).toBe(false);
    expect(underPar(5, 4)).toBe(false);
  });
});
