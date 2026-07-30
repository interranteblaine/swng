import { describe, expect, it } from "vitest";
import { golferId, roundId } from "../ids.js";
import type { GolferId } from "../ids.js";
import type { GolferHoleLine } from "../golfer/record.js";
import { crewScoreboard, inWindow, playedAtMs, sharedRoundIds } from "./scoreboard.js";
import type { SeasonWindow, StoredLine } from "./scoreboard.js";

const A = golferId("a");
const B = golferId("b");

// mkLine: n holes of {par, strokes} so grossOf/fullyHoledOut/hasCompleteScore operate on real
// holeResults. Only the three par/holes combos the brief names are supported — par 72/18 → 18×4;
// par 36/9 → 9×4; par 70/18 → 16×4 + 2×3 — so every hole's par really sums to line.par
// (internally honest fixtures). First `overs` holes get strokes par+1 (bogey), the rest par, so
// gross = par + overs and the line's vs-par figure is exactly `overs` (doubled on a nine, per
// spec 2026-07-29 §2d). `pickedUpHole` swaps that hole's result for a picked-up arm — never fully
// holed out, and never a scored card at all, so it feeds neither best18 nor the average.
const mkLine = (opts: {
  roundId: string;
  holes: 9 | 18;
  par: number;
  strokes: number;
  overs?: number;
  pickedUpHole?: number;
  finalizedAtMs: number;
  createdAtMs?: number;
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
    strokes: opts.strokes,
    distribution,
    holeResults,
    finalizedAtMs: opts.finalizedAtMs,
    ...(opts.createdAtMs !== undefined ? { createdAtMs: opts.createdAtMs } : {}),
  };
};

describe("crewScoreboard — average (spec 2026-07-29 §6)", () => {
  it("averages score minus par over the window, counting a nine doubled", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 12, overs: 1, finalizedAtMs: 1000 }), // +1
      mkLine({ roundId: "r2", holes: 9, par: 36, strokes: 5, overs: 3, finalizedAtMs: 2000 }), // +3 on a nine → +6
      mkLine({ roundId: "r3", holes: 18, par: 70, strokes: 8, overs: 2, finalizedAtMs: 3000 }), // +2
    ];
    // mean(1, 6, 2) = 9/3 = 3.
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.average).toBe(3);
  });

  // The board's average is over EVERY finished round in the window, never the profile's rolling
  // last-10 (spec §6: "Rounds 12 beside an average of 10 of them would be a lie on the same row").
  // The fixture is built so the two answers DIFFER, which is the only way to prove there's no slice.
  it("uses every round in the window, not the profile's rolling last 10", () => {
    const lines = [
      mkLine({ roundId: "old1", holes: 18, par: 72, strokes: 20, overs: 18, finalizedAtMs: 1000 }), // +18
      mkLine({ roundId: "old2", holes: 18, par: 72, strokes: 20, overs: 18, finalizedAtMs: 2000 }), // +18
      ...Array.from({ length: 10 }, (_, i) => mkLine({ roundId: `new${i}`, holes: 18, par: 72, strokes: 6, overs: 4, finalizedAtMs: 3000 + i })), // +4 each
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    // All 12: (18 + 18 + 4×10) / 12 = 76/12 = 6.333… → roundHalfUp → 6.
    // A last-10 slice would drop both +18s and read 4 — the number this test exists to reject.
    expect(rows[0]!.rounds).toBe(12);
    expect(rows[0]!.average).toBe(6);
  });

  it("is absent for a member with no scored round in the window", () => {
    const lines = [mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, overs: 4, pickedUpHole: 3, finalizedAtMs: 1000 })];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.rounds).toBe(1); // the round happened and is counted
    expect(rows[0]!.average).toBeUndefined(); // but it carries no score, so no number is invented
  });
});

describe("crewScoreboard — spread (spec 2026-07-29 §6)", () => {
  // Five rounds at +2, +2, +2, +10, +10:
  //   average = 26/5 = 5.2 → roundHalfUp → 5
  //   spread  = sqrt(((−3.2)²·3 + 4.8²·2)/5) = sqrt(76.8/5) = sqrt(15.36) = 3.91918… → 3.9
  const fiveRounds = [2, 2, 2, 10, 10].map((overs, i) => mkLine({ roundId: `r${i}`, holes: 18, par: 72, strokes: 10, overs, finalizedAtMs: 1000 + i }));

  it("is the standard deviation over the same set as the average", () => {
    const rows = crewScoreboard([{ golferId: A, lines: fiveRounds }], { startMs: 0 });
    expect(rows[0]!.average).toBe(5);
    expect(rows[0]!.spread).toBe(3.9);
  });

  it("is held back below five scored rounds, while the average still shows", () => {
    const rows = crewScoreboard([{ golferId: A, lines: fiveRounds.slice(0, 4) }], { startMs: 0 });
    expect(rows[0]!.average).toBe(4); // mean(2,2,2,10) = 16/4 = 4
    expect(rows[0]!.spread).toBeUndefined();
  });

  it("counts only scored rounds toward its own five-round floor", () => {
    const withPickup = [...fiveRounds.slice(0, 4), mkLine({ roundId: "picked", holes: 18, par: 72, strokes: 10, overs: 10, pickedUpHole: 1, finalizedAtMs: 9000 })];
    const rows = crewScoreboard([{ golferId: A, lines: withPickup }], { startMs: 0 });
    expect(rows[0]!.rounds).toBe(5); // five rounds played…
    expect(rows[0]!.spread).toBeUndefined(); // …but only four with a score
  });
});

describe("crewScoreboard — best18 (spec §7 case 3-4)", () => {
  it("lower gross wins outright", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, overs: 13, finalizedAtMs: 1000 }), // gross 85
      mkLine({ roundId: "r2", holes: 18, par: 70, strokes: 10, overs: 10, finalizedAtMs: 2000 }), // gross 80
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.best18).toEqual({ gross: 80, toPar: 10 });
  });

  it("tie on gross: the EARLIER line keeps the record even though the later one has a lower toPar", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 18, par: 70, strokes: 10, overs: 10, finalizedAtMs: 1000 }), // gross 80, toPar 10 (earlier)
      mkLine({ roundId: "r2", holes: 18, par: 72, strokes: 10, overs: 8, finalizedAtMs: 2000 }), // gross 80, toPar 8 (later)
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.best18).toEqual({ gross: 80, toPar: 10 });
  });

  it("excludes a 9-hole line and a not-fully-holed-out 18 (picked-up hole)", () => {
    const lines = [
      mkLine({ roundId: "r1", holes: 9, par: 36, strokes: 10, finalizedAtMs: 1000 }),
      mkLine({ roundId: "r2", holes: 18, par: 72, strokes: 10, overs: 5, pickedUpHole: 3, finalizedAtMs: 2000 }),
    ];
    const rows = crewScoreboard([{ golferId: A, lines }], { startMs: 0 });
    expect(rows[0]!.best18).toBeUndefined();
  });
});

describe("inWindow — edges (spec §7 case 5)", () => {
  const window: SeasonWindow = { startMs: 1000, endMs: 2000 };

  it("playedAt == startMs is IN", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, finalizedAtMs: 1000 }))).toBe(true);
  });

  it("playedAt == endMs is IN", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, finalizedAtMs: 2000 }))).toBe(true);
  });

  it("startMs - 1 is OUT", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, finalizedAtMs: 999 }))).toBe(false);
  });

  it("endMs + 1 is OUT", () => {
    expect(inWindow(window, mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, finalizedAtMs: 2001 }))).toBe(false);
  });

  it("createdAtMs outside but finalizedAtMs inside is OUT — created wins", () => {
    const line = mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, finalizedAtMs: 1500, createdAtMs: 2500 });
    expect(inWindow(window, line)).toBe(false);
  });
});

describe("crewScoreboard — window scoping (spec §7 case 7's replacement)", () => {
  // The retired `index`/`indexDelta` columns were the only reason this fold ever looked at lines
  // OUTSIDE the window (the index was whole-career by construction). Now nothing does — so the
  // property worth pinning is the opposite one: a pre-window round must not touch any number.
  it("ignores a pre-window round entirely — it moves neither rounds nor the average", () => {
    const window: SeasonWindow = { startMs: 5000 };
    const inSeason = [
      mkLine({ roundId: "r3", holes: 18, par: 72, strokes: 10, overs: 4, finalizedAtMs: 6000 }),
      mkLine({ roundId: "r4", holes: 18, par: 72, strokes: 10, overs: 4, finalizedAtMs: 7000 }),
    ];
    const preWindow = mkLine({ roundId: "r1", holes: 18, par: 72, strokes: 10, overs: 18, finalizedAtMs: 1000 }); // +18 — would drag the average up

    const withHistory = crewScoreboard([{ golferId: A, lines: [preWindow, ...inSeason] }], window)[0]!;
    const withoutHistory = crewScoreboard([{ golferId: A, lines: inSeason }], window)[0]!;

    expect(playedAtMs(preWindow)).toBeLessThan(window.startMs); // fixture sanity
    expect(withHistory).toEqual(withoutHistory);
    expect(withHistory.rounds).toBe(2);
    expect(withHistory.average).toBe(4);
  });
});

describe("crewScoreboard — zero-round member (spec §7 case 6)", () => {
  it("present with rounds: 0 and every optional absent", () => {
    const rows = crewScoreboard([{ golferId: A, lines: [] }], { startMs: 0 });
    expect(rows).toEqual([{ golferId: A, rounds: 0 }]);
  });
});

describe("crewScoreboard — sort totality (spec §7 case 8)", () => {
  it("average asc, absent last, rounds desc tiebreak, golferId final — incl. two fully-identical rows", () => {
    // Every line is an 18 whose vs-par figure is exactly `overs`, so a member's average is that
    // constant (see mkLine's own comment).
    const roundsAt = (gid: GolferId, overs: number, count: number) =>
      Array.from({ length: count }, (_, i) => mkLine({ roundId: `${gid}-${i}`, holes: 18, par: 72, strokes: 10, overs, finalizedAtMs: 1000 + i }));

    const members = [
      { golferId: golferId("b"), lines: roundsAt(golferId("b"), 4, 3) }, // average +4, rounds 3
      { golferId: golferId("a"), lines: roundsAt(golferId("a"), 4, 3) }, // average +4, rounds 3 — identical to "b" but for id
      { golferId: golferId("c"), lines: roundsAt(golferId("c"), 2, 3) }, // average +2, rounds 3
      { golferId: golferId("e"), lines: roundsAt(golferId("e"), 2, 5) }, // average +2, rounds 5 — beats "c" on rounds
      { golferId: golferId("d"), lines: [] }, // no rounds at all -> average absent, last
    ];

    const rows = crewScoreboard(members, { startMs: 0 });
    expect(rows.map((r) => r.golferId)).toEqual([golferId("e"), golferId("c"), golferId("a"), golferId("b"), golferId("d")]);
  });
});

describe("sharedRoundIds (spec §7 case 9)", () => {
  it("returns a roundId only when >=2 distinct members hold an in-window line for it; no duplicates", () => {
    const window: SeasonWindow = { startMs: 1000, endMs: 2000 };
    const aLines = [
      mkLine({ roundId: "shared-in", holes: 18, par: 72, strokes: 10, finalizedAtMs: 1500 }),
      mkLine({ roundId: "shared-out", holes: 18, par: 72, strokes: 10, finalizedAtMs: 500 }),
      mkLine({ roundId: "solo", holes: 18, par: 72, strokes: 10, finalizedAtMs: 1500 }),
    ];
    const bLines = [
      mkLine({ roundId: "shared-in", holes: 18, par: 72, strokes: 10, finalizedAtMs: 1600 }),
      mkLine({ roundId: "shared-out", holes: 18, par: 72, strokes: 10, finalizedAtMs: 400 }),
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
