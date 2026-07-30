import { describe, expect, it } from "vitest";
import { averageOf, spreadOfValues } from "./average.js";
import type { GolferRoundLine } from "./record.js";

// n holes of par 4; `perHole` is each hole's gross. 18 × 4 = par 72.
const line = (id: string, holes: 9 | 18, perHole: number): GolferRoundLine => ({
  roundId: id as GolferRoundLine["roundId"],
  courseName: "Test", tee: "white", holes, par: holes * 4, strokes: 0,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  holeResults: Array.from({ length: holes }, (_, i) => ({ hole: i + 1, par: 4, result: { kind: "strokes" as const, strokes: perHole } })),
});

describe("averageOf", () => {
  it("averages score minus par over rounds with a score", () => {
    // 5/hole → 90 (+18); 6/hole → 108 (+36). Mean 27.
    expect(averageOf([line("a", 18, 5), line("b", 18, 6)])).toBe(27);
  });

  it("counts a nine-hole round doubled", () => {
    // 9 × 6 = 54 on par 36 → +18, contributes +36.
    expect(averageOf([line("a", 9, 6)])).toBe(36);
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

  it("uses only the last 10 rounds with a score", () => {
    const lines = [...Array.from({ length: 10 }, (_, i) => line(`old${i}`, 18, 6)), ...Array.from({ length: 10 }, (_, i) => line(`new${i}`, 18, 5))];
    expect(averageOf(lines)).toBe(18); // the older +36 rounds fall out of the window
  });

  it("is undefined with no rounds carrying a score", () => {
    expect(averageOf([])).toBeUndefined();
  });
});

// `spreadOfValues` is the crew board's own fold (spec §6) — it takes VALUES, not lines, because the
// board scopes its own season window and must never inherit this file's rolling 10. There is no
// line-taking `spreadOf`: spread appears on the board only (controller ruling — see average.ts).
describe("spreadOfValues", () => {
  it("is undefined below five rounds", () => {
    expect(spreadOfValues([18, 18, 18, 18])).toBeUndefined();
  });

  it("is zero for five identical rounds", () => {
    expect(spreadOfValues([18, 18, 18, 18, 18])).toBe(0);
  });

  it("is the population standard deviation, to one decimal", () => {
    // mean(18,18,18,36,36) = 25.2; variance = ((-7.2)^2 x 3 + 10.8^2 x 2)/5 = 388.8/5 = 77.76;
    // sd = 8.81816... -> roundHalfUp(88.1816)/10 = 8.8.
    expect(spreadOfValues([18, 18, 18, 36, 36])).toBe(8.8);
  });
});
