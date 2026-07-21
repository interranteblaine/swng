import { describe, expect, it } from "vitest";
import type { CourseCard } from "../course/card.js";
import { gameId, golferId, roundId } from "../ids.js";
import type { RoundId } from "../ids.js";
import type { RoundArchive } from "../round/archive.js";
import { aggregateSeason, crewContribution } from "./ledger.js";
import type { CrewRoundContribution } from "./ledger.js";

// Alphabetical golferIds so lexicographic canonicalization (headToHead's a<b) lines up
// with the letters used throughout — A < B < C < D both as names and as ids.
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const D = golferId("dee");

const emptyCard: CourseCard = { courseName: "Fixture", teeSets: [] };

// crewContribution only reads roundId, games, and results (see ledger.ts) — the rest of
// RoundArchive's required fields are harmless placeholders, per the brief's "you don't
// need to run settleRound to build test fixtures."
const buildArchive = (input: {
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

describe("crewContribution — hand-pin (brief's exact fixture)", () => {
  const singlesConfig = { kind: "singles-match", id: gameId("singles-1"), a: A, b: B } as const;
  const skinsConfig = { kind: "skins", id: gameId("skins-1"), players: [A, B, C, D] } as const;
  const stablefordConfig = { kind: "stableford", id: gameId("stableford-1"), players: [A, B, C, D] } as const;

  const archive = buildArchive({
    games: [singlesConfig, skinsConfig, stablefordConfig],
    results: [
      { kind: "singles-match", id: singlesConfig.id, outcome: { winner: A, closing: "3&2" }, thru: 16 },
      {
        kind: "skins",
        id: skinsConfig.id,
        won: [
          { golferId: A, skins: 3 },
          { golferId: B, skins: 0 },
          { golferId: C, skins: 2 },
          { golferId: D, skins: 0 },
        ],
        carriedOut: 0,
      },
      {
        kind: "stableford",
        id: stablefordConfig.id,
        points: [
          { golferId: A, points: 36 },
          { golferId: B, points: 34 },
          { golferId: C, points: 33 },
          { golferId: D, points: 31 },
        ],
      },
    ],
  });

  it("produces the exact hand-pinned lines and headToHead", () => {
    const contribution = crewContribution(archive);
    expect(contribution.roundId).toBe(archive.roundId);
    expect(contribution.lines).toEqual([
      { golferId: A, wins: 1, losses: 0, halves: 0, points: 36, skins: 3 },
      { golferId: B, wins: 0, losses: 1, halves: 0, points: 34, skins: 0 },
      { golferId: C, wins: 0, losses: 0, halves: 0, points: 33, skins: 2 },
      { golferId: D, wins: 0, losses: 0, halves: 0, points: 31, skins: 0 },
    ]);
    expect(contribution.headToHead).toEqual([{ a: A, b: B, outcome: "a" }]);
  });
});

describe("crewContribution — per-kind rules", () => {
  it("singles-match halved: both +1 half; headToHead canonicalizes a<b regardless of the config's own a/b order", () => {
    // Config's own a/b is B, A — canonicalization must still put A first (lexicographic).
    const config = { kind: "singles-match", id: gameId("singles-halved"), a: B, b: A } as const;
    const archive = buildArchive({ games: [config], results: [{ kind: "singles-match", id: config.id, outcome: { halved: true }, thru: 18 }] });
    const contribution = crewContribution(archive);
    expect(contribution.lines).toEqual([
      { golferId: A, wins: 0, losses: 0, halves: 1, points: 0, skins: 0 },
      { golferId: B, wins: 0, losses: 0, halves: 1, points: 0, skins: 0 },
    ]);
    expect(contribution.headToHead).toEqual([{ a: A, b: B, outcome: "halved" }]);
  });

  it("fourball-match: winning side +1 win each, losing side +1 loss each, NO headToHead entry (v1 is singles-only)", () => {
    const config = { kind: "fourball-match", id: gameId("fourball-1"), a: [A, B], b: [C, D] } as const;
    const archive = buildArchive({ games: [config], results: [{ kind: "fourball-match", id: config.id, outcome: { winner: "a", closing: "2&1" }, thru: 17 }] });
    const contribution = crewContribution(archive);
    expect(contribution.lines).toEqual([
      { golferId: A, wins: 1, losses: 0, halves: 0, points: 0, skins: 0 },
      { golferId: B, wins: 1, losses: 0, halves: 0, points: 0, skins: 0 },
      { golferId: C, wins: 0, losses: 1, halves: 0, points: 0, skins: 0 },
      { golferId: D, wins: 0, losses: 1, halves: 0, points: 0, skins: 0 },
    ]);
    expect(contribution.headToHead).toEqual([]);
  });

  it("fourball-match halved: all four +1 half", () => {
    const config = { kind: "fourball-match", id: gameId("fourball-halved"), a: [A, B], b: [C, D] } as const;
    const archive = buildArchive({ games: [config], results: [{ kind: "fourball-match", id: config.id, outcome: { halved: true }, thru: 18 }] });
    const contribution = crewContribution(archive);
    // .every() on an empty array is vacuously true — pin the length too, or a regression that
    // drops all four lines would pass this assertion silently (M8 close-out fix #8).
    expect(contribution.lines).toHaveLength(4);
    expect(contribution.lines.every((line) => line.halves === 1)).toBe(true);
    expect(contribution.headToHead).toEqual([]);
  });

  it("stroke-play contributes NOTHING — a golfer in ONLY a stroke-play game gets no line", () => {
    const config = { kind: "stroke-play", id: gameId("sp-1"), scoring: "gross", players: [A, B] } as const;
    const archive = buildArchive({
      games: [config],
      results: [
        {
          kind: "stroke-play",
          id: config.id,
          scoring: "gross",
          lines: [
            { golferId: A, thru: 18, gross: { total: 72, pickups: 0 } },
            { golferId: B, thru: 18, gross: { total: 80, pickups: 0 } },
          ],
        },
      ],
    });
    const contribution = crewContribution(archive);
    expect(contribution.lines).toEqual([]);
    expect(contribution.headToHead).toEqual([]);
  });

  it("a terminated game (config present, no results entry) contributes nothing", () => {
    const config = { kind: "singles-match", id: gameId("terminated-1"), a: A, b: B } as const;
    const archive = buildArchive({ games: [config], results: [] });
    const contribution = crewContribution(archive);
    expect(contribution.lines).toEqual([]);
    expect(contribution.headToHead).toEqual([]);
  });
});

describe("aggregateSeason", () => {
  // "A 2-1-0 vs B": across three rounds A beats B twice and loses once, never halved —
  // plus points/skins accumulation and a golfer (C) who only shows up in one round, to
  // pin that `rounds` counts contributions-with-a-line, not total contributions.
  const round1: CrewRoundContribution = {
    roundId: roundId("r1"),
    lines: [
      { golferId: A, wins: 1, losses: 0, halves: 0, points: 30, skins: 1 },
      { golferId: B, wins: 0, losses: 1, halves: 0, points: 28, skins: 0 },
    ],
    headToHead: [{ a: A, b: B, outcome: "a" }],
  };
  const round2: CrewRoundContribution = {
    roundId: roundId("r2"),
    lines: [
      { golferId: A, wins: 1, losses: 0, halves: 0, points: 32, skins: 2 },
      { golferId: B, wins: 0, losses: 1, halves: 0, points: 29, skins: 0 },
      { golferId: C, wins: 0, losses: 0, halves: 0, points: 20, skins: 0 },
    ],
    headToHead: [{ a: A, b: B, outcome: "a" }],
  };
  const round3: CrewRoundContribution = {
    roundId: roundId("r3"),
    lines: [
      { golferId: A, wins: 0, losses: 1, halves: 0, points: 25, skins: 0 },
      { golferId: B, wins: 1, losses: 0, halves: 0, points: 31, skins: 3 },
    ],
    headToHead: [{ a: A, b: B, outcome: "b" }],
  };
  const contributions = [round1, round2, round3];

  const expected = {
    ledger: [
      { golferId: A, rounds: 3, wins: 2, losses: 1, halves: 0, points: 87, skins: 3 },
      { golferId: B, rounds: 3, wins: 1, losses: 2, halves: 0, points: 88, skins: 3 },
      { golferId: C, rounds: 1, wins: 0, losses: 0, halves: 0, points: 20, skins: 0 },
    ],
    headToHead: [{ a: A, b: B, aWins: 2, bWins: 1, halves: 0 }],
  };

  it("hand-pin: 3-round fixture sums to the expected ledger and head-to-head", () => {
    expect(aggregateSeason(contributions)).toEqual(expected);
  });

  it("is order-independent: every permutation (3! = 6) of the 3 contributions produces the identical output", () => {
    const [x, y, z] = contributions as [CrewRoundContribution, CrewRoundContribution, CrewRoundContribution];
    const permutations: readonly (readonly CrewRoundContribution[])[] = [
      [x, y, z],
      [x, z, y],
      [y, x, z],
      [y, z, x],
      [z, x, y],
      [z, y, x],
    ];
    for (const permutation of permutations) {
      expect(aggregateSeason(permutation)).toEqual(expected);
    }
  });

  it("returns empty ledger and headToHead for no contributions", () => {
    expect(aggregateSeason([])).toEqual({ ledger: [], headToHead: [] });
  });

  // Standings order is domain truth, served (domain-boundary arc precedent) — the web no longer
  // ranks the ledger client-side, so aggregateSeason's own comparator must be TOTAL: wins desc,
  // then points desc, then golferId asc as the final tiebreak (never left to sort stability).
  // A: wins 3 — alone at the top. B/D: wins 2, points 50 — a FULL tie (equal wins AND equal
  // points), broken by golferId asc (bo < dee). C: wins 2, points 20 — same wins tier as B/D but
  // fewer points, so it sorts after both despite "cal" < "dee" lexicographically (proving points
  // outranks golferId in the comparator, not just a lucky alphabetical coincidence).
  it("ledger orders by wins desc, then points desc, then golferId asc as the final tiebreak (a full tie on wins AND points)", () => {
    const contribution: CrewRoundContribution = {
      roundId: roundId("r-order"),
      lines: [
        { golferId: A, wins: 3, losses: 0, halves: 0, points: 10, skins: 0 },
        { golferId: B, wins: 2, losses: 0, halves: 0, points: 50, skins: 0 },
        { golferId: C, wins: 2, losses: 0, halves: 0, points: 20, skins: 0 },
        { golferId: D, wins: 2, losses: 0, halves: 0, points: 50, skins: 0 },
      ],
      headToHead: [],
    };

    const { ledger } = aggregateSeason([contribution]);
    expect(ledger.map((line) => line.golferId)).toEqual([A, B, D, C]);
  });
});
