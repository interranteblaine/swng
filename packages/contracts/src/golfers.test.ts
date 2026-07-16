import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { courseId, golferId, roundId } from "@swng/domain";
import type { GolferRoundLine } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import { getMeResponseSchema, getMyLiveRoundsResponseSchema, getMyRecordResponseSchema, getMyRoundsResponseSchema, updateMeRequestSchema } from "./golfers.js";

// parse(JSON.parse(JSON.stringify(x))) === x — the wire round-trip every schema here has to
// survive unchanged, same pattern as courses.test.ts / round.test.ts.
const roundTrips = <S extends z.ZodType>(schema: S, value: z.infer<S>): void => {
  expect(parse(schema, JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
};

describe("golferViewSchema (via getMeResponseSchema)", () => {
  it("round-trips a bare golfer (no home course, no handicap fields set)", () => {
    roundTrips(getMeResponseSchema, { golfer: { golferId: golferId("g1"), name: "Ann" } });
  });

  it("round-trips a fully-populated golfer — declared only; no computed/effective (the server never persists a computed index on the golfer item)", () => {
    roundTrips(getMeResponseSchema, {
      golfer: {
        golferId: golferId("g1"),
        name: "Ann",
        homeCourseId: courseId("course-1"),
        declared: 12.3,
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
    roundTrips(getMeResponseSchema, { golfer: { golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } });
  });
});

describe("updateMeRequestSchema", () => {
  it("round-trips a partial patch (only declared set)", () => {
    roundTrips(updateMeRequestSchema, { declared: 14.2 });
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

  it("round-trips a record with both metrics (whsIndex + swngIndex) and mixed complete/incomplete history lines", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: {
        whsIndex: { value: 7.2, computedAtMs: 5_000, differentialsUsed: 1 },
        swngIndex: { value: 9.4, differentialsUsed: 1 },
      },
      history: [completeLine, incompleteLine],
    });
  });

  // unrated-courses spec §6: a wholly-unrated history has a swngIndex but no whsIndex.
  it("round-trips a record carrying only a swngIndex (no whsIndex)", () => {
    roundTrips(getMyRecordResponseSchema, { metrics: { swngIndex: { value: 9.4, differentialsUsed: 1 } }, history: [incompleteLine] });
  });

  it("round-trips a bootstrap-not-met record: empty metrics object, history present", () => {
    roundTrips(getMyRecordResponseSchema, { metrics: {}, history: [incompleteLine] });
  });

  it("round-trips an entirely empty record", () => {
    roundTrips(getMyRecordResponseSchema, { metrics: {}, history: [] });
  });

  // course-cards spec §4: courseId (the analytics join key) is OPTIONAL on a history line —
  // pre-scrap lines carry none, tolerated as absent.
  it("round-trips a history line carrying courseId", () => {
    roundTrips(getMyRecordResponseSchema, { metrics: {}, history: [{ ...completeLine, courseId: courseId("course-1") }] });
  });

  it("round-trips a pre-scrap history line with no courseId", () => {
    roundTrips(getMyRecordResponseSchema, { metrics: {}, history: [completeLine] });
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
