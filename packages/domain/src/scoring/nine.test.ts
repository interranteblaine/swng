import { describe, expect, it } from "vitest";
import type { CourseCard } from "../course/card.js";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { Hlc } from "../round/hlc.js";
import type { RoundEvent } from "../round/events.js";
import { reduceRound } from "../round/state.js";
import { roundStrokeAllocation, totalDots } from "./allocation.js";
import { scoreGame } from "./game.js";
import { resultOf } from "./result.js";

// The conventional split: odd stroke indexes on the front, even on the back.
const card: CourseCard = {
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

const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const D = golferId("dee");
let op = 0;
const at = (wallMs: number): Hlc => ({ wallMs, counter: 0, deviceId: deviceId("d1") });
const base = (wallMs: number) => ({ opId: opId(`op-${op++}`), hlc: at(wallMs), authorId: A });
const BACK_NINE = [10, 11, 12, 13, 14, 15, 16, 17, 18];

const backNineRound = (): RoundEvent[] => {
  const events: RoundEvent[] = [
    { ...base(1), kind: "round-created", roundId: roundId("r1"), card, playedAtMs: 1, holes: "back" },
    { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 5 } },
    { ...base(3), kind: "participant-joined", participant: { golferId: B, name: "Bo", tee: "white", strokes: 0 } },
    { ...base(4), kind: "round-started" },
    { ...base(5), kind: "game-added", config: { kind: "skins", id: gameId("g1"), scoring: "net", players: [A, B] } },
  ];
  for (const hole of BACK_NINE) {
    events.push({ ...base(10 + hole), kind: "score-recorded", golferId: A, hole, result: { kind: "strokes", strokes: 5 } });
    events.push({ ...base(40 + hole), kind: "score-recorded", golferId: B, hole, result: { kind: "strokes", strokes: 4 } });
  }
  return events;
};

describe("a nine played on an 18-hole card (spec 2026-08-02)", () => {
  it("gives the player every stroke they typed, on the hardest of the nine played", () => {
    const state = reduceRound(backNineRound());
    const dots = roundStrokeAllocation(state.participants, state.card, state.holes).get(A)!;
    expect(totalDots(dots)).toBe(5);
    // Ranked among the back nine: hole 10 (SI 2) is rank 1, then 11, 12, 13, 14. Five strokes over
    // nine holes is base 0 with 5 extras, so ranks 1-5 each take one dot.
    expect(Object.fromEntries(dots)).toEqual({ 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 0, 16: 0, 17: 0, 18: 0 });
  });

  it("resolves its games once the nine is scored", () => {
    const state = reduceRound(backNineRound());
    expect(resultOf(scoreGame(state.games[0]!, state))).toBeDefined();
  });

  // A match's closing arithmetic counts the holes the ROUND has left, not the card's — using the
  // round's own nine as the ladder's holeCount is what lets it walk from hole 10 at all (no cell
  // for holes 1-9 is ever recorded on a back-nine round; the pre-threading code read the whole
  // 18-hole card here and stalled at thru=0, hole 1 never having a cell).
  //
  // Deviation from the plan's own fixture comment, hand-verified against the unmodified
  // allocateStrokes/matchLadder (spec 2026-08-02, task-3 finding): Ann's 5 dots land on the SAME
  // five holes as the round-level allocation above (10-14, the hardest of the nine played) and
  // exactly cancel her one extra stroke there — those five holes HALVE, they are not Bo wins. Bo
  // only wins outright on 15-18, where Ann has no dot: 3 up with 1 to play after hole 17, so the
  // match closes 3&1 without ever reaching hole 18 (thru=8, not 9).
  it("closes a match over nine holes, not eighteen", () => {
    // Typed explicitly: TS 5.5+ infers `.filter((e) => e.kind !== "game-added")` as a type
    // predicate over this discriminated union, narrowing the array to exclude that arm — which
    // then rejects the very "game-added" event pushed below. The annotation restores the plain
    // `RoundEvent[]` the array actually is.
    const events: RoundEvent[] = backNineRound().filter((e) => e.kind !== "game-added");
    events.push({ ...base(6), kind: "game-added", config: { kind: "singles-match", id: gameId("g2"), a: A, b: B } });
    const state = reduceRound(events);
    const match = scoreGame(state.games[0]!, state);
    expect(match.kind).toBe("singles-match");
    expect((match as { thru: number }).thru).toBe(8);
    // The outcome itself, not just "it terminated" — pins the DIRECTION of the allocation (Bo,
    // "b", is the one who wins) rather than merely that the ladder closed. Review finding: an
    // allocation bug handing Ann's dots to Bo would still close the match; only this line, not
    // `thru` alone, would catch it.
    expect(resultOf(match)).toMatchObject({ outcome: { winner: B, closing: "3&1" } });
  });

  it("still needs all eighteen when the round set out to play eighteen", () => {
    const events = backNineRound().map((e) => (e.kind === "round-created" ? { ...e, holes: "all" as const } : e));
    const state = reduceRound(events);
    expect(resultOf(scoreGame(state.games[0]!, state))).toBeUndefined();
  });

  // Review finding (task-3): the four cases above cover skins and singles-match only. Stroke play,
  // stableford, and four-ball each have their own hole-list read and are covered here — each case
  // is hand-derived to produce a DIFFERENT number under the pre-threading (whole-18-hole) code, not
  // merely "the game resolves."

  it("four-ball's holeCount counts the round's own nine, not the card's eighteen", () => {
    // Same shape and same numbers as the singles-match case above, run 2v2: Ann/Cal (both 5
    // strokes) vs Bo/Dee (both 0). Identical partners mean each side's sideBest is just that
    // shared net every hole, so the trace is byte-identical to the singles derivation: holes
    // 10-14 halve (Ann/Cal's dot cancels their one extra stroke), Bo/Dee win 15-17 outright,
    // closing 3&1 at thru=8 without ever reaching hole 18.
    //
    // The bug this catches: if `playerTeeSet`'s holes reverted to the whole 18-hole card,
    // fourballMatch's `holeCount` (fourballMatch.ts:25) would be 18 and its `winners` map would
    // walk from hole 1 — where nobody has ever recorded a cell on a back-nine round — so
    // `matchLadder` would break on the very first (undefined) entry and the match would simply
    // never close (thru=0). That failure is SILENT in a live view (no error, just a match that
    // never resolves), which is exactly why this case exists.
    const events: RoundEvent[] = [
      { ...base(1), kind: "round-created", roundId: roundId("r-fb"), card, playedAtMs: 1, holes: "back" },
      { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 5 } },
      { ...base(3), kind: "participant-joined", participant: { golferId: B, name: "Bo", tee: "white", strokes: 0 } },
      { ...base(4), kind: "participant-joined", participant: { golferId: C, name: "Cal", tee: "white", strokes: 5 } },
      { ...base(5), kind: "participant-joined", participant: { golferId: D, name: "Dee", tee: "white", strokes: 0 } },
      { ...base(6), kind: "round-started" },
      { ...base(7), kind: "game-added", config: { kind: "fourball-match", id: gameId("g3"), a: [A, C], b: [B, D] } },
    ];
    for (const hole of BACK_NINE) {
      events.push({ ...base(100 + hole), kind: "score-recorded", golferId: A, hole, result: { kind: "strokes", strokes: 5 } });
      events.push({ ...base(200 + hole), kind: "score-recorded", golferId: C, hole, result: { kind: "strokes", strokes: 5 } });
      events.push({ ...base(300 + hole), kind: "score-recorded", golferId: B, hole, result: { kind: "strokes", strokes: 4 } });
      events.push({ ...base(400 + hole), kind: "score-recorded", golferId: D, hole, result: { kind: "strokes", strokes: 4 } });
    }
    const state = reduceRound(events);
    const match = scoreGame(state.games[0]!, state);
    expect(match.kind).toBe("fourball-match");
    expect((match as { thru: number }).thru).toBe(8);
    expect(resultOf(match)).toMatchObject({ outcome: { winner: "b", closing: "3&1" } });
  });

  it("stroke play's parThru baseline is the back nine's own par, not the front nine's", () => {
    // A card whose front and back nines carry DIFFERENT pars — the shared `card` fixture above is
    // uniform par 4 everywhere, so a wrong (front-nine) hole list would sum to the SAME parThru as
    // the right (back-nine) one and this bug would be invisible. Here front = par 4 (sum 36 over
    // 9 holes), back = par 5 (sum 45 over 9 holes).
    const splitParCard: CourseCard = {
      courseName: "Split Par GC",
      teeSets: [
        {
          name: "white",
          holes: Array.from({ length: 18 }, (_, i) => ({
            number: i + 1,
            par: i < 9 ? 4 : 5,
            yardage: 400,
            strokeIndex: i < 9 ? i * 2 + 1 : (i - 9) * 2 + 2,
          })),
        },
      ],
    };
    const events: RoundEvent[] = [
      { ...base(1), kind: "round-created", roundId: roundId("r-sp"), card: splitParCard, playedAtMs: 1, holes: "back" },
      { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 0 } },
      { ...base(3), kind: "round-started" },
      { ...base(4), kind: "game-added", config: { kind: "stroke-play", id: gameId("g4"), scoring: "gross", players: [A] } },
    ];
    // Ann shoots exactly par (5) on every back-nine hole — thru ends at 9 either way (the loop
    // skips the front nine's cell-less holes rather than breaking), but the bug lives in
    // `parThru`'s `holes.slice(0, thru)`: the RIGHT hole list slices the back nine itself (par 45,
    // relativeToPar 0); the pre-threading code's `holes` was the whole 18-hole card, whose first
    // 9 elements are the FRONT nine (par 36), misreporting relativeToPar as +9.
    for (const hole of BACK_NINE) {
      events.push({ ...base(10 + hole), kind: "score-recorded", golferId: A, hole, result: { kind: "strokes", strokes: 5 } });
    }
    const state = reduceRound(events);
    const line = (scoreGame(state.games[0]!, state) as { lines: readonly { golferId: string; relativeToPar: number }[] }).lines[0]!;
    expect(line.relativeToPar).toBe(0);
  });

  it("stableford allocates its dot onto the actual hole played, not the SAME-RANK hole of the whole card", () => {
    // Ann's 1 stroke should land on hole 10 — SI 2, the hardest of the BACK NINE (the nine
    // actually played). Ranked against the whole 18-hole card instead, the single hardest hole is
    // hole 1 (SI 1, on the never-scored front nine) — so the dot would land nowhere Ann ever
    // played, and every back-nine hole would score at raw gross instead of one being reduced by a
    // dot. That distinguishes a correct 19 points (3 on the dotted hole + 2 × 8) from a buggy 18
    // (2 × 9, no hole ever sees its dot).
    const events: RoundEvent[] = [
      { ...base(1), kind: "round-created", roundId: roundId("r-sf"), card, playedAtMs: 1, holes: "back" },
      { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 1 } },
      { ...base(3), kind: "round-started" },
      { ...base(4), kind: "game-added", config: { kind: "stableford", id: gameId("g5"), players: [A] } },
    ];
    for (const hole of BACK_NINE) {
      events.push({ ...base(10 + hole), kind: "score-recorded", golferId: A, hole, result: { kind: "strokes", strokes: 4 } });
    }
    const state = reduceRound(events);
    const line = (scoreGame(state.games[0]!, state) as { lines: readonly { golferId: string; points: number }[] }).lines[0]!;
    expect(line.points).toBe(19);
  });
});
