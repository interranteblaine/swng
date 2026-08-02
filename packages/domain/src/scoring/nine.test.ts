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
    expect(resultOf(match)).toBeDefined();
  });

  it("still needs all eighteen when the round set out to play eighteen", () => {
    const events = backNineRound().map((e) => (e.kind === "round-created" ? { ...e, holes: "all" as const } : e));
    const state = reduceRound(events);
    expect(resultOf(scoreGame(state.games[0]!, state))).toBeUndefined();
  });
});
