import { describe, expect, it } from "vitest";
import { golferId, roundId } from "../ids.js";
import type { GolferId } from "../ids.js";
import { golferMetrics } from "../golfer/metrics.js";
import type { GolferHoleLine } from "../golfer/record.js";
import { roundHalfUp } from "../scoring/strokes.js";
import { crewScoreboard, inWindow, playedAtMs, sharedRoundIds } from "./scoreboard.js";
import type { SeasonWindow, StoredLine } from "./scoreboard.js";

const A = golferId("a");
const B = golferId("b");

// mkLine: n holes of {par, strokes} so grossOf/fullyHoledOut operate on real holeResults.
// Only the three par/holes combos the brief names are supported — par 72/18 → 18×4;
// par 36/9 → 9×4; par 70/18 → 16×4 + 2×3 — so every hole's par really sums to line.par
// (internally honest fixtures). First `overs` holes get strokes par+1 (bogey), the rest
// par, so gross = par + overs; `pickedUpHole` swaps that hole's result for a picked-up arm
// (never fully holed out). `ags`/`differential` are separate declared inputs (a real AGS can
// differ from the raw hole sum via the net-double-bogey cap) — set explicitly per case.
const mkLine = (opts: {
  roundId: string;
  holes: 9 | 18;
  par: number;
  ch: number;
  ags?: number;
  overs?: number;
  pickedUpHole?: number;
  finalizedAtMs: number;
  createdAtMs?: number;
  differential?: number;
}): StoredLine => {
  const overs = opts.overs ?? 0;
  let holePars: number[];
  if (opts.holes === 18 && opts.par === 72) holePars = Array(18).fill(4);
  else if (opts.holes === 9 && opts.par === 36) holePars = Array(9).fill(4);
  else if (opts.holes === 18 && opts.par === 70) holePars = [...Array(16).fill(4), ...Array(2).fill(3)];
  else throw new Error(`mkLine: unsupported par/holes combo ${opts.par}/${opts.holes}`);

  const holeResults: GolferHoleLine[] = holePars.map((par, idx) => {
    const hole = idx + 1;
    if (opts.pickedUpHole === hole) return { hole, par, result: { kind: "picked-up" } };
    const strokes = idx < overs ? par + 1 : par;
    return { hole, par, result: { kind: "strokes", strokes } };
  });

  const distribution = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };
  for (const h of holeResults) {
    if (h.result.kind !== "strokes") continue;
    const rel = h.result.strokes - h.par;
    if (rel <= -2) distribution.eagles += 1;
    else if (rel === -1) distribution.birdies += 1;
    else if (rel === 0) distribution.pars += 1;
    else if (rel === 1) distribution.bogeys += 1;
    else distribution.doublePlus += 1;
  }

  return {
    roundId: roundId(opts.roundId),
    courseName: "Fixture",
    tee: "white",
    holes: opts.holes,
    par: opts.par,
    courseHandicap: opts.ch,
    ...(opts.ags !== undefined ? { ags: opts.ags } : {}),
    ...(opts.differential !== undefined ? { differential: opts.differential } : {}),
    distribution,
    holeResults,
    finalizedAtMs: opts.finalizedAtMs,
    ...(opts.createdAtMs !== undefined ? { createdAtMs: opts.createdAtMs } : {}),
  };
};

describe("crewScoreboard — netPer18 (spec §7 case 1-2)", () => {
  it("worked fixture: 3 over 45 holes x18 = 1.2", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 72, ch: 12, ags: 85, finalizedAtMs: 1000 }), // +1
      mkLine({ roundId: "r2", holes: 9, par: 36, ch: 5, ags: 41, finalizedAtMs: 2000 }), // 0
      mkLine({ roundId: "r3", holes: 18, par: 70, ch: 8, ags: 80, finalizedAtMs: 3000 }), // +2
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.netPer18).toBe(1.2);
  });

  it("floor: only 2 ags-bearing lines -> netPer18 absent", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, ags: 84, finalizedAtMs: 1000 }),
      mkLine({ roundId: "r2", holes: 18, par: 72, ch: 10, ags: 84, finalizedAtMs: 2000 }),
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.netPer18).toBeUndefined();
  });
});

describe("crewScoreboard — best18 (spec §7 case 3-4)", () => {
  it("lower gross wins outright", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, overs: 13, finalizedAtMs: 1000 }), // gross 85
      mkLine({ roundId: "r2", holes: 18, par: 70, ch: 10, overs: 10, finalizedAtMs: 2000 }), // gross 80
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.best18).toEqual({ gross: 80, toPar: 10 });
  });

  it("tie on gross: the EARLIER line keeps the record even though the later one has a lower toPar", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 70, ch: 10, overs: 10, finalizedAtMs: 1000 }), // gross 80, toPar 10 (earlier)
      mkLine({ roundId: "r2", holes: 18, par: 72, ch: 10, overs: 8, finalizedAtMs: 2000 }), // gross 80, toPar 8 (later)
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.best18).toEqual({ gross: 80, toPar: 10 });
  });

  it("excludes a 9-hole line and a not-fully-holed-out 18 (picked-up hole)", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 9, par: 36, ch: 10, finalizedAtMs: 1000 }),
      mkLine({ roundId: "r2", holes: 18, par: 72, ch: 10, overs: 5, pickedUpHole: 3, finalizedAtMs: 2000 }),
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.best18).toBeUndefined();
  });
});

describe("inWindow — edges (spec §7 case 5)", () => {
  const window: SeasonWindow = { startMs: 1000, endMs: 2000 };

  it("playedAt == startMs is IN", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, finalizedAtMs: 1000 }))).toBe(true);
  });

  it("playedAt == endMs is IN", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, finalizedAtMs: 2000 }))).toBe(true);
  });

  it("startMs - 1 is OUT", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, finalizedAtMs: 999 }))).toBe(false);
  });

  it("endMs + 1 is OUT", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, finalizedAtMs: 2001 }))).toBe(false);
  });

  it("createdAtMs outside but finalizedAtMs inside is OUT — created wins", () => {
    const line = mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, finalizedAtMs: 1500, createdAtMs: 2500 });
    expect(inWindow(window, line)).toBe(false);
  });
});

describe("crewScoreboard — zero-round member (spec §7 case 6)", () => {
  it("present with rounds: 0 and every optional absent", () => {
    const rows = crewScoreboard([{ golferId: A, lines: [] }], { startMs: 0 });
    expect(rows).toEqual([{ golferId: A, rounds: 0 }]);
  });
});

describe("crewScoreboard — index/indexDelta (spec §7 case 7, reuse-proof)", () => {
  it("index is golferMetrics(lines).swngIndex; indexDelta compares against the pre-window golferMetrics call", () => {
    const window: SeasonWindow = { startMs: 5000 };
    const preWindow = [
      mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, ags: 82, differential: 10.0, finalizedAtMs: 1000 }),
      mkLine({ roundId: "r2", holes: 18, par: 72, ch: 10, ags: 84, differential: 12.0, finalizedAtMs: 2000 }),
      mkLine({ roundId: "r3", holes: 18, par: 72, ch: 10, ags: 80, differential: 8.0, finalizedAtMs: 3000 }),
    ];
    const lines = [...preWindow, mkLine({ roundId: "r4", holes: 18, par: 72, ch: 10, ags: 78, differential: 6.0, finalizedAtMs: 6000 })];

    const rows = crewScoreboard([{ golferId: A, lines }], window);
    const row = rows[0]!;

    const expectedIndex = golferMetrics(lines).swngIndex?.value;
    const expectedBefore = golferMetrics(lines.filter((line) => playedAtMs(line) < window.startMs)).swngIndex?.value;
    expect(expectedIndex).toBeDefined();
    expect(expectedBefore).toBeDefined();
    const expectedDelta = roundHalfUp((expectedIndex! - expectedBefore!) * 10) / 10;

    expect(row.index).toBe(expectedIndex);
    expect(row.indexDelta).toBe(expectedDelta);
  });

  it("delta is absent when no pre-window lines exist (index can still be present)", () => {
    const window: SeasonWindow = { startMs: 5000 };
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 72, ch: 10, ags: 82, differential: 10.0, finalizedAtMs: 6000 }),
      mkLine({ roundId: "r2", holes: 18, par: 72, ch: 10, ags: 84, differential: 12.0, finalizedAtMs: 7000 }),
      mkLine({ roundId: "r3", holes: 18, par: 72, ch: 10, ags: 80, differential: 8.0, finalizedAtMs: 8000 }),
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], window);
    const row = rows[0]!;
    const expectedIndex = golferMetrics(lines).swngIndex?.value;
    expect(expectedIndex).toBeDefined();
    expect(row.index).toBe(expectedIndex);
    expect(row.indexDelta).toBeUndefined();
  });
});

describe("crewScoreboard — sort totality (spec §7 case 8)", () => {
  it("netPer18 asc, absent last, rounds desc tiebreak, golferId final — incl. two fully-identical rows", () => {
    // net = mean(ags - ch - par); with holes=18 uniform across a member's 3 lines,
    // netPer18 == that constant exactly (see the module's own formula).
    const netThree = (gid: GolferId, ags: number, count: number) =>
      Array.from({ length: count }, (_, i) => mkLine({ roundId: `${gid}-${i}`, holes: 18, par: 72, ch: 10, ags, finalizedAtMs: 1000 + i }));

    const members = [
      { golferId: golferId("b"), lines: netThree(golferId("b"), 84, 3) }, // net 2.0, rounds 3
      { golferId: golferId("a"), lines: netThree(golferId("a"), 84, 3) }, // net 2.0, rounds 3 — identical to "b" but for id
      { golferId: golferId("c"), lines: netThree(golferId("c"), 83, 3) }, // net 1.0, rounds 3
      { golferId: golferId("e"), lines: netThree(golferId("e"), 83, 5) }, // net 1.0, rounds 5 — beats "c" on rounds
      { golferId: golferId("d"), lines: [] }, // no ags lines at all -> netPer18 absent, last
    ];

    const rows = crewScoreboard(members, { startMs: 0 });
    expect(rows.map((r) => r.golferId)).toEqual([golferId("e"), golferId("c"), golferId("a"), golferId("b"), golferId("d")]);
  });
});

describe("sharedRoundIds (spec §7 case 9)", () => {
  it("returns a roundId only when >=2 distinct members hold an in-window line for it; no duplicates", () => {
    const window: SeasonWindow = { startMs: 1000, endMs: 2000 };
    const aLines = [
      mkLine({ roundId: "shared-in", holes: 18, par: 72, ch: 10, finalizedAtMs: 1500 }),
      mkLine({ roundId: "shared-out", holes: 18, par: 72, ch: 10, finalizedAtMs: 500 }),
      mkLine({ roundId: "solo", holes: 18, par: 72, ch: 10, finalizedAtMs: 1500 }),
    ];
    const bLines = [
      mkLine({ roundId: "shared-in", holes: 18, par: 72, ch: 10, finalizedAtMs: 1600 }),
      mkLine({ roundId: "shared-out", holes: 18, par: 72, ch: 10, finalizedAtMs: 400 }),
    ];

    const result = sharedRoundIds(
      [
        { golferId: A, lines: aLines },
        { golferId: B, lines: bLines },
      ],
      window,
    );

    expect(result).toEqual([roundId("shared-in")]);
    expect(new Set(result).size).toBe(result.length);
  });
});
