import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { courseId, golferId, roundId } from "@swng/domain";
import type { GolferRoundLine } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import { getMeResponseSchema, getMyLiveRoundsResponseSchema, getMyRecordResponseSchema, getMyRoundsResponseSchema, golferViewSchema, updateMeRequestSchema } from "./golfers.js";

// parse(JSON.parse(JSON.stringify(x))) === x — the wire round-trip every schema here has to
// survive unchanged, same pattern as courses.test.ts / round.test.ts.
const roundTrips = <S extends z.ZodType>(schema: S, value: z.infer<S>): void => {
  expect(parse(schema, JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
};

describe("golferViewSchema (via getMeResponseSchema)", () => {
  it("round-trips a bare golfer on the default swng source (no home course)", () => {
    roundTrips(getMeResponseSchema, { golfer: { golferId: golferId("g1"), name: "Ann", indexSource: { kind: "swng" } } });
  });

  it("round-trips a fully-populated golfer on a declared source (index-source model spec §3)", () => {
    roundTrips(getMeResponseSchema, {
      golfer: {
        golferId: golferId("g1"),
        name: "Ann",
        homeCourseId: courseId("course-1"),
        indexSource: { kind: "declared", value: 12.3 },
      },
    });
  });

  // GET /me get-or-creates now (accounts-only identity spec §2), but the wire type stays nullable —
  // the null case still round-trips.
  it("round-trips an unbound sub: golfer null", () => {
    roundTrips(getMeResponseSchema, { golfer: null });
  });

  // accounts-only identity spec §2: namePlaceholder rides the view, emitted only when true.
  it("round-trips a golfer carrying namePlaceholder: true", () => {
    roundTrips(getMeResponseSchema, { golfer: { golferId: golferId("g1"), name: "Golfer 4821", indexSource: { kind: "swng" }, namePlaceholder: true } });
  });
});

// The index-source discriminated union (index-source model spec §3): each kind round-trips; a
// bad kind is rejected; a `declared` source missing its `value` is rejected (the union's own
// per-arm shape enforcement).
describe("golferViewSchema — indexSource discriminated union", () => {
  const view = (indexSource: unknown) => ({ golferId: golferId("g1"), name: "Ann", indexSource });

  it("accepts each kind: swng, whs, declared", () => {
    expect(() => parse(golferViewSchema, view({ kind: "swng" }))).not.toThrow();
    expect(() => parse(golferViewSchema, view({ kind: "whs" }))).not.toThrow();
    expect(() => parse(golferViewSchema, view({ kind: "declared", value: 8 }))).not.toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => parse(golferViewSchema, view({ kind: "nope" }))).toThrow(ContractError);
  });

  it("rejects a declared source missing its value", () => {
    expect(() => parse(golferViewSchema, view({ kind: "declared" }))).toThrow(ContractError);
  });
});

describe("updateMeRequestSchema", () => {
  it("round-trips a partial patch (only indexSource set — a declared assertion)", () => {
    roundTrips(updateMeRequestSchema, { indexSource: { kind: "declared", value: 14.2 } });
  });

  it("round-trips a patch adopting a computed source (whs)", () => {
    roundTrips(updateMeRequestSchema, { indexSource: { kind: "whs" } });
  });

  it("round-trips an empty patch", () => {
    roundTrips(updateMeRequestSchema, {});
  });

  it("rejects an extra field (.strict()) — e.g. a client proposing golferId", () => {
    expect(() => parse(updateMeRequestSchema, { name: "Ann", golferId: "sneaky" })).toThrow(ContractError);
  });

  it("rejects an empty name", () => {
    expect(() => parse(updateMeRequestSchema, { name: "" })).toThrow(ContractError);
  });
});

describe("getMyRecordResponseSchema", () => {
  const completeLine: GolferRoundLine = {
    roundId: roundId("r1"),
    courseName: "Casa Verde GC",
    tee: "white",
    holes: 18,
    par: 72,
    courseHandicap: 8,
    ags: 90,
    differential: 12.3,
    distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
  };

  const incompleteLine: GolferRoundLine = {
    roundId: roundId("r2"),
    courseName: "Casa Verde GC",
    tee: "white",
    holes: 9,
    par: 36,
    courseHandicap: 5,
    distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  };

  // Both required (papercut 17): a zeroed typicalEighteen + empty indexHistory, unless a fixture
  // asserts otherwise below.
  const zeroTypicalEighteen = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };

  // Both required (analytics spec §3): {} / [] unless a fixture asserts otherwise below.
  const zeroBestsMilestones = { bests: {}, milestones: [] };

  it("round-trips a record with both metrics (whsIndex + swngIndex), a typicalEighteen shape, an indexHistory with both indices, a best18, and an achieved milestone, plus mixed complete/incomplete history lines", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: {
        whsIndex: { value: 7.2, computedAtMs: 5_000, differentialsUsed: 1 },
        swngIndex: { value: 9.4, differentialsUsed: 1 },
        typicalEighteen: { eagles: 0, birdies: 3, pars: 20, bogeys: 12, doublePlus: 2 },
        indexHistory: [{ roundId: roundId("r1"), swngIndex: 9.4, whsIndex: 7.2 }],
        bests: { best18: { roundId: roundId("r1"), gross: 82, toPar: 10 } },
        milestones: [{ kind: "broke-90", roundId: roundId("r1") }],
      },
      history: [completeLine, incompleteLine],
    });
  });

  // unrated-courses spec §6: a wholly-unrated history has a swngIndex but no whsIndex — same
  // absence shows up per-point in indexHistory.
  it("round-trips a record carrying only a swngIndex (no whsIndex), indexHistory point with only swngIndex", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: {
        swngIndex: { value: 9.4, differentialsUsed: 1 },
        typicalEighteen: zeroTypicalEighteen,
        indexHistory: [{ roundId: roundId("r2"), swngIndex: 9.4 }],
        ...zeroBestsMilestones,
      },
      history: [incompleteLine],
    });
  });

  it("round-trips a bootstrap-not-met record: no computed indexes, zeroed typicalEighteen, empty indexHistory, history present", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, indexHistory: [], ...zeroBestsMilestones },
      history: [incompleteLine],
    });
  });

  it("round-trips an entirely empty record", () => {
    roundTrips(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, indexHistory: [], ...zeroBestsMilestones }, history: [] });
  });

  // course-cards spec §4: courseId (the analytics join key) is OPTIONAL on a history line —
  // pre-scrap lines carry none, tolerated as absent.
  it("round-trips a history line carrying courseId", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, indexHistory: [], ...zeroBestsMilestones },
      history: [{ ...completeLine, courseId: courseId("course-1") }],
    });
  });

  it("round-trips a pre-scrap history line with no courseId", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, indexHistory: [], ...zeroBestsMilestones },
      history: [completeLine],
    });
  });

  // typicalEighteen, indexHistory, bests, and milestones are all REQUIRED — a metrics object
  // missing any one of them is rejected, not silently defaulted.
  it("rejects a metrics object missing typicalEighteen", () => {
    expect(() => parse(getMyRecordResponseSchema, { metrics: { indexHistory: [], ...zeroBestsMilestones }, history: [] })).toThrow(ContractError);
  });

  it("rejects a metrics object missing indexHistory", () => {
    expect(() => parse(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, ...zeroBestsMilestones }, history: [] })).toThrow(
      ContractError,
    );
  });

  it("rejects a metrics object missing bests", () => {
    expect(() =>
      parse(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, indexHistory: [], milestones: [] }, history: [] }),
    ).toThrow(ContractError);
  });

  it("rejects a metrics object missing milestones", () => {
    expect(() =>
      parse(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, indexHistory: [], bests: {} }, history: [] }),
    ).toThrow(ContractError);
  });
});

// accounts-only identity spec §5: createdAt (the "course + date" designation) is OPTIONAL on both
// list responses — old projection lines / stale presence pointers carry none, tolerated as absent.
describe("getMyRoundsResponseSchema", () => {
  const line = { roundId: roundId("r1"), courseName: "Casa Verde GC", tee: "white", holes: 18 as const, par: 72, courseHandicap: 8, distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 } };

  it("round-trips a round line carrying createdAt", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, finalizedAt: 2_000, createdAt: 1_500 }] });
  });

  it("round-trips a legacy round line with no createdAt", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, finalizedAt: 2_000 }] });
  });

  // course-cards spec §4: courseId is OPTIONAL here too — same carried-or-absent tolerance as
  // getMyRecordResponseSchema's history lines above.
  it("round-trips a round line carrying courseId", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, courseId: courseId("course-1"), finalizedAt: 2_000 }] });
  });

  it("round-trips a pre-scrap round line with no courseId", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, finalizedAt: 2_000 }] });
  });
});

describe("getMyLiveRoundsResponseSchema", () => {
  it("round-trips a live round carrying createdAt", () => {
    roundTrips(getMyLiveRoundsResponseSchema, { rounds: [{ roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000, createdAt: 900 }] });
  });

  it("round-trips a live round with no createdAt (a stale pointer)", () => {
    roundTrips(getMyLiveRoundsResponseSchema, { rounds: [{ roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000 }] });
  });
});
