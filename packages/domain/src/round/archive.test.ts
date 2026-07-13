import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DomainError } from "../errors.js";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import { adjustedGrossScore, scoreDifferential } from "../handicap/whs.js";
import { playGoldenRoundLog } from "../scoring/golden/deck.js";
import { fixtureLinks, fixtureWhite } from "../scoring/golden/fixtureCourse.js";
import { settleRound } from "./archive.js";
import { reduceRound } from "./state.js";
import type { RoundEvent } from "./events.js";

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

describe("settleRound — game termination", () => {
  const D = golferId("dee");
  const E = golferId("eve");
  const partialPlayers = [
    { golferId: D, name: "Dee", tee: "white", courseHandicap: 5 },
    { golferId: E, name: "Eve", tee: "white", courseHandicap: 10 },
  ];
  // Dee only has 5 of 9 holes recorded, so a game needing HER card never resolves;
  // a second game scoped to Eve alone (whose card is full) resolves independently —
  // exactly the "one resolved game, one terminated-unresolved game" shape the brief
  // pins, so termination is provably what unlocks settlement, not incidental slack.
  const unresolvedGame = { kind: "stroke-play", id: gameId("sp-unresolved"), scoring: "gross", players: [D, E] } as const;
  const resolvedGame = { kind: "stroke-play", id: gameId("sp-resolved"), scoring: "gross", players: [E] } as const;
  const scores = { [D]: [4, 5, 3, 6, 4], [E]: [5, 5, 4, 6, 5, 3, 4, 5, 4] };
  const baseLog = playGoldenRoundLog(fixtureLinks, partialPlayers, [unresolvedGame, resolvedGame], scores, [], false);
  const terminate = {
    kind: "game-terminated" as const,
    gameId: unresolvedGame.id,
    opId: opId("terminate-1"),
    hlc: { wallMs: 9_000, counter: 0, deviceId: deviceId("test") },
    authorId: D,
  };
  const finalize = {
    kind: "round-finalized" as const,
    opId: opId("finalize-1"),
    hlc: { wallMs: 9_001, counter: 0, deviceId: deviceId("test") },
    authorId: D,
  };

  it("throws game-unresolved on this exact round WITHOUT the termination (baseline for the next test)", () => {
    const attempt = () => settleRound([...baseLog, finalize]);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "game-unresolved" }));
  });

  it("settles the SAME round once the unresolved game is terminated: results exclude it, terminatedGameIds records it, games keeps both configs", () => {
    const archive = settleRound([...baseLog, terminate, finalize]);
    expect(archive.terminatedGameIds).toEqual([unresolvedGame.id]);
    expect(archive.results).toHaveLength(1);
    expect(archive.results[0]).toMatchObject({ kind: "stroke-play", id: resolvedGame.id });
    expect(archive.games.map((g) => g.id)).toEqual([unresolvedGame.id, resolvedGame.id]);
  });

  // The filter in archive.ts is `!state.terminatedGameIds.has(config.id)` — unconditional on
  // whether the game WOULD have resolved. Every case above terminates a game that's stuck
  // (unresolved) — this pins the other arm: a game whose cards are already complete, that
  // would resolve cleanly on its own, gets excluded from `results` just the same once
  // terminated. Termination is a game-management decision (e.g. voiding a side bet mid-round),
  // never merely a rescue for data that can't otherwise settle.
  it("excludes a game from results once terminated, even though it would have resolved cleanly on its own", () => {
    const resolvableGame = { kind: "stroke-play", id: gameId("sp-resolvable"), scoring: "gross", players: [D, E] } as const;
    const fullScores = { [D]: [4, 5, 3, 6, 4, 4, 5, 4, 4], [E]: [5, 5, 4, 6, 5, 3, 4, 5, 4] };
    const resolvableLog = playGoldenRoundLog(fixtureLinks, partialPlayers, [resolvableGame], fullScores, [], false);
    const terminateResolvable = { ...terminate, gameId: resolvableGame.id, opId: opId("terminate-resolvable") };

    // Baseline: WITHOUT termination, this exact round settles fine and the game DOES resolve —
    // proof termination isn't rescuing anything here.
    const baseline = settleRound([...resolvableLog, finalize]);
    expect(baseline.results).toHaveLength(1);
    expect(baseline.results[0]).toMatchObject({ kind: "stroke-play", id: resolvableGame.id });

    const archive = settleRound([...resolvableLog, terminateResolvable, finalize]);
    expect(archive.terminatedGameIds).toEqual([resolvableGame.id]);
    expect(archive.results).toHaveLength(0);
  });
});

// A scrapped round produces NO snapshot, ever — it counts nowhere (task-15). settleRound is the
// structural enforcement point: it refuses an abandoned log outright, so no archive / handicap
// index / crew season can ever derive a result from one.
describe("settleRound — abandoned round", () => {
  const abandonAt = (wallMs: number, id: string): RoundEvent => ({
    kind: "round-abandoned",
    opId: opId(id),
    hlc: { wallMs, counter: 0, deviceId: deviceId("test") },
    authorId: A,
  });

  it("throws round-abandoned on an abandoned log — a scrapped round has no snapshot", () => {
    const liveLog = playGoldenRoundLog(fixtureLinks, players3, [skins, stableford], cards, corrections, false);
    const attempt = () => settleRound([...liveLog, abandonAt(9_000, "abandon-1")]);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "round-abandoned" }));
  });

  it("throws round-abandoned even when a later round-finalized rode the log too (abandon dominates settlement)", () => {
    const liveLog = playGoldenRoundLog(fixtureLinks, players3, [skins, stableford], cards, corrections, false);
    const finalizeLate: RoundEvent = {
      kind: "round-finalized",
      opId: opId("finalize-late"),
      hlc: { wallMs: 9_500, counter: 0, deviceId: deviceId("test") },
      authorId: A,
    };
    // The finalize has a LATER hlc than the abandon — this IS finalizeRound's own candidate log
    // — yet settlement still refuses it as abandoned, never producing a snapshot: the code
    // returned is round-abandoned, not round-not-final, so the caller (finalizeRound) surfaces
    // the honest terminal-state error rather than a misleading "not final yet."
    const attempt = () => settleRound([...liveLog, abandonAt(9_000, "abandon-2"), finalizeLate]);
    expect(attempt).toThrowError(expect.objectContaining({ code: "round-abandoned" }));
  });
});

describe("settleRound — incomplete handicapping", () => {
  it("resolves a match decided early while both golfers' cards stay incomplete (holes 8-9 never recorded)", () => {
    const D = golferId("dee");
    const E = golferId("eve");
    const twoPlayers = [
      { golferId: D, name: "Dee", tee: "white", courseHandicap: 8 },
      { golferId: E, name: "Eve", tee: "white", courseHandicap: 2 },
    ];
    const match = { kind: "singles-match", id: gameId("m2"), a: D, b: E } as const;
    // Same shape as singlesMatch.test.ts's "full-difference strokes close it out 3&2"
    // deck (Dee/Eve standing in for that test's Ann/Bo, same course handicaps): Dee
    // (higher, ch 8) gets 6 dots on SI 1..6 (holes 1,2,4,7,8,9). h1 halve(4/4),
    // h2 Dee(4/5), h3 Dee(3/4), h4 halve(5/5), h5 Dee(4/5), h6 Eve(4/3), h7 Dee(4/5)
    // -> Dee 3 up thru 7, 2 remaining -> closes out 3&2. Holes 8-9 are never recorded
    // for either golfer, so the round finalizes with the game resolved but both
    // cards short of a full 9 — exactly the "holes-undecided" path handicappingFor
    // catches and downgrades to "incomplete" rather than throwing.
    const log = playGoldenRoundLog(fixtureLinks, twoPlayers, [match], {
      [D]: [5, 5, 3, 6, 4, 4, 5],
      [E]: [4, 5, 4, 5, 5, 3, 5],
    });
    const archive = settleRound(log);

    expect(archive.results).toHaveLength(1);
    expect(archive.results[0]).toMatchObject({ kind: "singles-match", outcome: { winner: D, closing: "3&2" } });

    expect(archive.handicapping).toHaveLength(2);
    expect(archive.handicapping).toEqual(
      expect.arrayContaining([
        { golferId: D, kind: "incomplete" },
        { golferId: E, kind: "incomplete" },
      ]),
    );
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

  it("is independent of seq: stamping seq onto every event of the log settles byte-identically to the unstamped log", () => {
    // The strip-seq test above only proves the OUTPUT carries no seq; it's vacuous
    // against a broken strip because this golden log never stamps seq in the first
    // place. This test stamps one on, so a regression that lets seq leak into
    // canonicalStringify's tiebreak (or into the archive's own fields) would fail it.
    const stamped: readonly RoundEvent[] = finalLog.map((event, index) => ({ ...event, seq: index }));
    expect(JSON.stringify(settleRound(stamped))).toBe(JSON.stringify(settleRound(finalLog)));
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

// Round-is-a-sealed-leaf (realignment, spec 2026-07-12): a round names no crew — not in its
// events, not in the folded state, not in the settled archive. The crew tag M8 stamped on
// round-created is gone; a crew now references a finished round inbound (counts it by roundId
// into a season), never the reverse. The event log is append-only, though, so a genesis event
// left over from the M8 era with a stray `crewId` JSON key must still parse and fold — this
// pins tolerate-and-strip at the fold: the extra key is ignored, and NO crewId key survives
// onto state or archive.
describe("round is a sealed leaf — no crewId on state or archive", () => {
  const at = (wallMs: number) => ({ wallMs, counter: 0, deviceId: deviceId("test") });
  const recorder = golferId("recorder");

  // An old stored genesis carrying a stray crewId JSON key. The current RoundEvent type has no
  // such field, so the key is injected through an unknown-cast — exactly the shape a log
  // written under M8's schema deserializes into today.
  const legacyGenesisWithStrayCrewId = (): RoundEvent =>
    ({
      kind: "round-created",
      roundId: roundId("r-legacy"),
      card: fixtureLinks,
      crewId: "saturday-boys", // the stray key an M8-era log still carries
      opId: opId("op-created"),
      hlc: at(1),
      authorId: recorder,
    }) as unknown as RoundEvent;

  it("reduceRound over a genesis with a stray crewId key produces state with NO crewId property", () => {
    const started: RoundEvent = { kind: "round-started", opId: opId("op-started"), hlc: at(2), authorId: recorder };
    const state = reduceRound([legacyGenesisWithStrayCrewId(), started]);
    // `in`, not toBeUndefined(): an explicit-undefined key passes toBeUndefined() and vitest's
    // toEqual ignores undefined-valued keys entirely — the distinction that matters here (and
    // to DynamoDB's marshall() downstream) is whether the KEY exists at all.
    expect("crewId" in state).toBe(false);
  });

  it("settleRound over that same legacy genesis yields an archive with NO crewId property", () => {
    const started: RoundEvent = { kind: "round-started", opId: opId("op-started"), hlc: at(2), authorId: recorder };
    const finalized: RoundEvent = { kind: "round-finalized", opId: opId("op-finalized"), hlc: at(3), authorId: recorder };
    const archive = settleRound([legacyGenesisWithStrayCrewId(), started, finalized]);
    expect("crewId" in archive).toBe(false);
  });

  it("a folded RoundState from a plain log has NO crewId key at all", () => {
    const state = reduceRound(finalLog);
    expect("crewId" in state).toBe(false);
  });

  it("a settled archive from a plain log has NO crewId key at all", () => {
    const archive = settleRound(finalLog);
    expect("crewId" in archive).toBe(false);
  });
});
