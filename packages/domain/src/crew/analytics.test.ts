import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { GolferId, RoundId } from "../ids.js";
import type { CourseCard, TeeSet } from "../course/card.js";
import { fixtureLinks, fixtureLinks18 } from "../scoring/golden/fixtureCourse.js";
import type { RoundArchive } from "../round/archive.js";
import { cellKey } from "../round/state.js";
import type { ScoreCell } from "../round/state.js";
import type { SeasonLedgerLine } from "./ledger.js";
import { mostImproved, netAverages, partnerRecords, stablefordTitle } from "./analytics.js";

// Alphabetical golferIds so lexicographic pair/tie-break comparisons line up with the letters
// used throughout — the ledger.test.ts precedent (A < B < C < D as both names and ids).
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const D = golferId("dee");
const E = golferId("eli");

// ---- partnerRecords fixtures — configForResult only reads archive.games/archive.results
// (ledger.test.ts's own buildArchive precedent), so participants/cells/card are harmless filler.
const emptyCard: CourseCard = { courseName: "Fixture", teeSets: [] };
const buildResultArchive = (input: {
  readonly roundId?: RoundId;
  readonly games: RoundArchive["games"];
  readonly results: RoundArchive["results"];
}): RoundArchive => ({
  roundId: input.roundId ?? roundId("r1"),
  card: emptyCard,
  participants: [],
  cells: {},
  events: [],
  terminatedGameIds: [],
  handicapping: [],
  games: input.games,
  results: input.results,
});

describe("partnerRecords — four-ball sides only (analytics spec 2026-07-21 §5)", () => {
  it("excludes a side whose partner isn't a current roster member, even when the other side's a member", () => {
    const config = { kind: "fourball-match", id: gameId("fb-1"), a: [A, B], b: [C, D] } as const;
    const archive = buildResultArchive({
      games: [config],
      results: [{ kind: "fourball-match", id: config.id, outcome: { winner: "a", closing: "2&1" }, thru: 17 }],
    });
    // B is not a member — the A/B side is excluded outright even though A itself is a member.
    const members = new Set<GolferId>([A, C, D]);
    expect(partnerRecords([archive], members)).toEqual([{ a: C, b: D, wins: 0, losses: 1, halves: 0 }]);
  });

  it("halved fourball gives BOTH sides' pairs a half", () => {
    const config = { kind: "fourball-match", id: gameId("fb-2"), a: [A, B], b: [C, D] } as const;
    const archive = buildResultArchive({
      games: [config],
      results: [{ kind: "fourball-match", id: config.id, outcome: { halved: true }, thru: 18 }],
    });
    const members = new Set<GolferId>([A, B, C, D]);
    expect(partnerRecords([archive], members)).toEqual([
      { a: A, b: B, wins: 0, losses: 0, halves: 1 },
      { a: C, b: D, wins: 0, losses: 0, halves: 1 },
    ]);
  });

  it("sorts wins desc, then a asc, then b asc — pair identity is lexicographic regardless of the config's own a/b order", () => {
    const members = new Set<GolferId>([A, B, C, D]);
    // (A,B) wins twice across two rounds using the SAME a/b sides.
    const config1 = { kind: "fourball-match", id: gameId("fb-3"), a: [A, B], b: [C, D] } as const;
    const round1 = buildResultArchive({
      roundId: roundId("r1"),
      games: [config1],
      results: [{ kind: "fourball-match", id: config1.id, outcome: { winner: "a", closing: "3&2" }, thru: 16 }],
    });
    const round2 = buildResultArchive({
      roundId: roundId("r2"),
      games: [config1],
      results: [{ kind: "fourball-match", id: config1.id, outcome: { winner: "a", closing: "1up" }, thru: 18 }],
    });
    // A THIRD round re-pairs everyone: (A,C) vs (B,D) — "b" side (B,D) wins once, giving (A,C)
    // one loss and (B,D) one win — two more pairs to exercise the zero-wins tie-break.
    const config2 = { kind: "fourball-match", id: gameId("fb-4"), a: [A, C], b: [B, D] } as const;
    const round3 = buildResultArchive({
      roundId: roundId("r3"),
      games: [config2],
      results: [{ kind: "fourball-match", id: config2.id, outcome: { winner: "b", closing: "4&3" }, thru: 15 }],
    });

    expect(partnerRecords([round1, round2, round3], members)).toEqual([
      { a: A, b: B, wins: 2, losses: 0, halves: 0 }, // wins desc: 2 first
      { a: B, b: D, wins: 1, losses: 0, halves: 0 }, // then 1
      { a: A, b: C, wins: 0, losses: 1, halves: 0 }, // 0-wins tie: "ann" < "cal" (a asc)
      { a: C, b: D, wins: 0, losses: 2, halves: 0 },
    ]);
  });
});

// ---- netAverages fixtures — real archives (cells/participants/card) since netAverages reads
// through archiveGolferLine, unlike partnerRecords' config-only reach.
const cell = (golfer: GolferId, hole: number, strokes: number): ScoreCell => ({
  result: { kind: "strokes", strokes },
  recordedBy: golfer,
  hlc: { wallMs: hole, counter: 0, deviceId: deviceId("d") },
  opId: opId(`op-${golfer}-${hole}`),
});

// Every hole at par except the first, which absorbs whatever remainder makes the round's gross
// come out to exactly `gross` (golfer/analytics.test.ts's own roundOf precedent) — the per-hole
// numbers aren't meant to be plausible golf, just a fold input with a pinned gross.
const cellsForGross = (golfer: GolferId, teeSet: TeeSet, gross: number): Record<string, ScoreCell> => {
  const [first, ...rest] = teeSet.holes;
  const restSum = rest.reduce((sum, h) => sum + h.par, 0);
  const entries: [string, ScoreCell][] = [
    [cellKey(golfer, first!.number), cell(golfer, first!.number, gross - restSum)],
    ...rest.map((h): [string, ScoreCell] => [cellKey(golfer, h.number), cell(golfer, h.number, h.par)]),
  ];
  return Object.fromEntries(entries);
};

// One golfer's fully holed-out round at a given course handicap — participants/cells/handicapping
// built together so archiveGolferLine (netAverages' own read path) resolves cleanly.
const roundOf = (id: string, card: CourseCard, teeSet: TeeSet, golfer: GolferId, courseHandicap: number, gross: number): RoundArchive => ({
  roundId: roundId(id),
  card,
  participants: [{ golferId: golfer, name: String(golfer), tee: teeSet.name, courseHandicap }],
  games: [],
  cells: cellsForGross(golfer, teeSet, gross),
  events: [],
  results: [],
  handicapping: [{ golferId: golfer, kind: "complete", ags: gross, differential: 0 }],
  terminatedGameIds: [],
});

const links9 = fixtureLinks.teeSets[0]!;
const links18 = fixtureLinks18.teeSets[0]!;

describe("netAverages — lowest net average, per hole count, qualified members only (analytics spec §5)", () => {
  it("splits 9s from 18s and drops a 2-round hole count that never reaches the 3-round floor", () => {
    const members = new Set<GolferId>([A]);
    const nineRounds = [
      roundOf("a-nine-1", fixtureLinks, links9, A, 4, 40),
      roundOf("a-nine-2", fixtureLinks, links9, A, 4, 42),
    ];
    // Nets 82, 83, 85 at CH 8 — mean 250/3 = 83.333..., rounds half-up to 83.3.
    const eighteenRounds = [
      roundOf("a-18-1", fixtureLinks18, links18, A, 8, 90),
      roundOf("a-18-2", fixtureLinks18, links18, A, 8, 91),
      roundOf("a-18-3", fixtureLinks18, links18, A, 8, 93),
    ];

    // Only the qualifying (>=3) 18-hole group survives — the 2-round 9-hole group is dropped
    // whole, never shown as its own line and never blended into the 18s.
    expect(netAverages([...nineRounds, ...eighteenRounds], members)).toEqual([{ golferId: A, holes: 18, rounds: 3, average: 83.3 }]);
  });

  it("omits a member entirely below the 3-round floor at their only hole count (never a zero, never a partial line)", () => {
    const members = new Set<GolferId>([B]);
    const rounds = [roundOf("b-18-1", fixtureLinks18, links18, B, 5, 85), roundOf("b-18-2", fixtureLinks18, links18, B, 5, 87)];

    expect(netAverages(rounds, members)).toEqual([]);
  });

  it("sorts average asc then golferId asc, and skips a non-participant member without throwing", () => {
    const members = new Set<GolferId>([A, C, D]); // D never appears in any archive
    const lowNet = [
      roundOf("c-18-1", fixtureLinks18, links18, C, 0, 70),
      roundOf("c-18-2", fixtureLinks18, links18, C, 0, 70),
      roundOf("c-18-3", fixtureLinks18, links18, C, 0, 70),
    ]; // net 70 flat, average 70.0
    const higherNet = [
      roundOf("a-18-1", fixtureLinks18, links18, A, 8, 90),
      roundOf("a-18-2", fixtureLinks18, links18, A, 8, 90),
      roundOf("a-18-3", fixtureLinks18, links18, A, 8, 90),
    ]; // net 82 flat, average 82.0

    expect(netAverages([...lowNet, ...higherNet], members)).toEqual([
      { golferId: C, holes: 18, rounds: 3, average: 70 },
      { golferId: A, holes: 18, rounds: 3, average: 82 },
    ]);
  });
});

describe("mostImproved — application-computed entries in, drops only (analytics spec §5)", () => {
  it("excludes a riser (to >= from) and a member with an undefined end, sorted by drop desc then golferId asc", () => {
    const entries = [
      { golferId: D, from: 20.0, to: 15.0 }, // drop 5.0
      { golferId: A, from: 12.0, to: 8.0 }, // drop 4.0
      { golferId: B, from: 10.0, to: 12.0 }, // a RISE — excluded
      { golferId: C, from: 9.0, to: undefined }, // undefined end — excluded
      { golferId: E, from: undefined, to: 5.0 }, // undefined start — excluded
    ];

    expect(mostImproved(entries)).toEqual([
      { golferId: D, from: 20.0, to: 15.0 },
      { golferId: A, from: 12.0, to: 8.0 },
    ]);
  });

  it("golferId asc breaks a tied drop", () => {
    expect(
      mostImproved([
        { golferId: D, from: 10, to: 8 },
        { golferId: A, from: 12, to: 10 },
      ]),
    ).toEqual([
      { golferId: A, from: 12, to: 10 },
      { golferId: D, from: 10, to: 8 },
    ]);
  });

  it("returns [] when nobody drops (an unchanged index is not an improvement)", () => {
    expect(mostImproved([{ golferId: A, from: 10, to: 10 }])).toEqual([]);
  });
});

describe("stablefordTitle — season points leader(s) of a roster-filtered ledger (analytics spec §5)", () => {
  const line = (golferId: GolferId, points: number): SeasonLedgerLine => ({ golferId, rounds: 1, wins: 0, losses: 0, halves: 0, points, skins: 0 });

  it("a tie for the lead returns BOTH golfers", () => {
    expect(stablefordTitle([line(A, 40), line(B, 40), line(C, 30)])).toEqual([A, B]);
  });

  it("returns [] when the leading points are 0 — a scoreless season crowns no one", () => {
    expect(stablefordTitle([line(A, 0), line(B, 0)])).toEqual([]);
  });

  it("returns [] for an empty ledger", () => {
    expect(stablefordTitle([])).toEqual([]);
  });
});
