import { describe, expect, it } from "vitest";
import { averageOf, spreadOf } from "./average.js";
import type { GolferRoundLine } from "./record.js";

// n holes of par 4; `perHole` is each hole's gross. 18 × 4 = par 72.
const line = (id: string, holes: 9 | 18, perHole: number): GolferRoundLine => ({
  roundId: id as GolferRoundLine["roundId"],
  courseName: "Test", tee: "white", holes, par: holes * 4, strokes: 0,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  holeResults: Array.from({ length: holes }, (_, i) => ({ hole: i + 1, par: 4, result: { kind: "strokes" as const, strokes: perHole } })),
});

describe("averageOf", () => {
  it("averages score minus par over finished rounds", () => {
    // 5/hole → 90 (+18); 6/hole → 108 (+36). Mean 27.
    expect(averageOf([line("a", 18, 5), line("b", 18, 6)])).toBe(27);
  });

  it("counts a nine-hole round doubled", () => {
    // 9 × 6 = 54 on par 36 → +18, contributes +36.
    expect(averageOf([line("a", 9, 6)])).toBe(36);
  });

  it("counts a round containing a conceded hole", () => {
    const base = line("a", 18, 5);
    const conceded = { ...base, holeResults: base.holeResults!.map((h, i) => (i === 0 ? { ...h, result: { kind: "conceded" as const, strokes: 5 } } : h)) };
    expect(averageOf([conceded])).toBe(18);
  });

  it("skips a round containing a pickup — there is no score", () => {
    const base = line("a", 18, 5);
    const pickedUp = { ...base, holeResults: base.holeResults!.map((h, i) => (i === 0 ? { ...h, result: { kind: "picked-up" as const } } : h)) };
    expect(averageOf([pickedUp])).toBeUndefined();
  });

  it("skips a round whose card has a gap", () => {
    const base = line("a", 18, 5);
    expect(averageOf([{ ...base, holeResults: base.holeResults!.slice(1) }])).toBeUndefined();
  });

  it("uses only the last 10 finished rounds", () => {
    const lines = [...Array.from({ length: 10 }, (_, i) => line(`old${i}`, 18, 6)), ...Array.from({ length: 10 }, (_, i) => line(`new${i}`, 18, 5))];
    expect(averageOf(lines)).toBe(18); // the older +36 rounds fall out of the window
  });

  it("is undefined with no finished rounds", () => {
    expect(averageOf([])).toBeUndefined();
  });
});

describe("spreadOf", () => {
  it("is undefined below five finished rounds", () => {
    expect(spreadOf(Array.from({ length: 4 }, (_, i) => line(`r${i}`, 18, 5)))).toBeUndefined();
  });

  it("is zero for five identical rounds", () => {
    expect(spreadOf(Array.from({ length: 5 }, (_, i) => line(`r${i}`, 18, 5)))).toBe(0);
  });
});
