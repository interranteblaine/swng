import { describe, expect, it } from "vitest";
import { neverBirdiedPhrase, scoringHolePhrase, worstHolePhrase } from "./present.js";

// Copy is the mockup's, artifact 7a167ca5 (analytics spec 2026-07-21 §4) — pinned verbatim,
// including the typographic apostrophes.
describe("courseRecord phrases (present.ts — fence-allowed, no golf compute)", () => {
  it("worstHolePhrase pluralizes doubledPlus correctly and states avg/doubles/plays", () => {
    expect(worstHolePhrase({ hole: 12, avgOverPar: 1.4, doublePlus: 3, plays: 8 })).toBe(
      "Hole 12 gets you — +1.4 a round; you’ve doubled it 3 times in 8 plays.",
    );
  });

  it("worstHolePhrase keeps the singular \"time\" at doublePlus 1", () => {
    expect(worstHolePhrase({ hole: 5, avgOverPar: 0.6, doublePlus: 1, plays: 6 })).toBe(
      "Hole 5 gets you — +0.6 a round; you’ve doubled it 1 time in 6 plays.",
    );
  });

  it("scoringHolePhrase states the par-or-better count out of plays", () => {
    expect(scoringHolePhrase({ hole: 4, parOrBetter: 6, plays: 9 })).toBe("Hole 4 is your scoring hole — par or better in 6 of 9.");
  });

  it("neverBirdiedPhrase uses singular phrasing for exactly one hole", () => {
    expect(neverBirdiedPhrase([7])).toBe("You’ve never birdied 7.");
  });

  it("neverBirdiedPhrase joins multiple holes with a comma", () => {
    expect(neverBirdiedPhrase([1, 2, 3])).toBe("You’ve never birdied 1, 2, 3.");
  });
});
