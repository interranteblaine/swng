import { describe, expect, it } from "vitest";
import { deviceId, golferId, opId, roundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { Hlc } from "./hlc.js";
import type { RoundEvent } from "./events.js";
import { reduceRound } from "./state.js";
import { playedAtMsOf } from "./playedAt.js";

// Minimal fixture card — playedAtMsOf never reads it, but round-created carries one regardless.
const card: CourseCard = {
  courseName: "Fixture Links",
  teeSets: [{ name: "white", rating: 35.8, slope: 128, holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] }],
};
const A = golferId("a");
const at = (wallMs: number, device = "d1", counter = 0): Hlc => ({ wallMs, counter, deviceId: deviceId(device) });
let op = 0;
const base = (wallMs: number, device?: string) => ({ opId: opId(`op-${op++}`), hlc: at(wallMs, device), authorId: A });

const genesis = (playedAtMs: number, wallMs = 1): RoundEvent => ({ ...base(wallMs), kind: "round-created", roundId: roundId("r1"), card, playedAtMs });
const playedAtSet = (playedAtMs: number, wallMs: number): RoundEvent => ({ ...base(wallMs), kind: "round-played-at-set", playedAtMs });

describe("playedAtMsOf", () => {
  it("returns the genesis event's own playedAtMs when no correction exists", () => {
    expect(playedAtMsOf([genesis(1_000)])).toBe(1_000);
  });

  it("a later round-played-at-set wins", () => {
    const events = [genesis(1_000, 1), playedAtSet(5_000, 10)];
    expect(playedAtMsOf(events)).toBe(5_000);
  });

  it("an hlc-EARLIER set does not win", () => {
    // Two corrections: the hlc-LATER one carries 5_000, the hlc-EARLIER one carries 9_000 —
    // appended in the WRONG array order (the hlc-later event first, the hlc-earlier event
    // last). That arrangement is exactly what would fool a "last element in the array wins"
    // implementation (it would return 9_000, the earlier-hlc event's value, because it's last
    // in the array) AND a "largest playedAtMs value wins" implementation (it would also return
    // 9_000, since 9_000 > 5_000). The correct rule — highest hlc wins — answers 5_000, which
    // is distinct from both wrong answers, so this test cannot pass by accident under either bug.
    const hlcLater = playedAtSet(5_000, 20);
    const hlcEarlier = playedAtSet(9_000, 10);
    const events = [genesis(1_000, 1), hlcLater, hlcEarlier];
    expect(playedAtMsOf(events)).toBe(5_000);
  });

  it("resolves by hlc, not arrival order", () => {
    const hlcLater = playedAtSet(5_000, 20);
    const hlcEarlier = playedAtSet(9_000, 10);
    const forward = playedAtMsOf([genesis(1_000, 1), hlcLater, hlcEarlier]);
    const reversed = playedAtMsOf([genesis(1_000, 1), hlcEarlier, hlcLater]);
    expect(reversed).toBe(forward);
    expect(reversed).toBe(5_000);
  });

  it("throws on a log with no round-created", () => {
    // A round-played-at-set with no genesis at all — not just an empty log. This is the
    // stronger case: it pins that presence of genesis is checked explicitly, not inferred from
    // "was playedAtMs ever assigned" (a correction alone would otherwise assign it and the
    // missing-genesis corruption would go undetected).
    expect(() => playedAtMsOf([playedAtSet(5_000, 10)])).toThrowError(/round-log-missing-genesis/);
  });
});

describe("reduceRound", () => {
  it("state.playedAtMs equals playedAtMsOf for the same log — the one-rule pin", () => {
    // Fails the moment reduceRound grows its own copy of the rule instead of delegating.
    const events = [genesis(1_000, 1), playedAtSet(5_000, 10)];
    expect(reduceRound(events).playedAtMs).toBe(playedAtMsOf(events));
  });
});
