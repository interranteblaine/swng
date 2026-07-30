import { describe, expect, it } from "vitest";
import { gameId, golferId, roundId } from "../ids.js";
import type { GolferId, RoundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { RoundArchive } from "../round/archive.js";
import { partnerRecords } from "./analytics.js";

// Alphabetical golferIds so lexicographic pair/tie-break comparisons line up with the letters
// used throughout — the ledger.test.ts precedent (A < B < C < D as both names and ids).
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const D = golferId("dee");

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
