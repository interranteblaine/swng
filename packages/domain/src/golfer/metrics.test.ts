import { describe, expect, it } from "vitest";
import { combineNineHoleDifferentials, computeIndexDetail, suggestedIndex } from "../handicap/whs.js";
import { roundId } from "../ids.js";
import type { GolferRoundLine } from "./record.js";
import { golferMetrics } from "./metrics.js";

// A minimal 18-hole line — every metric golferMetrics reads (differential for whsIndex, ags +
// par + holes for suggestedIndex) is overridable; the rest is filler the fold never touches.
const line = (over: Partial<GolferRoundLine>): GolferRoundLine => ({
  roundId: roundId("r"),
  courseName: "Casa Verde GC",
  tee: "white",
  holes: 18,
  par: 72,
  courseHandicap: 8,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  ...over,
});

describe("golferMetrics — the read projection (unrated-courses spec §6)", () => {
  it("computes whsIndex from RATED (differential-bearing) lines only, and suggestedIndex from every ags-bearing line", () => {
    const ratedThree = [
      line({ ags: 90, differential: 9.0 }),
      line({ ags: 95, differential: 14.0 }),
      line({ ags: 92, differential: 11.0 }),
    ];
    const metrics = golferMetrics(ratedThree);

    const expectedWhs = computeIndexDetail(combineNineHoleDifferentials(ratedThree.map((l) => ({ differential: l.differential!, holes: l.holes }))))!;
    expect(metrics.whsIndex).toEqual({ value: expectedWhs.value, differentialsUsed: expectedWhs.differentialsUsed });
    const expectedSuggested = suggestedIndex(ratedThree)!;
    expect(metrics.suggestedIndex).toEqual({ value: expectedSuggested.value, differentialsUsed: expectedSuggested.differentialsUsed });
  });

  it("an unrated ags-bearing line reaches suggestedIndex but NOT whsIndex", () => {
    const ratedThree = [
      line({ ags: 90, differential: 9.0 }),
      line({ ags: 95, differential: 14.0 }),
      line({ ags: 92, differential: 11.0 }),
    ];
    // A fourth round on an unrated tee: it carries an ags but no differential.
    const plusUnrated = [...ratedThree, line({ ags: 100 })];

    const before = golferMetrics(ratedThree);
    const after = golferMetrics(plusUnrated);

    // whsIndex is unchanged — the unrated line has no differential, so it never reaches Rule 5.2a.
    expect(after.whsIndex).toEqual(before.whsIndex);
    // suggestedIndex DID move — the unrated round's ags−par pseudo-differential is now in the pool.
    expect(after.suggestedIndex).not.toEqual(before.suggestedIndex);
    expect(after.suggestedIndex).toEqual(
      (() => {
        const s = suggestedIndex(plusUnrated)!;
        return { value: s.value, differentialsUsed: s.differentialsUsed };
      })(),
    );
  });

  it("a wholly-unrated history yields { suggestedIndex } with no whsIndex", () => {
    const unratedFour = [line({ ags: 96 }), line({ ags: 101 }), line({ ags: 94 }), line({ ags: 99 })];
    const metrics = golferMetrics(unratedFour);

    expect(metrics.whsIndex).toBeUndefined();
    expect(metrics.suggestedIndex).toBeDefined();
    const s = suggestedIndex(unratedFour)!;
    expect(metrics.suggestedIndex).toEqual({ value: s.value, differentialsUsed: s.differentialsUsed });
  });

  it("an empty history yields {} — no whsIndex, no suggestedIndex", () => {
    expect(golferMetrics([])).toEqual({});
  });
});
