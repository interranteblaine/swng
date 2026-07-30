import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { cardId, courseId, teeId } from "@swng/domain";
import type { CourseCard, TeeSet } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  createCourseRequestSchema,
  createCourseResponseSchema,
  getCourseResponseSchema,
  peekRoundResponseSchema,
  searchCoursesResponseSchema,
  supersedeCardRequestSchema,
  supersedeCardResponseSchema,
} from "./courses.js";

// An input tee (POST /courses body): no teeId — the server mints every id (.strict() rejects one).
const inputTee = {
  name: "white",
  rating: 71.2,
  slope: 128,
  holes: Array.from({ length: 9 }, (_, index) => ({ number: index + 1, par: 4, yardage: 380, strokeIndex: index + 1 })),
};

// A stored/frozen tee (a CourseView's card): every tee carries its server-minted teeId.
const cardTee: TeeSet = { teeId: teeId("t-1"), ...inputTee };
const card: CourseCard = { courseName: "Casa Verde GC", source: { cardId: cardId("card-1"), courseId: courseId("course-1") }, teeSets: [cardTee] };
const courseView = { courseId: courseId("course-1"), cardId: "card-1", card, enteredBy: "Ann", updatedAtMs: 1_700_000_000_000 };

// parse(JSON.parse(JSON.stringify(x))) === x — the wire round-trip every schema here has to
// survive unchanged, same pattern as round.test.ts / commands.test.ts.
const roundTrips = <S extends z.ZodType>(schema: S, value: z.infer<S>): void => {
  expect(parse(schema, JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
};

describe("createCourseRequestSchema", () => {
  it("round-trips a valid create-course request", () => {
    roundTrips(createCourseRequestSchema, { name: "Casa Verde GC", teeSets: [inputTee] });
  });

  it.each([
    ["empty name", { name: "", teeSets: [inputTee] }],
    ["no tee sets", { name: "Casa Verde GC", teeSets: [] }],
    ["a client-proposed teeId rejected by .strict()", { name: "Casa Verde GC", teeSets: [{ ...inputTee, teeId: "sneaky" }] }],
    ["extra field (courseId) rejected by .strict()", { name: "Casa Verde GC", teeSets: [inputTee], courseId: "sneaky" }],
  ])("rejects: %s", (_label, payload) => {
    expect(() => parse(createCourseRequestSchema, payload)).toThrow(ContractError);
  });
});

describe("supersedeCardRequestSchema", () => {
  it("round-trips a valid supersede request (a kept teeId + a new id-less tee)", () => {
    roundTrips(supersedeCardRequestSchema, {
      name: "Casa Verde GC",
      teeSets: [{ ...inputTee, teeId: "t-1" }, { ...inputTee, name: "blue", rating: 73.1, slope: 132 }],
      supersedes: "card-1",
    });
  });

  it.each([
    ["missing supersedes", { name: "Casa Verde GC", teeSets: [inputTee] }],
    ["empty supersedes", { name: "Casa Verde GC", teeSets: [inputTee], supersedes: "" }],
    ["no tee sets", { name: "Casa Verde GC", teeSets: [], supersedes: "card-1" }],
    ["extra field rejected by .strict()", { name: "Casa Verde GC", teeSets: [inputTee], supersedes: "card-1", provenance: "imported" }],
  ])("rejects: %s", (_label, payload) => {
    expect(() => parse(supersedeCardRequestSchema, payload)).toThrow(ContractError);
  });
});

describe("createCourseResponseSchema / getCourseResponseSchema / supersedeCardResponseSchema", () => {
  it("round-trip a valid CourseView response", () => {
    roundTrips(createCourseResponseSchema, { course: courseView });
    roundTrips(getCourseResponseSchema, { course: courseView });
    roundTrips(supersedeCardResponseSchema, { course: courseView });
  });
});

describe("searchCoursesResponseSchema", () => {
  it("round-trips a valid search-courses response carrying holeCount", () => {
    roundTrips(searchCoursesResponseSchema, { courses: [{ courseId: courseId("course-1"), name: "Casa Verde GC", holeCount: 9 }] });
  });

  it("rejects a holeCount that isn't 9 or 18", () => {
    expect(() => parse(searchCoursesResponseSchema, { courses: [{ courseId: "course-1", name: "Casa Verde GC", holeCount: 12 }] })).toThrow(ContractError);
  });
});

describe("peekRoundResponseSchema", () => {
  it("round-trips a valid peek-round response — name + rating/slope per tee", () => {
    roundTrips(peekRoundResponseSchema, {
      courseName: "Casa Verde GC",
      teeSets: [{ name: "white", rating: 71.2, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });
  });

  // unrated-courses arc: a peek of an unrated tee still NAMES it, just without numbers — the
  // rating/slope pair is optional here (§1), and name alone is a complete tee.
  it("round-trips a peek of an unrated tee (rating/slope absent)", () => {
    roundTrips(peekRoundResponseSchema, {
      courseName: "Casa Verde GC",
      teeSets: [{ name: "white" }],
      createdAt: 1_700_000_000_000,
    });
  });

  // A peek tee carries NO par and NO hole count (spec 2026-07-29 §7 — no dormant fields): the
  // join-side strokes derivation that needed both is deleted, and JoinRoundPage's picker renders
  // name + teeNumbers(tee), which reads rating/slope alone. Extra keys strip rather than throw
  // (zod's default), so this pins the SHAPE the schema yields, which is what a reader sees.
  it("strips par/holes rather than carrying them — the fields are gone, not optional", () => {
    expect(
      parse(peekRoundResponseSchema, {
        courseName: "Casa Verde GC",
        teeSets: [{ name: "white", par: 72, holes: 18, rating: 71.2, slope: 128 }],
        createdAt: 1,
      }),
    ).toEqual({ courseName: "Casa Verde GC", teeSets: [{ name: "white", rating: 71.2, slope: 128 }], createdAt: 1 });
  });

  it("rejects a tee missing its name", () => {
    expect(() => parse(peekRoundResponseSchema, { courseName: "Casa Verde GC", teeSets: [{ rating: 71.2 }], createdAt: 1 })).toThrow(ContractError);
  });

  it("rejects a payload missing teeSets", () => {
    expect(() => parse(peekRoundResponseSchema, { courseName: "Casa Verde GC" })).toThrow(ContractError);
  });
});

// task-1 (pre-prod hardening, wire-ingress length/count bounds): request-only bounds on
// name/holes/teeSets. The read-side mirrors (round.ts's teeSetSchema/courseCardSchema, used by
// courseViewSchema/peekRoundResponseSchema above) are a SEPARATE, untouched schema family — this
// task never gates a stored course/card on read.
describe("createCourseRequestSchema / supersedeCardRequestSchema — request-ingress length/count bounds", () => {
  it("rejects an over-long tee name", () => {
    expect(() => parse(createCourseRequestSchema, { name: "Casa Verde GC", teeSets: [{ ...inputTee, name: "x".repeat(41) }] })).toThrow(ContractError);
  });

  it("rejects a tee with more than 18 holes", () => {
    const holes19 = Array.from({ length: 19 }, (_, index) => ({ number: index + 1, par: 4, yardage: 380, strokeIndex: index + 1 }));
    expect(() => parse(createCourseRequestSchema, { name: "Casa Verde GC", teeSets: [{ ...inputTee, holes: holes19 }] })).toThrow(ContractError);
  });

  it("rejects an over-long course name", () => {
    expect(() => parse(createCourseRequestSchema, { name: "x".repeat(81), teeSets: [inputTee] })).toThrow(ContractError);
    expect(() => parse(supersedeCardRequestSchema, { name: "x".repeat(81), teeSets: [{ ...inputTee, teeId: "t-1" }], supersedes: "card-1" })).toThrow(
      ContractError,
    );
  });

  it("rejects more than 12 tee sets", () => {
    const teeSets13 = Array.from({ length: 13 }, (_, index) => ({ ...inputTee, name: `tee-${index}` }));
    expect(() => parse(createCourseRequestSchema, { name: "Casa Verde GC", teeSets: teeSets13 })).toThrow(ContractError);
    expect(() =>
      parse(supersedeCardRequestSchema, { name: "Casa Verde GC", teeSets: teeSets13.map((tee) => ({ ...tee, teeId: "t-1" })), supersedes: "card-1" }),
    ).toThrow(ContractError);
  });
});

// unrated-courses arc: the create/supersede tee input widened rating/slope to optional-as-a-pair
// (structural only) so an unrated tee can be POSTed at all — the domain's validateCard is the sole
// authority on the pairing + bounds, so the wire tolerates each independently by design.
describe("newTeeInputSchema widening (unrated write path)", () => {
  const unratedTee = { name: "white", holes: inputTee.holes };

  it("round-trips a create request whose only tee has no rating/slope", () => {
    roundTrips(createCourseRequestSchema, { name: "Casa Verde GC", teeSets: [unratedTee] });
  });

  it("round-trips a supersede request carrying an unrated tee", () => {
    roundTrips(supersedeCardRequestSchema, { name: "Casa Verde GC", teeSets: [{ ...unratedTee, teeId: "t-1" }], supersedes: "card-1" });
  });

  it.each([
    ["rating alone (the pairing is the domain's job, not the wire's)", { name: "Casa Verde GC", teeSets: [{ name: "white", rating: 71.2, holes: inputTee.holes }] }],
    ["slope alone", { name: "Casa Verde GC", teeSets: [{ name: "white", slope: 128, holes: inputTee.holes }] }],
  ])("accepts structurally: %s", (_label, payload) => {
    expect(() => parse(createCourseRequestSchema, payload)).not.toThrow();
  });
});
