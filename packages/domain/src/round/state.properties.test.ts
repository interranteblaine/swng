import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
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
// Three candidate golfers (not two) so participant-joined/game-added coverage
// exercises a roster wider than "everyone always joins."
const golfers = [golferId("a"), golferId("b"), golferId("c")];

// playedAtMs is set equal to genesis's own hlc.wallMs (0) so this fixture's meaning stays
// byte-identical — none of the property tests below are about playedAtMs.
const genesis: RoundEvent = {
  kind: "round-created", roundId: roundId("r1"), card, playedAtMs: 0,
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

// Distinct opId prefix per event kind ("join-"/"game-" vs scoreEvent's "op-")
// so events of different kinds never collide under reduceRound's opId dedupe —
// each pool member's op range only needs to be unique among same-kind events.
const participantJoinedEvent = fc
  .record({
    golfer: fc.constantFrom(...golfers),
    strokes: fc.integer({ min: 0, max: 36 }), // varying — exercises LWW correction on re-join, not just first-write
    wallMs: fc.integer({ min: 1, max: 1_000 }),
    counter: fc.integer({ min: 0, max: 3 }),
    device: fc.constantFrom("d1", "d2", "d3"),
    op: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ golfer, strokes, wallMs, counter, device, op }): RoundEvent => ({
    kind: "participant-joined",
    participant: { golferId: golfer, name: golfer, tee: "white", strokes },
    opId: opId(`join-${op}`), hlc: { wallMs, counter, deviceId: deviceId(device) }, authorId: golfer,
  }));

const gameAddedEvent = fc
  .record({
    id: fc.integer({ min: 0, max: 4 }),
    scoring: fc.constantFrom("gross", "net"),
    wallMs: fc.integer({ min: 1, max: 1_000 }),
    counter: fc.integer({ min: 0, max: 3 }),
    device: fc.constantFrom("d1", "d2", "d3"),
    op: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ id, scoring, wallMs, counter, device, op }): RoundEvent => ({
    kind: "game-added",
    config: { kind: "stroke-play", id: gameId(`g${id}`), scoring, players: golfers },
    opId: opId(`game-${op}`), hlc: { wallMs, counter, deviceId: deviceId(device) }, authorId: golfers[0]!,
  }));

// gameId pool intentionally overlaps gameAddedEvent's (g0..g4): a termination
// drawn independently of an add is exactly what exercises the "terminate arrives
// before its game-added" ordering (state.ts's terminated-set invariant) for free
// under any shuffle, without a dedicated deck.
const gameTerminatedEvent = fc
  .record({
    id: fc.integer({ min: 0, max: 4 }),
    wallMs: fc.integer({ min: 1, max: 1_000 }),
    counter: fc.integer({ min: 0, max: 3 }),
    device: fc.constantFrom("d1", "d2", "d3"),
    op: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ id, wallMs, counter, device, op }): RoundEvent => ({
    kind: "game-terminated",
    gameId: gameId(`g${id}`),
    opId: opId(`terminate-${op}`), hlc: { wallMs, counter, deviceId: deviceId(device) }, authorId: golfers[0]!,
  }));

// A strokes correction (spec 2026-07-30 §2): drawn from the same golfer pool as
// participantJoinedEvent, seated or not — a set for a golfer this particular shuffle never joins
// is exactly the "no folded join" case state.ts's fold must tolerate harmlessly.
const participantStrokesSetEvent = fc
  .record({
    golfer: fc.constantFrom(...golfers),
    strokes: fc.integer({ min: 0, max: 36 }),
    wallMs: fc.integer({ min: 1, max: 1_000 }),
    counter: fc.integer({ min: 0, max: 3 }),
    device: fc.constantFrom("d1", "d2", "d3"),
    op: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ golfer, strokes, wallMs, counter, device, op }): RoundEvent => ({
    kind: "participant-strokes-set",
    golferId: golfer,
    strokes,
    opId: opId(`set-${op}`), hlc: { wallMs, counter, deviceId: deviceId(device) }, authorId: golfer,
  }));

// The shuffled pool every convergence property draws from — mixing all five
// event kinds means a shuffle also reorders roster joins, game adds,
// terminations, and strokes corrections relative to scores, exercising
// firstHlc ordering (state.ts #4/#5) and the terminated-set union alongside
// the cell LWW logic scoreEvent alone already covered.
const anyEvent = fc.oneof(scoreEvent, participantJoinedEvent, gameAddedEvent, gameTerminatedEvent, participantStrokesSetEvent);

describe("reduceRound convergence", () => {
  it("is order-independent: any shuffle of the same events folds to the same state", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), fc.infiniteStream(fc.nat()), (events, seeds) => {
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
      fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
        const log = [genesis, ...events];
        expect(reduceRound([...log, ...log])).toEqual(reduceRound(log));
      }),
    );
  });
});
