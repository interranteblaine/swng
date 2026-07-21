import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { cardId, courseId, deviceId, golferId, opId, roundId } from "../ids.js";
import { fixtureLinks18 } from "../scoring/golden/fixtureCourse.js";
import type { RoundArchive } from "../round/archive.js";
import { cellKey } from "../round/state.js";
import type { ScoreCell } from "../round/state.js";
import { archiveGolferLine } from "./record.js";

const G = golferId("gigi");

const cell = (hole: number, strokes: number): ScoreCell => ({
  result: { kind: "strokes", strokes },
  recordedBy: G,
  hlc: { wallMs: hole, counter: 0, deviceId: deviceId("d") },
  opId: opId(`op-${hole}`),
});

// Par per hole (fixtureWhite18): 4,4,3,5,4,3,4,5,4, 4,3,5,4,4,5,3,4,4. Strokes chosen so
// h1 is a birdie, h2-h11 are pars (10 holes), h12-h17 are bogeys (6 holes), h18 a double —
// the brief's hand-pin: 1 birdie / 10 pars / 6 bogeys / 1 double over 18 holes.
const strokesByHole: Readonly<Record<number, number>> = {
  1: 3, 2: 4, 3: 3, 4: 5, 5: 4, 6: 3, 7: 4, 8: 5, 9: 4,
  10: 4, 11: 3, 12: 6, 13: 5, 14: 5, 15: 6, 16: 4, 17: 5, 18: 6,
};
const fullCard = Object.fromEntries(
  Object.entries(strokesByHole).map(([hole, strokes]) => [cellKey(G, Number(hole)), cell(Number(hole), strokes)]),
);

const baseArchive: RoundArchive = {
  roundId: roundId("r1"),
  card: fixtureLinks18,
  participants: [{ golferId: G, name: "Gigi", tee: "white", courseHandicap: 10 }],
  games: [],
  cells: fullCard,
  events: [],
  results: [],
  handicapping: [{ golferId: G, kind: "complete", ags: 90, differential: 12.34 }],
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

  it("surfaces ags/differential when the golfer's handicapping row is complete", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect(line.ags).toBe(90);
    expect(line.differential).toBe(12.34);
  });

  it("omits ags/differential when the golfer's handicapping row is incomplete", () => {
    const incomplete: RoundArchive = { ...baseArchive, handicapping: [{ golferId: G, kind: "incomplete" }] };
    const line = archiveGolferLine(incomplete, G);
    expect(line.ags).toBeUndefined();
    expect(line.differential).toBeUndefined();
  });

  it("carries par (sum of the frozen tee's hole pars) and courseHandicap (frozen at join)", () => {
    const line = archiveGolferLine(baseArchive, G);
    expect(line.par).toBe(72); // fixtureWhite18: 36 + 36
    expect(line.courseHandicap).toBe(10); // baseArchive's participant courseHandicap
  });

  it("surfaces ags with NO differential when the golfer's handicapping row is unrated (unrated-courses spec)", () => {
    const unrated: RoundArchive = { ...baseArchive, handicapping: [{ golferId: G, kind: "unrated", ags: 91 }] };
    const line = archiveGolferLine(unrated, G);
    expect(line.ags).toBe(91);
    expect(line.differential).toBeUndefined();
    // par/courseHandicap are still frozen regardless of handicapping kind.
    expect(line.par).toBe(72);
    expect(line.courseHandicap).toBe(10);
  });

  it("excludes picked-up, conceded, and unscored holes from the distribution (only DECIDED stroke cells count)", () => {
    const sparse: RoundArchive = {
      ...baseArchive,
      cells: {
        [cellKey(G, 1)]: cell(1, 4), // par
        [cellKey(G, 2)]: { result: { kind: "picked-up" }, recordedBy: G, hlc: { wallMs: 2, counter: 0, deviceId: deviceId("d") }, opId: opId("op-pu") },
        [cellKey(G, 3)]: { result: { kind: "conceded" }, recordedBy: G, hlc: { wallMs: 3, counter: 0, deviceId: deviceId("d") }, opId: opId("op-cc") },
        // hole 4 onward: no cell at all — unscored.
      },
    };
    const line = archiveGolferLine(sparse, G);
    expect(line.distribution).toEqual({ eagles: 0, birdies: 0, pars: 1, bogeys: 0, doublePlus: 0 });
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
        [cellKey(G, 2)]: { result: { kind: "picked-up" }, recordedBy: G, hlc: { wallMs: 2, counter: 0, deviceId: deviceId("d") }, opId: opId("op-pu") },
        [cellKey(G, 3)]: { result: { kind: "conceded" }, recordedBy: G, hlc: { wallMs: 3, counter: 0, deviceId: deviceId("d") }, opId: opId("op-cc") },
        // hole 4: no cell at all — unscored.
        [cellKey(G, 5)]: { result: { kind: "cleared" }, recordedBy: G, hlc: { wallMs: 5, counter: 0, deviceId: deviceId("d") }, opId: opId("op-cl") },
      },
    };
    const line = archiveGolferLine(mixed, G);
    expect(line.holeResults).toEqual([
      { hole: 1, par: 4, result: { kind: "strokes", strokes: 5 } },
      { hole: 2, par: 4, result: { kind: "picked-up" } },
      { hole: 3, par: 3, result: { kind: "conceded" } },
      // hole 4 (silence) and hole 5 (cleared) are OMITTED — cellAt's own contract.
    ]);
  });

  it("holeResults and distribution agree — one walk, strokes cells only in the buckets", () => {
    const line = archiveGolferLine(baseArchive, G);
    const strokesHoles = line.holeResults!.filter((h) => h.result.kind === "strokes");
    const bucketTotal =
      line.distribution.eagles + line.distribution.birdies + line.distribution.pars +
      line.distribution.bogeys + line.distribution.doublePlus;
    expect(strokesHoles.length).toBe(bucketTotal);
  });
});
