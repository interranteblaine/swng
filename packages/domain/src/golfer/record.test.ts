import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { cardId, courseId, deviceId, golferId, opId, roundId } from "../ids.js";
import { fixtureLinks18 } from "../scoring/golden/fixtureCourse.js";
import type { CourseCard } from "../course/card.js";
import { settleRound } from "../round/archive.js";
import type { RoundArchive } from "../round/archive.js";
import type { RoundEvent } from "../round/events.js";
import type { HoleSelection } from "../round/holes.js";
import type { HoleResult } from "../round/holeResult.js";
import { cellKey } from "../round/state.js";
import type { ScoreCell } from "../round/state.js";
import { archiveGolferLine } from "./record.js";

const G = golferId("gigi");
const A = golferId("ann");

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
// The same complete card with ONE hole swapped — used to prove a picked-up hole omits the score.
const fullCardWith = (hole: number, result: HoleResult): Readonly<Record<string, ScoreCell>> => ({
  ...fullCard,
  [cellKey(G, hole)]: cellOf(hole, result),
});

const baseArchive: RoundArchive = {
  roundId: roundId("r1"),
  card: fixtureLinks18,
  // A non-zero number so the line's frozen `strokes` is worth asserting.
  participants: [{ golferId: G, name: "Gigi", tee: "white", strokes: 10 }],
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

  it("carries par (sum of the frozen tee's hole pars) and the strokes the roster asserted", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect(line.par).toBe(72); // fixtureWhite18: 36 + 36
    expect(line.strokes).toBe(10); // baseArchive's participant.strokes
  });

  it("records only the strokes played off — there is no second number beside it", () => {
    // `normallyShoots` is deleted (spec 2026-07-30 §11): it recorded an assertion that only became
    // strokes through a rule that no longer exists.
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

  it("counts scored holes but not picked-up or unscored ones in the distribution", () => {
    const sparse: RoundArchive = {
      ...baseArchive,
      cells: {
        [cellKey(G, 1)]: cell(1, 4), // par 4 → a par
        [cellKey(G, 2)]: cellOf(2, { kind: "picked-up" }), // no number — excluded
        // hole 3 onward: no cell at all — unscored, excluded.
      },
    };
    const line = archiveGolferLine(sparse, G);
    expect(line.distribution).toEqual({ eagles: 0, birdies: 0, pars: 1, bogeys: 0, doublePlus: 0 });
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
        // hole 3: no cell at all — unscored.
        [cellKey(G, 5)]: cellOf(5, { kind: "cleared" }),
      },
    };
    const line = archiveGolferLine(mixed, G);
    expect(line.holeResults).toEqual([
      { hole: 1, par: 4, result: { kind: "strokes", strokes: 5 } },
      { hole: 2, par: 4, result: { kind: "picked-up" } },
      // hole 3 (silence) and hole 5 (cleared) are OMITTED — cellAt's own contract.
    ]);
  });

  it("holeResults and distribution agree — one walk, every numbered cell in a bucket", () => {
    const line = archiveGolferLine({ ...baseArchive, cells: fullCardWith(3, { kind: "picked-up" }) }, G);
    const numberedHoles = line.holeResults!.filter((h) => h.result.kind === "strokes");
    const bucketTotal =
      line.distribution.eagles + line.distribution.birdies + line.distribution.pars +
      line.distribution.bogeys + line.distribution.doublePlus;
    expect(numberedHoles.length).toBe(bucketTotal);
  });
});

// An 18-hole card, par 4 throughout (par 72), conventional stroke-index split.
const eighteenCard: CourseCard = {
  courseName: "Casa Verde GC",
  teeSets: [
    {
      name: "white",
      holes: Array.from({ length: 18 }, (_, i) => ({
        number: i + 1,
        par: 4,
        yardage: 400,
        strokeIndex: i < 9 ? i * 2 + 1 : (i - 9) * 2 + 2,
      })),
    },
  ],
};

// Settles a finished round that SET OUT to play `selection` and scored `scoredHoles`, five strokes
// a hole. No games, so nothing blocks the settle.
const settledRound = (selection: HoleSelection, scoredHoles: readonly number[]) => {
  let n = 0;
  const env = (wallMs: number) => ({ opId: opId(`o-${n++}`), hlc: { wallMs, counter: 0, deviceId: deviceId("d1") }, authorId: A });
  const events: RoundEvent[] = [
    { ...env(1), kind: "round-created", roundId: roundId("r1"), card: eighteenCard, playedAtMs: 1, ...(selection !== "all" ? { holes: selection } : {}) },
    { ...env(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 0 } },
    { ...env(3), kind: "round-started" },
    ...scoredHoles.map((hole): RoundEvent => ({ ...env(10 + hole), kind: "score-recorded", golferId: A, hole, result: { kind: "strokes", strokes: 5 } })),
    { ...env(200), kind: "round-finalized" },
  ];
  return settleRound(events);
};

const BACK_NINE = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const FIRST_THIRTEEN = Array.from({ length: 13 }, (_, i) => i + 1);

describe("a nine played on an 18-hole card (spec 2026-08-02 §4)", () => {
  it("records nine holes, that nine's par, and a real gross", () => {
    const line = archiveGolferLine(settledRound("back", BACK_NINE), A);
    expect(line.holes).toBe(9);
    expect(line.par).toBe(36);
    expect(line.holeResults).toHaveLength(9);
    expect(line.score).toBe(45);
  });

  // The no-regression pin (spec §5): a round that SET OUT to play eighteen and stopped after
  // thirteen is exactly what it is today — an eighteen-hole line with thirteen results and no
  // score. This arc must not touch it.
  it("leaves a short eighteen exactly as it is today", () => {
    const line = archiveGolferLine(settledRound("all", FIRST_THIRTEEN), A);
    expect(line.holes).toBe(18);
    expect(line.par).toBe(72);
    expect(line.holeResults).toHaveLength(13);
    expect(line.score).toBeUndefined();
  });
});
