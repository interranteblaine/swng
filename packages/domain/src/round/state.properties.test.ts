import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deviceId, golferId, opId, roundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { RoundEvent } from "./events.js";
import { reduceRound } from "./state.js";

const card: CourseCard = {
  courseName: "Fixture Links",
  teeSets: [{ name: "white", rating: 35.8, slope: 128, holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 2 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 3 },
  ] }],
};
const golfers = [golferId("a"), golferId("b")];

const genesis: RoundEvent = {
  kind: "round-created", roundId: roundId("r1"), card,
  opId: opId("genesis"), hlc: { wallMs: 0, counter: 0, deviceId: deviceId("d0") }, authorId: golfers[0]!,
};

const scoreEvent = fc
  .record({
    golfer: fc.constantFrom(...golfers),
    hole: fc.integer({ min: 1, max: 3 }),
    strokes: fc.integer({ min: 1, max: 10 }),
    wallMs: fc.integer({ min: 1, max: 1_000 }),
    counter: fc.integer({ min: 0, max: 3 }),
    device: fc.constantFrom("d1", "d2", "d3"),
    op: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ golfer, hole, strokes, wallMs, counter, device, op }): RoundEvent => ({
    kind: "score-recorded", golferId: golfer, hole,
    result: { kind: "strokes", strokes },
    opId: opId(`op-${op}`), hlc: { wallMs, counter, deviceId: deviceId(device) }, authorId: golfer,
  }));

describe("reduceRound convergence", () => {
  it("is order-independent: any shuffle of the same events folds to the same state", () => {
    fc.assert(
      fc.property(fc.array(scoreEvent, { maxLength: 40 }), fc.infiniteStream(fc.nat()), (events, seeds) => {
        const log = [genesis, ...events];
        const shuffled = [...log]
          .map((e) => ({ e, k: seeds.next().value ?? 0 }))
          .sort((x, y) => x.k - y.k)
          .map(({ e }) => e);
        expect(reduceRound(shuffled)).toEqual(reduceRound(log));
      }),
    );
  });

  it("is idempotent under replay: folding the log twice-over changes nothing", () => {
    fc.assert(
      fc.property(fc.array(scoreEvent, { maxLength: 40 }), (events) => {
        const log = [genesis, ...events];
        expect(reduceRound([...log, ...log])).toEqual(reduceRound(log));
      }),
    );
  });
});
