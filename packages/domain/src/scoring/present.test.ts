import { describe, expect, it } from "vitest";
import { allowancePhrase, gameKindBlurb, gameKindFits, gameKindLabel, strokePlayTreatment, strokesNote } from "./present.js";

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

describe("allowancePhrase", () => {
  it("reads the default as standard, in percent words", () => {
    expect(allowancePhrase("skins")).toBe("Full handicap (standard)");
    expect(allowancePhrase("singles-match", undefined)).toBe("Full handicap (standard)");
    expect(allowancePhrase("stableford")).toBe("95% handicap (standard)");
    expect(allowancePhrase("fourball-match")).toBe("90% handicap (standard)");
  });
  it("an explicit allowance equal to the default is still standard", () => {
    expect(allowancePhrase("stableford", 0.95)).toBe("95% handicap (standard)");
  });
  it("a changed allowance reads adjusted — including full handicap where full isn't the default", () => {
    expect(allowancePhrase("stableford", 0.85)).toBe("85% handicap (adjusted)");
    expect(allowancePhrase("stroke-play", 1)).toBe("Full handicap (adjusted)");
  });
});

describe("strokePlayTreatment", () => {
  it("net reads the allowance phrase, prefixed", () => {
    expect(strokePlayTreatment("net")).toBe("Net — 95% handicap (standard)");
    expect(strokePlayTreatment("net", 0.85)).toBe("Net — 85% handicap (adjusted)");
  });
  it("gross has no allowance at all, by definition", () => {
    expect(strokePlayTreatment("gross")).toBe("Gross — raw scores, no strokes");
    expect(strokePlayTreatment("gross", 0.85)).toBe("Gross — raw scores, no strokes");
  });
});

describe("strokesNote", () => {
  it("explains the two kinds whose strokes are relative to another player, not just your own handicap", () => {
    expect(strokesNote("singles-match")).toBe("Match play uses the difference — only the higher handicap gets strokes.");
    expect(strokesNote("fourball-match")).toBe("Four-ball plays everyone off the lowest handicap.");
  });
  it("stays undefined for the three kinds whose strokes need no extra explanation", () => {
    expect(strokesNote("stroke-play")).toBeUndefined();
    expect(strokesNote("stableford")).toBeUndefined();
    expect(strokesNote("skins")).toBeUndefined();
  });
});
