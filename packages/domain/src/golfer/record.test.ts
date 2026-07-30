import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { cardId, courseId, deviceId, golferId, opId, roundId } from "../ids.js";
import { fixtureLinks18 } from "../scoring/golden/fixtureCourse.js";
import type { RoundArchive } from "../round/archive.js";
import type { HoleResult } from "../round/holeResult.js";
import { cellKey } from "../round/state.js";
import type { ScoreCell } from "../round/state.js";
import { archiveGolferLine } from "./record.js";

const G = golferId("gigi");

const cellOf = (hole: number, result: HoleResult): ScoreCell => ({
  result,
  recordedBy: G,
  hlc: { wallMs: hole, counter: 0, deviceId: deviceId("d") },
  opId: opId(`op-${hole}`),
});
const cell = (hole: number, strokes: number): ScoreCell => cellOf(hole, { kind: "strokes", strokes });

// Par per hole (fixtureWhite18): 4,4,3,5,4,3,4,5,4, 4,3,5,4,4,5,3,4,4. Strokes chosen so
// h1 is a birdie, h2-h11 are pars (10 holes), h12-h17 are bogeys (6 holes), h18 a double —
// the brief's hand-pin: 1 birdie / 10 pars / 6 bogeys / 1 double over 18 holes.
const strokesByHole: Readonly<Record<number, number>> = {
  1: 3, 2: 4, 3: 3, 4: 5, 5: 4, 6: 3, 7: 4, 8: 5, 9: 4,
  10: 4, 11: 3, 12: 6, 13: 5, 14: 5, 15: 6, 16: 4, 17: 5, 18: 6,
};
// Gross = 35 (out) + 44 (in) = 79, which is par 72 + the buckets' own Σ(strokes − par):
// −1 (birdie) + 0×10 + 1×6 + 2 (double) = +7. The two derivations agreeing is the point.
const FULL_CARD_GROSS = 79;
const fullCard = Object.fromEntries(
  Object.entries(strokesByHole).map(([hole, strokes]) => [cellKey(G, Number(hole)), cell(Number(hole), strokes)]),
);
// The same complete card with ONE hole swapped — used to prove a conceded hole is a scored hole
// (spec 2026-07-29 §2d) and a picked-up one is not.
const fullCardWith = (hole: number, result: HoleResult): Readonly<Record<string, ScoreCell>> => ({
  ...fullCard,
  [cellKey(G, hole)]: cellOf(hole, result),
});

const baseArchive: RoundArchive = {
  roundId: roundId("r1"),
  card: fixtureLinks18,
  // A lone participant is their own anchor, so a stated +10 derives 0 strokes (spec §2b) — this
  // fixture states the strokes directly so the line's frozen number is a non-zero 10 to assert.
  participants: [{ golferId: G, name: "Gigi", tee: "white", basis: { kind: "strokes", strokes: 10 }, strokes: 10 }],
  games: [],
  cells: fullCard,
  events: [],
  results: [],
  terminatedGameIds: [],
};

describe("archiveGolferLine", () => {
  it("counts distribution against par: hand-pinned 1 birdie/10 pars/6 bogeys/1 double", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect(line.distribution).toEqual({ eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 });
  });

  it("carries roundId, courseName, tee, and holes from the archive/participant", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect(line.roundId).toBe(baseArchive.roundId);
    expect(line.courseName).toBe(fixtureLinks18.courseName);
    expect(line.tee).toBe("white");
    expect(line.holes).toBe(18);
  });

  it("carries par (sum of the frozen tee's hole pars) and the strokes the fold derived", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect(line.par).toBe(72); // fixtureWhite18: 36 + 36
    expect(line.strokes).toBe(10); // baseArchive's participant.strokes
  });

  // The assertion beside its consequence (spec §2a/§2b): `normallyShoots` is what the player SAID,
  // present only for the first constructor; `strokes` is what the fold made of it.
  it("carries normallyShoots when the player stated a normal score", () => {
    const stated: RoundArchive = {
      ...baseArchive,
      participants: [{ golferId: G, name: "Gigi", tee: "white", basis: { kind: "normally-shoots", overPar: 22 }, strokes: 12 }],
    };
    const line = archiveGolferLine(stated, G);
    expect(line.normallyShoots).toBe(22);
    expect(line.strokes).toBe(12);
  });

  it("omits normallyShoots when the player stated raw strokes instead", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect("normallyShoots" in line).toBe(false);
  });

  // `score` is what a history row renders (spec §8) — holeResults never rides the wire, so
  // without it the row would have no number at all.
  it("carries the round's gross score when every hole has a number", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect(line.score).toBe(FULL_CARD_GROSS);
    expect(line.score! - line.par).toBe(7); // the same +7 the buckets sum to
  });

  it("counts a conceded hole in the score — you made that number (spec §2d)", () => {
    // h3 is par 3 and was scored 3; conceding it at 3 leaves the total untouched.
    const conceded: RoundArchive = { ...baseArchive, cells: fullCardWith(3, { kind: "conceded", strokes: 3 }) };
    const line = archiveGolferLine(conceded, G);
    expect(line.score).toBe(FULL_CARD_GROSS);
    // ...and it lands in the distribution too, so "your typical 18" can't disagree with the score.
    expect(line.distribution).toEqual({ eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 });
  });

  it("omits score when a hole was picked up — there is no score, and none is invented", () => {
    const pickedUp: RoundArchive = { ...baseArchive, cells: fullCardWith(3, { kind: "picked-up" }) };
    const line = archiveGolferLine(pickedUp, G);
    expect(line.score).toBeUndefined();
  });

  it("omits score when the card has an unscored gap", () => {
    const seventeen = Object.fromEntries(Object.entries(fullCard).filter(([key]) => key !== cellKey(G, 18)));
    const line = archiveGolferLine({ ...baseArchive, cells: seventeen }, G);
    expect(line.score).toBeUndefined();
  });

  it("counts conceded holes but not picked-up or unscored ones in the distribution", () => {
    const sparse: RoundArchive = {
      ...baseArchive,
      cells: {
        [cellKey(G, 1)]: cell(1, 4), // par 4 → a par
        [cellKey(G, 2)]: cellOf(2, { kind: "picked-up" }), // no number — excluded
        [cellKey(G, 3)]: cellOf(3, { kind: "conceded", strokes: 4 }), // par 3 → a bogey, and it COUNTS (spec §2d)
        // hole 4 onward: no cell at all — unscored, excluded.
      },
    };
    const line = archiveGolferLine(sparse, G);
    expect(line.distribution).toEqual({ eagles: 0, birdies: 0, pars: 1, bogeys: 1, doublePlus: 0 });
    expect(line.score).toBeUndefined(); // a partial card carries no score
  });

  it("carries courseId when the card carries a source (spec §4: recorded from day one)", () => {
    const sourced: RoundArchive = {
      ...baseArchive,
      card: { ...fixtureLinks18, source: { cardId: cardId("card-1"), courseId: courseId("course-1") } },
    };
    const line = archiveGolferLine(sourced, G);
    expect(line.courseId).toBe(courseId("course-1"));
  });

  it("omits courseId when the card carries no source (pre-scrap archives)", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect("courseId" in line).toBe(false);
  });

  it("throws unknown-participant for a golfer not on this archive's roster", () => {
    const attempt = () => archiveGolferLine(baseArchive, golferId("ghost"));
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "unknown-participant" }));
  });

  it("buckets an eagle (-2) as eagles and anything beyond a double (+3) still into doublePlus", () => {
    const extremes: RoundArchive = {
      ...baseArchive,
      cells: {
        [cellKey(G, 1)]: cell(1, 2), // par 4, eagle
        [cellKey(G, 4)]: cell(4, 8), // par 5, triple bogey — same bucket as a double
      },
    };
    const line = archiveGolferLine(extremes, G);
    expect(line.distribution).toEqual({ eagles: 1, birdies: 0, pars: 0, bogeys: 0, doublePlus: 1 });
  });

  it("holeResults records every decided hole with its frozen par, in card order", () => {
    // fixtureWhite18 pars: h1=4, h2=4, h3=3 (h4 is left unscored — no par pin needed).
    const mixed: RoundArchive = {
      ...baseArchive,
      cells: {
        [cellKey(G, 1)]: cell(1, 5), // strokes
        [cellKey(G, 2)]: cellOf(2, { kind: "picked-up" }),
        [cellKey(G, 3)]: cellOf(3, { kind: "conceded", strokes: 3 }),
        // hole 4: no cell at all — unscored.
        [cellKey(G, 5)]: cellOf(5, { kind: "cleared" }),
      },
    };
    const line = archiveGolferLine(mixed, G);
    expect(line.holeResults).toEqual([
      { hole: 1, par: 4, result: { kind: "strokes", strokes: 5 } },
      { hole: 2, par: 4, result: { kind: "picked-up" } },
      { hole: 3, par: 3, result: { kind: "conceded", strokes: 3 } }, // a conceded par — holeResults passes the cell through verbatim
      // hole 4 (silence) and hole 5 (cleared) are OMITTED — cellAt's own contract.
    ]);
  });

  it("holeResults and distribution agree — one walk, every numbered cell in a bucket", () => {
    const line = archiveGolferLine({ ...baseArchive, cells: fullCardWith(3, { kind: "conceded", strokes: 3 }) }, G);
    const numberedHoles = line.holeResults!.filter((h) => h.result.kind === "strokes" || h.result.kind === "conceded");
    const bucketTotal =
      line.distribution.eagles + line.distribution.birdies + line.distribution.pars +
      line.distribution.bogeys + line.distribution.doublePlus;
    expect(numberedHoles.length).toBe(bucketTotal);
  });
});
