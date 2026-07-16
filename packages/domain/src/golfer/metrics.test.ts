import { describe, expect, it } from "vitest";
import { combineNineHoleDifferentials, computeIndexDetail, swngIndex } from "../handicap/whs.js";
import { roundId } from "../ids.js";
import type { GolferRoundLine } from "./record.js";
import { golferMetrics } from "./metrics.js";

// A minimal 18-hole line — every metric golferMetrics reads (differential for whsIndex, ags +
// par + holes for swngIndex) is overridable; the rest is filler the fold never touches.
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

describe("golferMetrics — the read projection (handicap-model legibility spec §2, §9; unrated-courses spec §6)", () => {
  it("computes whsIndex from RATED (differential-bearing) lines only, and swngIndex from every ags-bearing line — a rated-only set makes the two equal (the headline invariant)", () => {
    const ratedThree = [
      line({ ags: 90, differential: 9.0 }),
      line({ ags: 95, differential: 14.0 }),
      line({ ags: 92, differential: 11.0 }),
    ];
    const metrics = golferMetrics(ratedThree);

    const expectedWhs = computeIndexDetail(combineNineHoleDifferentials(ratedThree.map((l) => ({ differential: l.differential!, holes: l.holes }))))!;
    expect(metrics.whsIndex).toEqual({ value: expectedWhs.value, differentialsUsed: expectedWhs.differentialsUsed });
    const expectedSwng = swngIndex(ratedThree)!;
    expect(metrics.swngIndex).toEqual({ value: expectedSwng.value, differentialsUsed: expectedSwng.differentialsUsed });
    // Rated-only: swngIndex uses each line's real differential, same as whsIndex — they agree exactly.
    expect(metrics.swngIndex).toEqual(metrics.whsIndex);
  });

  it("an unrated ags-bearing line reaches swngIndex but NOT whsIndex", () => {
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
    // swngIndex DID move — the unrated round's ags−par pseudo-differential is now in the pool.
    expect(after.swngIndex).not.toEqual(before.swngIndex);
    expect(after.swngIndex).toEqual(
      (() => {
        const s = swngIndex(plusUnrated)!;
        return { value: s.value, differentialsUsed: s.differentialsUsed };
      })(),
    );
  });

  it("a wholly-unrated history yields { swngIndex } with no whsIndex", () => {
    const unratedFour = [line({ ags: 96 }), line({ ags: 101 }), line({ ags: 94 }), line({ ags: 99 })];
    const metrics = golferMetrics(unratedFour);

    expect(metrics.whsIndex).toBeUndefined();
    expect(metrics.swngIndex).toBeDefined();
    const s = swngIndex(unratedFour)!;
    expect(metrics.swngIndex).toEqual({ value: s.value, differentialsUsed: s.differentialsUsed });
  });

  it("an empty history yields {} — no whsIndex, no swngIndex", () => {
    expect(golferMetrics([])).toEqual({});
  });
});
