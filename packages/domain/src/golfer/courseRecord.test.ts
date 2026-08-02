import { describe, expect, it } from "vitest";
import { courseId, roundId } from "../ids.js";
import type { GolferHoleLine, GolferRoundLine } from "./record.js";
import { courseRecord } from "./courseRecord.js";

// A minimal course-1 line — holeResults is the one field these folds read at hole level;
// courseId defaults to course-1 so most fixtures need only override roundId/holeResults
// (the analytics.test.ts `line` precedent).
const COURSE = courseId("course-1");
const line = (over: Partial<GolferRoundLine>): GolferRoundLine => ({
  roundId: roundId("r"),
  courseName: "Casa Verde GC",
  courseId: COURSE,
  tee: "white",
  holes: 18,
  par: 72,
  strokes: 8,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  ...over,
});

const stroke = (hole: number, par: number, strokes: number): GolferHoleLine => ({ hole, par, result: { kind: "strokes", strokes } });
const pickedUp = (hole: number, par: number): GolferHoleLine => ({ hole, par, result: { kind: "picked-up" } });

// A fully-scored 18-hole line whose strokes sum to exactly `gross` (par 4 throughout, first
// hole absorbs the remainder) — the analytics.test.ts `roundOf` precedent.
const roundOf = (id: string, gross: number): GolferRoundLine => {
  const rest = 17;
  const holeResults = [stroke(1, 4, gross - 4 * rest), ...Array.from({ length: rest }, (_, i) => stroke(i + 2, 4, 4))];
  return line({ roundId: roundId(id), holeResults });
};

// A fully-scored 9-hole line whose strokes sum to exactly `gross` — the `roundOf` precedent
// (holes: 9, par 36), for the mixed-hole-count test below (round-plays-a-nine spec 2026-08-02).
const nineOf = (id: string, gross: number): GolferRoundLine => {
  const rest = 8;
  const holeResults = [stroke(1, 4, gross - 4 * rest), ...Array.from({ length: rest }, (_, i) => stroke(i + 2, 4, 4))];
  return line({ roundId: roundId(id), holes: 9, par: 36, holeResults });
};

// A line contributing a single decided hole — used to build precise per-hole aggregates without
// needing a full 18-hole card; not fully scored (irrelevant to the hole-level folds, which
// read raw holeResults regardless of round completeness — spec §4's "all decided plays").
const oneHole = (id: string, entry: GolferHoleLine): GolferRoundLine => line({ roundId: roundId(id), holeResults: [entry] });

// A padding line with no holeResults at all — counts toward `rounds` (any state) but must never
// contribute to hole stats, scoringAverage, or best.
const noResults = (id: string): GolferRoundLine => line({ roundId: roundId(id) });

describe("courseRecord — rounds/best/scoringAverage (always present from the 1st round; analytics spec §4)", () => {
  it("filters to the given courseId, ignoring lines at other courses", () => {
    const here = roundOf("r-here", 90);
    const elsewhere = line({ roundId: roundId("r-elsewhere"), courseId: courseId("course-2"), holeResults: [stroke(1, 4, 2)] });

    const record = courseRecord([here, elsewhere], COURSE);

    expect(record.rounds).toBe(1);
    expect(record.best18).toEqual({ roundId: roundId("r-here"), gross: 90, toPar: 18 });
  });

  it("rounds counts lines at this course in ANY state, including one with no holeResults", () => {
    const a = roundOf("r-a", 95);
    const b = noResults("r-b");

    const record = courseRecord([a, b], COURSE);

    expect(record.rounds).toBe(2);
  });

  it("best is the lowest gross among fully-scored lines; a tie goes to the earlier line (strict <, oldest→newest)", () => {
    const earlier = roundOf("r-earlier", 85);
    const later = roundOf("r-later", 85);
    const worse = roundOf("r-worse", 90);

    const record = courseRecord([earlier, later, worse], COURSE);

    expect(record.best18).toEqual({ roundId: roundId("r-earlier"), gross: 85, toPar: 13 });
  });

  it("a line without holeResults counts toward rounds but contributes NO hole stats and can never hold best", () => {
    // 4 fully-scored lines all touching hole 1 with a doubled hole (overPar 2, so ≥3-plays
    // threshold is met) plus a 5th line with no holeResults — rounds reaches the insights gate,
    // but the 5th line must be invisible to best AND to hole 1's aggregation.
    const holed = [90, 95, 100, 80].map((gross, i) => roundOf(`r-holed-${i}`, gross));
    const unresulted = noResults("r-no-results");

    const record = courseRecord([...holed, unresulted], COURSE);

    expect(record.rounds).toBe(5);
    expect(record.best18).toEqual({ roundId: roundId("r-holed-3"), gross: 80, toPar: 8 });
    // hole 1 across the 4 holed lines: strokes = gross-68 = 22,27,32,12 vs par 4 → overPar 18,23,28,8,
    // all doublePlus (≥ par+2) — 4 plays, so hole 1 clears the ≥3 floor from the 4 holed lines
    // alone; the 5th (no-holeResults) line must not have padded or corrupted this count.
    expect(record.insights?.worstHole?.plays).toBe(4);
  });

  it("scoringAverage is the mean gross over fully-scored lines only, rounded to 1 decimal (roundHalfUp) — excludes a picked-up line", () => {
    const a = roundOf("r-a", 90);
    const b = roundOf("r-b", 91);
    // A picked-up hole means the line is NOT fully scored, even though its raw stroke sum
    // (17×4 + 1 = 69) is far lower than a/b's — if wrongly included this would drag the average
    // down hard.
    const pickedUpLine = line({
      roundId: roundId("r-pickedup"),
      holeResults: [...Array.from({ length: 17 }, (_, i) => stroke(i + 1, 4, 4)), pickedUp(18, 4)],
    });

    const record = courseRecord([a, b, pickedUpLine], COURSE);

    // mean(90, 91) = 90.5 → roundHalfUp(905)/10 = 90.5
    expect(record.scoringAverage18).toBe(90.5);
  });

  it("scoringAverage is absent when no line is fully scored", () => {
    const record = courseRecord([noResults("r-a")], COURSE);

    expect(record.scoringAverage18).toBeUndefined();
  });
});

describe("courseRecord — best/scoringAverage split by hole count (round-plays-a-nine spec 2026-08-02, Finding 1)", () => {
  it("a 9-hole and an 18-hole fully-scored line at the same course report separately — never mixed into one number", () => {
    const nine = nineOf("r-nine", 45); // way over par for 18 holes, but a fine back-nine 45
    const eighteen = roundOf("r-eighteen", 92);

    const record = courseRecord([nine, eighteen], COURSE);

    expect(record.best9).toEqual({ roundId: roundId("r-nine"), gross: 45, toPar: 9 });
    expect(record.best18).toEqual({ roundId: roundId("r-eighteen"), gross: 92, toPar: 20 });
    expect(record.scoringAverage9).toBe(45);
    expect(record.scoringAverage18).toBe(92);
  });
});

describe("courseRecord — insights gate (≥5 rounds at the course; analytics spec §4)", () => {
  it("insights is absent below 5 rounds", () => {
    const four = [0, 1, 2, 3].map((i) => noResults(`r-${i}`));

    expect(courseRecord(four, COURSE).insights).toBeUndefined();
  });

  it("insights is present (possibly with no sub-fields) at exactly 5 rounds", () => {
    const five = [0, 1, 2, 3, 4].map((i) => noResults(`r-${i}`));

    const record = courseRecord(five, COURSE);

    expect(record.rounds).toBe(5);
    expect(record.insights).toEqual({});
  });
});

describe("courseRecord — worstHole (highest mean strokes-over-par among ≥3-strokes-play holes; ties → more doublePlus, then lower hole)", () => {
  it("a hole with fewer than 3 strokes-plays never qualifies, even with an extreme average", () => {
    const lines = [
      oneHole("r-0", stroke(1, 4, 14)), // hole 1: only 2 plays, way over par
      oneHole("r-1", stroke(1, 4, 14)),
      oneHole("r-2", stroke(2, 4, 5)), // hole 2: 3 plays, clears the floor
      oneHole("r-3", stroke(2, 4, 5)),
      oneHole("r-4", stroke(2, 4, 5)),
    ];

    const record = courseRecord(lines, COURSE);

    expect(record.insights?.worstHole?.hole).toBe(2);
  });

  it("a mean tie is broken by MORE doublePlus, even against a lower hole number", () => {
    // hole 9 (higher number): 3 plays at overPar 2 each → mean 2, doublePlus 3.
    const nine = [0, 1, 2].map((i) => oneHole(`r-nine-${i}`, stroke(9, 4, 6)));
    // hole 2 (lower number): overPar 4,1,1 → same mean 2, but only 1 doublePlus play.
    const two = [
      oneHole("r-two-0", stroke(2, 4, 8)),
      oneHole("r-two-1", stroke(2, 4, 5)),
      oneHole("r-two-2", stroke(2, 4, 5)),
    ];

    const record = courseRecord([...nine, ...two], COURSE);

    expect(record.insights?.worstHole).toEqual({ hole: 9, par: 4, plays: 3, avgOverPar: 2, doublePlus: 3 });
  });

  it("a mean AND doublePlus tie is broken by the LOWER hole number", () => {
    const holeEight = [0, 1, 2].map((i) => oneHole(`r-eight-${i}`, stroke(8, 4, 6))); // overPar 2,2,2
    const holeThree = [0, 1, 2].map((i) => oneHole(`r-three-${i}`, stroke(3, 4, 6))); // overPar 2,2,2

    const record = courseRecord([...holeEight, ...holeThree], COURSE);

    expect(record.insights?.worstHole?.hole).toBe(3);
  });

  it("par shown is the most recent (last-arriving) line's par for that hole", () => {
    const lines = [
      oneHole("r-0", stroke(5, 4, 8)),
      oneHole("r-1", stroke(5, 4, 8)),
      oneHole("r-2", stroke(5, 5, 9)), // a later card revision reports hole 5 as a par 5
      noResults("r-pad-0"),
      noResults("r-pad-1"), // padding to clear the ≥5-rounds insights gate
    ];

    const record = courseRecord(lines, COURSE);

    expect(record.insights?.worstHole?.par).toBe(5);
  });
});

describe("courseRecord — scoringHole (highest par-or-better rate among ≥3-strokes-play holes; ties → lower hole)", () => {
  it("picks the highest par-or-better rate", () => {
    // hole 4: 3/3 par-or-better.
    const four = [0, 1, 2].map((i) => oneHole(`r-four-${i}`, stroke(4, 4, 4)));
    // hole 6: 1/3 par-or-better (the rest are bogeys).
    const six = [oneHole("r-six-0", stroke(6, 4, 4)), oneHole("r-six-1", stroke(6, 4, 5)), oneHole("r-six-2", stroke(6, 4, 5))];

    const record = courseRecord([...four, ...six], COURSE);

    expect(record.insights?.scoringHole).toEqual({ hole: 4, par: 4, plays: 3, parOrBetter: 3 });
  });

  it("a rate tie is broken by the lower hole number", () => {
    const holeSeven = [oneHole("r-seven-0", stroke(7, 4, 4)), oneHole("r-seven-1", stroke(7, 4, 4)), oneHole("r-seven-2", stroke(7, 4, 5))];
    const holeOne = [oneHole("r-one-0", stroke(1, 4, 4)), oneHole("r-one-1", stroke(1, 4, 4)), oneHole("r-one-2", stroke(1, 4, 5))];

    const record = courseRecord([...holeSeven, ...holeOne], COURSE);

    expect(record.insights?.scoringHole?.hole).toBe(1);
  });
});

describe("courseRecord — neverBirdied (holes with ≥1 strokes-play and zero under-par plays; shown only for 1..3 remaining)", () => {
  it("is omitted when every played hole has been birdied at least once (0 remaining)", () => {
    const lines = [0, 1, 2, 3, 4].map((i) => oneHole(`r-${i}`, stroke(1, 4, 3))); // birdie every time

    const record = courseRecord(lines, COURSE);

    expect(record.insights?.neverBirdied).toBeUndefined();
  });

  it("is omitted when 4 holes remain never-birdied (too many to be noise-free)", () => {
    const holes: GolferHoleLine[] = [stroke(1, 4, 4), stroke(2, 4, 5), stroke(3, 4, 4), stroke(4, 4, 5)];
    const played = line({ roundId: roundId("r-played"), holeResults: holes });
    const padding = [0, 1, 2, 3].map((i) => noResults(`r-pad-${i}`));

    const record = courseRecord([played, ...padding], COURSE);

    expect(record.rounds).toBe(5);
    expect(record.insights?.neverBirdied).toBeUndefined();
  });

  it("is present, sorted ascending, when exactly 3 holes remain never-birdied", () => {
    const holes: GolferHoleLine[] = [stroke(3, 4, 4), stroke(1, 4, 5), stroke(2, 4, 4)];
    const played = line({ roundId: roundId("r-played"), holeResults: holes });
    const padding = [0, 1, 2, 3].map((i) => noResults(`r-pad-${i}`));

    const record = courseRecord([played, ...padding], COURSE);

    expect(record.insights?.neverBirdied).toEqual([1, 2, 3]);
  });

  // aggregateHoles' `if (strokes !== undefined)` guard (courseRecord.ts) — a picked-up hole has no
  // number and must not be counted as a play at all, let alone a birdie. Proven by mutation: scoring
  // a pickup as 0 strokes (a 4-under "birdie" on this par 4) would drop hole 1 out of neverBirdied.
  it("a picked-up hole does not count toward neverBirdied — no number, no play, nothing changes", () => {
    const holes: GolferHoleLine[] = [stroke(3, 4, 4), stroke(1, 4, 5), stroke(2, 4, 4)];
    const played = line({ roundId: roundId("r-played"), holeResults: holes });
    const padding = [0, 1, 2].map((i) => noResults(`r-pad-${i}`));

    const withPickup = courseRecord([played, oneHole("r-later", pickedUp(1, 4)), ...padding], COURSE);
    expect(withPickup.rounds).toBe(5);
    expect(withPickup.insights?.neverBirdied).toEqual([1, 2, 3]);
  });
});
