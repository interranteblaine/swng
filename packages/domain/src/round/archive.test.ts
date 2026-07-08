import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DomainError } from "../errors.js";
import { gameId, golferId } from "../ids.js";
import { adjustedGrossScore, scoreDifferential } from "../handicap/whs.js";
import { playGoldenRoundLog } from "../scoring/golden/deck.js";
import { fixtureLinks, fixtureWhite } from "../scoring/golden/fixtureCourse.js";
import { settleRound } from "./archive.js";

// The milestone's headline concurrency deck (scoring/concurrent.test.ts): one log, two
// games with different handicap allowances over the same cells, one correction that
// recomputes both. Settlement is the log's terminal read — this is the deck that has to
// survive it, corrections included.
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const players3 = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
];
const skins = { kind: "skins", id: gameId("k9"), players: [A, B, C] } as const;
const stableford = { kind: "stableford", id: gameId("s9"), players: [A, B, C] } as const;
const cards = {
  [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
  [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
  [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
} as const;
// Ann's h9 pickup was wrong — she holed out in 4 gross. A later-hlc correction (see
// deck.ts) is what makes her card COMPLETE, which is exactly the case settlement needs
// to exercise: nobody is "incomplete" post-correction.
const corrections = [{ golfer: A, hole: 9, score: 4 }] as const;

const finalLog = playGoldenRoundLog(fixtureLinks, players3, [skins, stableford], cards, corrections);

// Hand-checked against Rule 3.1b (net double bogey never caps here — every gross score on
// every player's card is under their per-hole cap post-correction, so AGS = gross sum):
// Ann 5+5+4+6+5+4+5+6+4 = 44, Bo 4+5+3+6+4+4+4+5+4 = 39, Cal 6+7+4+8+6+5+6+7+6 = 55.
const HAND_CHECKED_AGS: Readonly<Record<string, number>> = { [A]: 44, [B]: 39, [C]: 55 };

describe("settleRound — concurrency deck", () => {
  it("carries both GameResults, settled from the folded state", () => {
    const archive = settleRound(finalLog);
    expect(archive.results).toHaveLength(2);

    const skinsResult = archive.results.find((r) => r.kind === "skins");
    const stablefordResult = archive.results.find((r) => r.kind === "stableford");

    expect(skinsResult).toMatchObject({
      kind: "skins",
      carriedOut: 0,
      won: [
        { golferId: A, skins: 8 },
        { golferId: B, skins: 1 },
        { golferId: C, skins: 0 },
      ],
    });
    expect(stablefordResult).toMatchObject({
      kind: "stableford",
      points: [
        { golferId: A, points: 18 },
        { golferId: B, points: 17 },
        { golferId: C, points: 10 },
      ],
    });
  });

  it("resolves all three golfers' handicapping as complete, with hand-checked AGS", () => {
    const archive = settleRound(finalLog);
    expect(archive.handicapping).toHaveLength(3);

    for (const entry of archive.handicapping) {
      expect(entry.kind).toBe("complete");
      const ags = HAND_CHECKED_AGS[entry.golferId]!;
      expect(entry).toMatchObject({ kind: "complete", ags });
      if (entry.kind === "complete") {
        // Cross-checked against the WHS primitives directly (already conformance-tested
        // in handicap/whs.test.ts against published examples), not a re-hardcoded float.
        expect(entry.differential).toBeCloseTo(scoreDifferential(fixtureWhite, ags), 9);
      }
    }
  });

  it("round-trips the game configs, participants, card, and cells straight from the folded state", () => {
    const archive = settleRound(finalLog);
    expect(archive.card).toEqual(fixtureLinks);
    expect(archive.participants.map((p) => p.golferId)).toEqual([A, B, C]);
    expect(archive.games.map((g) => g.id)).toEqual([skins.id, stableford.id]);
    expect(Object.keys(archive.cells)).toHaveLength(3 * 9);
  });

  it("throws round-not-final on a log that never finalized", () => {
    const liveLog = playGoldenRoundLog(fixtureLinks, players3, [skins, stableford], cards, corrections, false);
    const attempt = () => settleRound(liveLog);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "round-not-final" }));
  });

  it("throws game-unresolved when a finalized log leaves a game incomplete", () => {
    const D = golferId("dee");
    const E = golferId("eve");
    const partialPlayers = [
      { golferId: D, name: "Dee", tee: "white", courseHandicap: 5 },
      { golferId: E, name: "Eve", tee: "white", courseHandicap: 10 },
    ];
    const partialGame = { kind: "stroke-play", id: gameId("sp1"), scoring: "gross", players: [D, E] } as const;
    // Dee only has 5 of 9 holes recorded — the round still gets finalized (a crew can
    // absolutely fat-finger "finalize" early, or the log is simply incomplete), so
    // scoreStrokePlay's `complete` stays false and resultOf yields no GameResult.
    const partialLog = playGoldenRoundLog(
      fixtureLinks,
      partialPlayers,
      [partialGame],
      { [D]: [4, 5, 3, 6, 4], [E]: [5, 5, 4, 6, 5, 3, 4, 5, 4] },
      [],
      true,
    );
    const attempt = () => settleRound(partialLog);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "game-unresolved" }));
  });
});

describe("settleRound — determinism", () => {
  it("is order-independent: JSON.stringify is identical for any shuffle of the same log", () => {
    const expected = JSON.stringify(settleRound(finalLog));
    fc.assert(
      fc.property(fc.shuffledSubarray([...finalLog], { minLength: finalLog.length, maxLength: finalLog.length }), (shuffled) => {
        expect(JSON.stringify(settleRound(shuffled))).toBe(expected);
      }),
    );
  });

  it("double-settles byte-identical: re-settling the archive's own canonical events reproduces it exactly", () => {
    const first = settleRound(finalLog);
    const second = settleRound(first.events);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is a pure function of its input: settling the same log twice is byte-identical", () => {
    expect(JSON.stringify(settleRound(finalLog))).toBe(JSON.stringify(settleRound(finalLog)));
  });

  it("strips seq from every archived event's envelope", () => {
    const archive = settleRound(finalLog);
    expect(archive.events.every((event) => !("seq" in event))).toBe(true);
  });

  it("orders archived events in canonical domain order (ascending hlc.wallMs, the golden deck's monotone clock)", () => {
    const archive = settleRound(finalLog);
    const wallTimes = archive.events.map((event) => event.hlc.wallMs);
    expect(wallTimes).toEqual([...wallTimes].sort((a, b) => a - b));
  });
});

// adjustedGrossScore is exercised indirectly above through settleRound; this just pins the
// hand-checked AGS figures themselves against the primitive directly, independent of the
// archive wiring, so a regression in either place fails on its own.
describe("hand-checked AGS sanity", () => {
  it("matches Ann/Bo/Cal's post-correction AGS", () => {
    const holesFor = (scores: ReadonlyArray<number | "picked-up" | "conceded">) =>
      new Map(scores.map((score, index) => [index + 1, typeof score === "number" ? { kind: "strokes" as const, strokes: score } : { kind: score }]));
    expect(adjustedGrossScore(fixtureWhite, 8, holesFor([5, 5, 4, 6, 5, 4, 5, 6, 4]))).toBe(44);
    expect(adjustedGrossScore(fixtureWhite, 2, holesFor([4, 5, 3, 6, 4, 4, 4, 5, 4]))).toBe(39);
    expect(adjustedGrossScore(fixtureWhite, 12, holesFor([6, 7, 4, 8, 6, 5, 6, 7, 6]))).toBe(55);
  });
});
