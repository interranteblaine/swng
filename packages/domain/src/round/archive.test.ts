import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DomainError } from "../errors.js";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import { playGoldenRoundLog } from "../scoring/golden/deck.js";
import { fixtureLinks, fixtureLinks18 } from "../scoring/golden/fixtureCourse.js";
import type { GameConfig } from "../scoring/game.js";
import { settleRound, unresolvedGames } from "./archive.js";
import { cellKey, reduceRound } from "./state.js";
import type { Participant, RosterEntry } from "./participant.js";
import type { RoundEvent } from "./events.js";
import type { RoundState, ScoreCell } from "./state.js";

// The milestone's headline concurrency deck (scoring/concurrent.test.ts): one log, two games
// scoring the same cells by different rules, one correction that recomputes both. Settlement is
// the log's terminal read — this is the deck that has to survive it, corrections included.
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const players3: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", strokes: 3 },
  { golferId: B, name: "Bo", tee: "white", strokes: 0 },
  { golferId: C, name: "Cal", tee: "white", strokes: 5 },
];
const skins = { kind: "skins", id: gameId("k9"), scoring: "net", players: [A, B, C] } as const;
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


describe("settleRound — concurrency deck", () => {
  it("carries both GameResults, settled from the folded state", () => {
    const archive = settleRound(finalLog);
    expect(archive.results).toHaveLength(2);

    const skinsResult = archive.results.find((r) => r.kind === "skins");
    const stablefordResult = archive.results.find((r) => r.kind === "stableford");

    // The settled figures are concurrent.test.ts's own post-correction values, hand-derived there.
    expect(skinsResult).toMatchObject({
      kind: "skins",
      carriedOut: 1,
      won: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 6 },
        { golferId: C, skins: 0 },
      ],
    });
    expect(stablefordResult).toMatchObject({
      kind: "stableford",
      points: [
        { golferId: A, points: 13 },
        { golferId: B, points: 15 },
        { golferId: C, points: 4 },
      ],
    });
  });

  // `archive.handicapping` (per-participant adjusted gross score + differential) is DELETED with
  // the whole WHS pipeline (spec 2026-07-29 §7), and so is the hand-checked-AGS deck that pinned
  // it. What a settled round now says about each player's numbers is their frozen seat plus the
  // cells themselves — asserted here in the terms that survive: the strokes on the roster.
  it("freezes each participant's strokes onto the settled roster", () => {
    const archive = settleRound(finalLog);
    // The numbers this file's own players3 fixture carries, frozen verbatim (spec 2026-07-30 §2).
    expect(archive.participants.map((p) => [p.golferId, p.strokes])).toEqual([
      [A, 3],
      [B, 0],
      [C, 5],
    ]);
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
    const partialPlayers: readonly Participant[] = [
      { golferId: D, name: "Dee", tee: "white", strokes: 0 },
      { golferId: E, name: "Eve", tee: "white", strokes: 3 },
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

// A mid-round strokes correction (spec 2026-07-30 §2) is a plain seat overwrite in the fold
// (state.ts), so settleRound needs no new logic. This pins that passthrough: the corrected
// number, not the join's original one, is what the sealed archive freezes.
describe("settleRound — mid-round strokes correction", () => {
  it("settles the CORRECTED strokes into archive.participants", () => {
    const player: Participant = { golferId: A, name: "Ann", tee: "white", strokes: 8 };
    // 8 vs. 15 on this nine-hole card is a real dot difference (8 dots vs. 15, spread by stroke
    // index), so the frozen seat below genuinely tracks which number won the fold rather than
    // happening to match. The scores themselves are incidental here.
    const annScores = [4, 4, 7, 5, 4, 3, 4, 5, 4];
    const preFinalize = playGoldenRoundLog(fixtureLinks, [player], [], { [A]: annScores }, [], false);
    const lastWallMs = Math.max(...preFinalize.map((event) => event.hlc.wallMs));
    const set: RoundEvent = {
      kind: "participant-strokes-set",
      golferId: A,
      strokes: 15,
      opId: opId("set-strokes-settle"),
      hlc: { wallMs: lastWallMs + 1, counter: 0, deviceId: deviceId("test") },
      authorId: A,
    };
    const finalize: RoundEvent = {
      kind: "round-finalized",
      opId: opId("finalize-correction"),
      hlc: { wallMs: lastWallMs + 2, counter: 0, deviceId: deviceId("test") },
      authorId: A,
    };
    const archive = settleRound([...preFinalize, set, finalize]);

    // The seat's strokes are the corrected value, not the join's original 8.
    expect(archive.participants.find((p) => p.golferId === A)?.strokes).toBe(15);
  });
});

describe("settleRound — game termination", () => {
  const D = golferId("dee");
  const E = golferId("eve");
  const partialPlayers: readonly Participant[] = [
    { golferId: D, name: "Dee", tee: "white", strokes: 0 },
    { golferId: E, name: "Eve", tee: "white", strokes: 3 },
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

// Leaving a round (accounts-only identity spec §4): "leaving stops the future and never
// rewrites the past." settleRound applies departure rules ADDITIVELY on top of the ordinary
// settle — played holes and resolved games count exactly as scored/resolved (concessions
// included), a `departed: true` flag rides along on the departed player's archive entry, and
// the single empty-case rule below OMITS a departed participant who has nothing to aggregate
// (no scored holes, no game membership) so they appear nowhere downstream — because there is
// nothing to settle, not because a reader filtered them.
describe("settleRound — participant departure", () => {
  const nineA = [5, 5, 4, 6, 5, 4, 5, 6, 4];
  const nineB = [4, 5, 3, 6, 4, 4, 4, 5, 4];
  const nineC = [6, 7, 4, 8, 6, 5, 6, 7, 6];
  const stablefordAB = { kind: "stableford", id: gameId("s-ab"), players: [A, B] } as const;
  const leaveC: RoundEvent = { kind: "participant-left", golferId: C, opId: opId("leave-c"), hlc: { wallMs: 5_000, counter: 0, deviceId: deviceId("test") }, authorId: C };
  const finalizeAt = (wallMs: number, id: string): RoundEvent => ({ kind: "round-finalized", opId: opId(id), hlc: { wallMs, counter: 0, deviceId: deviceId("test") }, authorId: A });

  it("OMITS a departed participant with zero scored holes AND zero game membership — no entry, no line, nowhere downstream", () => {
    // Cal joins, is in no game, records no scores, then leaves. Ann/Bo play a stableford.
    const log = [
      ...playGoldenRoundLog(fixtureLinks, players3, [stablefordAB], { [A]: nineA, [B]: nineB, [C]: [] }, [], false),
      leaveC,
      finalizeAt(6_000, "final-omit"),
    ];
    const archive = settleRound(log);
    expect(archive.participants.map((p) => p.golferId)).toEqual([A, B]); // Cal is gone entirely
    expect(archive.results).toHaveLength(1);
    expect(archive.results[0]).toMatchObject({ kind: "stableford", id: stablefordAB.id });
  });

  it("KEEPS a departed participant who scored holes — settles their played holes normally, flags departed: true", () => {
    const log = [
      ...playGoldenRoundLog(fixtureLinks, players3, [stablefordAB], { [A]: nineA, [B]: nineB, [C]: [6, 7, 4] }, [], false),
      leaveC,
      finalizeAt(6_000, "final-keep"),
    ];
    const archive = settleRound(log);
    expect(archive.participants.map((p) => p.golferId)).toEqual([A, B, C]);
    const cal = archive.participants.find((p) => p.golferId === C);
    expect(cal?.departed).toBe(true);
    // Cal played only 3 holes → exactly those three cells are archived, honestly partial rather
    // than padded out or omitted (the settled line built from them carries no `score`, per
    // golfer/record.ts's own hasCompleteScore gate).
    expect([1, 2, 3].map((h) => archive.cells[cellKey(C, h)] !== undefined)).toEqual([true, true, true]);
    expect([4, 5, 6, 7, 8, 9].map((h) => archive.cells[cellKey(C, h)])).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it("settles a mid-round departure the SAME as no departure — differing ONLY in the departed player's unscored holes and flag, never another player's results", () => {
    const withoutDeparture = settleRound(playGoldenRoundLog(fixtureLinks, players3, [stablefordAB], { [A]: nineA, [B]: nineB, [C]: nineC }, [], true));
    const withDeparture = settleRound([
      // The identical deck, except Cal stops after hole 6 and leaves (holes 7-9 unscored).
      ...playGoldenRoundLog(fixtureLinks, players3, [stablefordAB], { [A]: nineA, [B]: nineB, [C]: [6, 7, 4, 8, 6, 5] }, [], false),
      leaveC,
      finalizeAt(6_000, "final-diff"),
    ]);

    // The stableford result (Ann vs Bo) is byte-identical — Cal's absence changed nothing.
    expect(withDeparture.results).toEqual(withoutDeparture.results);
    // Ann's and Bo's cells are identical hole-for-hole; only Cal's holes 7-9 differ.
    for (const g of [A, B]) {
      for (let h = 1; h <= 9; h++) expect(withDeparture.cells[cellKey(g, h)]).toEqual(withoutDeparture.cells[cellKey(g, h)]);
    }
    for (let h = 7; h <= 9; h++) {
      expect(withoutDeparture.cells[cellKey(C, h)]).toBeDefined();
      expect(withDeparture.cells[cellKey(C, h)]).toBeUndefined();
    }
    // The only participant-entry difference is Cal's departed flag.
    expect(withDeparture.participants.map((p) => p.golferId)).toEqual([A, B, C]);
    expect(withDeparture.participants.find((p) => p.golferId === C)?.departed).toBe(true);
    const calWithout = withoutDeparture.participants.find((p) => p.golferId === C)!;
    expect("departed" in calWithout).toBe(false);
  });
});

describe("settleRound — a match closed out on an incomplete card", () => {
  it("resolves a match decided early while both golfers' cards stay incomplete (holes 8-9 never recorded)", () => {
    const D = golferId("dee");
    const E = golferId("eve");
    const twoPlayers: readonly Participant[] = [
      { golferId: D, name: "Dee", tee: "white", strokes: 6 },
      { golferId: E, name: "Eve", tee: "white", strokes: 0 },
    ];
    const match = { kind: "singles-match", id: gameId("m2"), a: D, b: E } as const;
    // Same shape as singlesMatch.test.ts's "the difference between the two closes it out 3&2"
    // deck (Dee/Eve standing in for that test's Ann/Bo, same numbers): Dee on 6 against Eve on 0,
    // so Dee gets 6 dots on SI 1..6 (holes 1,2,4,7,8,9). h1 halve(4/4),
    // h2 Dee(4/5), h3 Dee(3/4), h4 halve(5/5), h5 Dee(4/5), h6 Eve(4/3), h7 Dee(4/5)
    // -> Dee 3 up thru 7, 2 remaining -> closes out 3&2. Holes 8-9 are never recorded
    // for either golfer, so the round finalizes with the game RESOLVED while both cards are
    // short of a full 9. Settlement must not object: a match that is mathematically over needs
    // no more holes, and an unfinished card is the ordinary v1 case (spec §2d — such a round
    // simply carries no score into the golfer's average).
    const log = playGoldenRoundLog(fixtureLinks, twoPlayers, [match], {
      [D]: [5, 5, 3, 6, 4, 4, 5],
      [E]: [4, 5, 4, 5, 5, 3, 5],
    });
    const archive = settleRound(log);

    expect(archive.results).toHaveLength(1);
    expect(archive.results[0]).toMatchObject({ kind: "singles-match", outcome: { winner: D, closing: "3&2" } });

    // Both cards stop at hole 7 — the archive records exactly that, no filler.
    expect(archive.participants.map((p) => p.golferId)).toEqual([D, E]);
    for (const g of [D, E]) {
      expect(archive.cells[cellKey(g, 7)]).toBeDefined();
      expect(archive.cells[cellKey(g, 8)]).toBeUndefined();
      expect(archive.cells[cellKey(g, 9)]).toBeUndefined();
    }
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
  // playedAtMs is set equal to this fixture's own genesis hlc.wallMs (1) — this fixture is about
  // the stray crewId key, not playedAtMs, so its meaning stays byte-identical.
  const legacyGenesisWithStrayCrewId = (): RoundEvent =>
    ({
      kind: "round-created",
      roundId: roundId("r-legacy"),
      card: fixtureLinks,
      crewId: "saturday-boys", // the stray key an M8-era log still carries
      playedAtMs: 1,
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

// unresolvedGames is the finalize dialog's live readiness view (task 3 of the "domain owns the
// golf math" arc) — the SAME must-resolve set settleRound's own throw path enforces above,
// walked without throwing. This deck was hand-picked to match apps/web's own former
// finalizeReadiness.test.ts fixture exactly (Ann full 18, Pat stops at hole 1) so the web's
// byte-identical-strings claim has something concrete to check against: this pins the
// STRUCTURED domain shape the web now formats into that same "holes 2–18 unscored for Pat" line.
describe("unresolvedGames — finalize readiness", () => {
  const ANN = golferId("ann");
  const PAT = golferId("pat");
  // unresolvedGames reads no strokes at all — it walks games and cells — so these numbers are
  // only here to make the roster a real one.
  const participants: readonly RosterEntry[] = [
    { golferId: ANN, name: "Ann", tee: "white", strokes: 6 },
    { golferId: PAT, name: "Pat", tee: "white", strokes: 0 },
  ];
  let opCounter = 0;
  const cell = (result: ScoreCell["result"], recordedBy: typeof ANN): ScoreCell => ({
    result,
    recordedBy,
    hlc: { wallMs: 1, counter: 0, deviceId: deviceId("d") },
    opId: opId(`op-unresolved-${(opCounter += 1)}`),
  });
  const stablefordConfig: GameConfig = { kind: "stableford", id: gameId("g-stableford"), players: [ANN, PAT] };
  const skinsConfig: GameConfig = { kind: "skins", id: gameId("g-skins"), scoring: "net", players: [ANN, PAT] };
  const holes = fixtureLinks18.teeSets[0]!.holes;

  // Ann's fully scored (holes 1-18); Pat only played hole 1 — holes 2-18 unscored for Pat.
  const cellsWithPatStoppedAtHole1: RoundState["cells"] = {
    ...Object.fromEntries(holes.map((h) => [cellKey(ANN, h.number), cell({ kind: "strokes", strokes: 4 }, ANN)])),
    [cellKey(PAT, 1)]: cell({ kind: "strokes", strokes: 5 }, PAT),
  };

  const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
    id: roundId("round-unresolved"),
    status: "live",
    card: fixtureLinks18,
    participants,
    games: [stablefordConfig],
    cells: {},
    terminatedGameIds: new Set(),
    playedAtMs: 1,
    holes: "all",
    ...overrides,
  });

  it("is empty when every game has resolved", () => {
    const cells = Object.fromEntries(
      holes.flatMap((h) => [
        [cellKey(ANN, h.number), cell({ kind: "strokes", strokes: 4 }, ANN)],
        [cellKey(PAT, h.number), cell({ kind: "strokes", strokes: 4 }, PAT)],
      ]),
    );
    expect(unresolvedGames(baseState({ cells }))).toEqual([]);
  });

  it("names an unresolved game by id, with the missing hole numbers per golfer", () => {
    const state = baseState({ cells: cellsWithPatStoppedAtHole1 });

    expect(unresolvedGames(state)).toEqual([{ gameId: stablefordConfig.id, missing: [{ golferId: PAT, holes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] }] }]);
  });

  it("excludes a terminated game even though its cells are still incomplete", () => {
    const state = baseState({ cells: cellsWithPatStoppedAtHole1, terminatedGameIds: new Set([stablefordConfig.id]) });
    expect(unresolvedGames(state)).toEqual([]);
  });

  it("lists multiple unresolved games independently, one per game — the SAME set settleRound would throw game-unresolved on", () => {
    const state = baseState({ games: [stablefordConfig, skinsConfig], cells: cellsWithPatStoppedAtHole1 });

    const result = unresolvedGames(state);
    expect(result.map((r) => r.gameId)).toEqual([stablefordConfig.id, skinsConfig.id]);
    expect(result.every((r) => r.missing.length === 1 && r.missing[0]!.golferId === PAT)).toBe(true);
  });

  it("names EXACTLY the game settleRound itself throws game-unresolved on — the reuse proof", () => {
    const D = golferId("dee");
    const E = golferId("eve");
    const partialPlayers: readonly Participant[] = [
      { golferId: D, name: "Dee", tee: "white", strokes: 0 },
      { golferId: E, name: "Eve", tee: "white", strokes: 3 },
    ];
    const partialGame = { kind: "stroke-play", id: gameId("sp1"), scoring: "gross", players: [D, E] } as const;
    const partialLog = playGoldenRoundLog(
      fixtureLinks,
      partialPlayers,
      [partialGame],
      { [D]: [4, 5, 3, 6, 4], [E]: [5, 5, 4, 6, 5, 3, 4, 5, 4] },
      [],
      true,
    );

    const attempt = () => settleRound(partialLog);
    expect(attempt).toThrowError(expect.objectContaining({ code: "game-unresolved" }));

    const liveState = reduceRound(partialLog);
    const unresolved = unresolvedGames(liveState);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.gameId).toBe(partialGame.id);
    // Dee has 5 of 9 holes; the missing set names exactly the 4 unscored ones, Eve absent
    // entirely (she's fully scored — nothing to report for her).
    expect(unresolved[0]!.missing).toEqual([{ golferId: D, holes: [6, 7, 8, 9] }]);
  });
});
