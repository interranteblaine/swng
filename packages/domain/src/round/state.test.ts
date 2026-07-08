import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { Hlc } from "./hlc.js";
import type { RoundEvent } from "./events.js";
import { cellKey, reduceRound } from "./state.js";

const card: CourseCard = {
  courseName: "Fixture Links",
  teeSets: [{ name: "white", rating: 35.8, slope: 128, holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 5 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 9 },
  ] }],
};
const A = golferId("a");
const B = golferId("b");
const at = (wallMs: number, device = "d1", counter = 0): Hlc => ({ wallMs, counter, deviceId: deviceId(device) });
let op = 0;
const base = (wallMs: number, device?: string) => ({ opId: opId(`op-${op++}`), hlc: at(wallMs, device), authorId: A });

const genesis: RoundEvent = { ...base(1), kind: "round-created", roundId: roundId("r1"), card };
const joinA: RoundEvent = { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 } };
const started: RoundEvent = { ...base(3), kind: "round-started" };

describe("reduceRound", () => {
  it("throws on a log without genesis", () => {
    expect(() => reduceRound([joinA])).toThrowError(/round-log-missing-genesis/);
  });

  it("walks the lifecycle: setup → live → final → live again on reopen", () => {
    expect(reduceRound([genesis]).status).toBe("setup");
    expect(reduceRound([genesis, started]).status).toBe("live");
    const final: RoundEvent = { ...base(4), kind: "round-finalized" };
    const reopened: RoundEvent = { ...base(5), kind: "round-reopened" };
    expect(reduceRound([genesis, started, final]).status).toBe("final");
    expect(reduceRound([genesis, started, final, reopened]).status).toBe("live");
  });

  it("resolves same-cell conflicts by hlc, not arrival order", () => {
    const early: RoundEvent = { ...base(10, "offline-phone"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 6 } };
    const correction: RoundEvent = { ...base(20, "online-phone"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 5 } };
    // The stale offline write ARRIVES LAST — the correction must still win.
    const state = reduceRound([genesis, joinA, started, correction, early]);
    expect(state.cells[cellKey(A, 1)]?.result).toEqual({ kind: "strokes", strokes: 5 });
  });

  it("ignores a verbatim duplicate (same opId)", () => {
    const score: RoundEvent = { ...base(10), kind: "score-recorded", golferId: A, hole: 2, result: { kind: "strokes", strokes: 4 } };
    const once = reduceRound([genesis, joinA, started, score]);
    const twice = reduceRound([genesis, joinA, started, score, score]);
    expect(twice).toEqual(once);
  });

  it("treats a participant re-join as a correcting write (tee fix wins by hlc)", () => {
    const fixedTee: RoundEvent = { ...base(9), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", courseHandicap: 9 } };
    const state = reduceRound([genesis, joinA, fixedTee]);
    expect(state.participants).toHaveLength(1);
    expect(state.participants[0]?.courseHandicap).toBe(9);
  });

  it("skips unknown event kinds (schema tolerance)", () => {
    const alien = { ...base(50), kind: "press-opened", gameId: gameId("g9") } as unknown as RoundEvent;
    expect(reduceRound([genesis, joinA, alien]).participants).toHaveLength(1);
  });

  it("converges on same-opId, same-hlc collisions with different payloads (arrival order must not matter)", () => {
    const collisionHlc = at(30, "device-x");
    const x: RoundEvent = { opId: opId("collide-1"), hlc: collisionHlc, authorId: A, kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 4 } };
    const y: RoundEvent = { opId: opId("collide-1"), hlc: collisionHlc, authorId: A, kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 7 } };
    const forward = reduceRound([genesis, joinA, started, x, y]);
    const backward = reduceRound([genesis, joinA, started, y, x]);
    expect(backward).toEqual(forward);
  });

  it("records picked-up and conceded as first-class results", () => {
    const pu: RoundEvent = { ...base(11), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "picked-up" } };
    const cc: RoundEvent = { ...base(12), kind: "score-recorded", golferId: B, hole: 1, result: { kind: "conceded" } };
    const state = reduceRound([genesis, joinA, started, pu, cc]);
    expect(state.cells[cellKey(A, 1)]?.result.kind).toBe("picked-up");
    expect(state.cells[cellKey(B, 1)]?.result.kind).toBe("conceded");
  });
});
