import { describe, expect, it } from "vitest";
import { roundId } from "../ids.js";
import type { GolferHoleLine, GolferRoundLine } from "./record.js";
import { bestsOf, fullyHoledOut, milestonesOf } from "./analytics.js";

// A minimal 18-hole line — holeResults is the one field these folds read; the rest is filler
// the analytics folds never touch (line fixtures are plain object literals, no archives needed —
// analytics spec 2026-07-21 §2/§3).
const line = (over: Partial<GolferRoundLine>): GolferRoundLine => ({
  roundId: roundId("r"),
  courseName: "Casa Verde GC",
  tee: "white",
  holes: 18,
  par: 72,
  strokes: 8,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  ...over,
});

const stroke = (hole: number, par: number, strokes: number): GolferHoleLine => ({ hole, par, result: { kind: "strokes", strokes } });
const pickedUp = (hole: number, par: number): GolferHoleLine => ({ hole, par, result: { kind: "picked-up" } });
const conceded = (hole: number, par: number, strokes: number): GolferHoleLine => ({ hole, par, result: { kind: "conceded", strokes } });

// Builds a fully holed-out line of `holes` (9 or 18, par 4 throughout) whose strokes sum to
// exactly `gross` — the first hole absorbs whatever remainder the rest (all par) don't, so the
// per-hole numbers aren't meant to be plausible golf, just a fold input with a pinned total.
const roundOf = (id: string, holes: 9 | 18, gross: number): GolferRoundLine => {
  const par = holes === 18 ? 72 : 36;
  const rest = holes - 1;
  const holeResults = [stroke(1, 4, gross - 4 * rest), ...Array.from({ length: rest }, (_, i) => stroke(i + 2, 4, 4))];
  return line({ roundId: roundId(id), holes, par, holeResults });
};

describe("bestsOf — lowest gross per hole count, fully holed-out lines only (analytics spec §3)", () => {
  it("(a) picks the lowest gross per hole count, ignoring a lower-raw-sum line that has a picked-up hole", () => {
    const full = roundOf("r-a-full", 18, 90); // fully holed out, gross 90
    // 17 holes at 4 strokes (raw sum 68, LOWER than full's 90) plus one picked-up hole — NOT
    // fully holed out despite the deceptively lower stroke sum.
    const pickedUpLine = line({
      roundId: roundId("r-a-pickedup"),
      holes: 18,
      par: 72,
      holeResults: [...Array.from({ length: 17 }, (_, i) => stroke(i + 1, 4, 4)), pickedUp(18, 4)],
    });
    const nine = roundOf("r-a-nine", 9, 36); // the only 9-hole line — best9 computed independently

    expect(bestsOf([full, pickedUpLine, nine])).toEqual({
      best18: { roundId: roundId("r-a-full"), gross: 90, toPar: 18 },
      best9: { roundId: roundId("r-a-nine"), gross: 36, toPar: 0 },
    });
  });

  it("(b) a tie in gross goes to the earlier line (strict < while scanning oldest→newest)", () => {
    const earlier = roundOf("r-b-earlier", 18, 85);
    const later = roundOf("r-b-later", 18, 85);

    expect(bestsOf([earlier, later])).toEqual({ best18: { roundId: roundId("r-b-earlier"), gross: 85, toPar: 13 } });
  });

  it("(c) a line without holeResults is never fully holed out, and contributes to neither bests nor milestones", () => {
    const noResults = line({ roundId: roundId("r-c-no-results"), holes: 18, par: 72 }); // holeResults left undefined

    expect(fullyHoledOut(noResults)).toBe(false);
    expect(bestsOf([noResults])).toEqual({});
    expect(milestonesOf([noResults])).toEqual([]);
  });

  it("(g) empty lines yield {} bests", () => {
    expect(bestsOf([])).toEqual({});
  });
});

describe("milestonesOf — earliest qualifying line per kind, in fixed kind order (analytics spec §3)", () => {
  it("(d) first-birdie is the earliest hole exactly 1-under-par; an eagle-only line does not satisfy it", () => {
    const parLine = line({ roundId: roundId("r-d-par"), holeResults: [stroke(1, 4, 4)] }); // even par
    const eagleLine = line({ roundId: roundId("r-d-eagle"), holeResults: [stroke(1, 4, 2)] }); // -2, eagle only
    const birdieLine = line({ roundId: roundId("r-d-birdie"), holeResults: [stroke(1, 4, 3)] }); // -1, birdie

    expect(milestonesOf([parLine, eagleLine, birdieLine])).toEqual([
      { kind: "first-birdie", roundId: roundId("r-d-birdie") },
      { kind: "first-eagle", roundId: roundId("r-d-eagle") },
    ]);
  });

  it("(e) broke-90 (and broke-100) ignore a 9-hole round even when its gross is under the threshold", () => {
    const nine42 = roundOf("r-e-nine", 9, 42); // 42 < 90 and < 100, but only 9 holes

    expect(milestonesOf([nine42])).toEqual([]);
  });

  it("(f) an 85 earns broke-100 AND broke-90 from the same round (not broke-80)", () => {
    const r85 = roundOf("r-f-85", 18, 85);

    expect(milestonesOf([r85])).toEqual([
      { kind: "broke-100", roundId: roundId("r-f-85") },
      { kind: "broke-90", roundId: roundId("r-f-85") },
    ]);
  });

  it("(g) empty lines yield [] milestones", () => {
    expect(milestonesOf([])).toEqual([]);
  });

  // A conceded hole is a scored hole EVERYWHERE (spec 2026-07-29 §2d), and a conceded three-footer
  // is the most common concession in match play. Before the whole-branch fix this scan tested
  // `kind === "strokes"` raw, so a golfer whose first birdie was conceded saw it counted in "your
  // typical 18" and in their course record while "First birdie" never fired.
  it("(h) a CONCEDED birdie earns first-birdie, and a conceded eagle earns first-eagle", () => {
    const concededBirdie = line({ roundId: roundId("r-h-birdie"), holeResults: [conceded(1, 4, 3)] });
    const concededEagle = line({ roundId: roundId("r-h-eagle"), holeResults: [conceded(1, 5, 3)] });

    expect(milestonesOf([concededBirdie, concededEagle])).toEqual([
      { kind: "first-birdie", roundId: roundId("r-h-birdie") },
      { kind: "first-eagle", roundId: roundId("r-h-eagle") },
    ]);
  });

  // The other half of the same rule: breaking 90 is a claim about a WHOLE CARD, so it still rides
  // fullyHoledOut and a conceded hole disqualifies the card — deliberately asymmetric with (h).
  it("(i) a conceded hole keeps a card out of the broke-N milestones and out of bests", () => {
    const with85AndAConcession = line({
      roundId: roundId("r-i"),
      holes: 18,
      par: 72,
      holeResults: [conceded(1, 4, 4), ...Array.from({ length: 17 }, (_, i) => stroke(i + 2, 4, 4))], // gross 72
    });

    expect(fullyHoledOut(with85AndAConcession)).toBe(false);
    expect(bestsOf([with85AndAConcession])).toEqual({});
    // No under-par hole on this card either, so the per-hole milestones stay absent too — the
    // ONLY reason the array is empty is fullyHoledOut, which is the point.
    expect(milestonesOf([with85AndAConcession])).toEqual([]);
  });
});
