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
  it("round-trips a valid peek-round response carrying par", () => {
    roundTrips(peekRoundResponseSchema, {
      courseName: "Casa Verde GC",
      teeSets: [{ name: "white", par: 72, rating: 71.2, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });
  });

  // unrated-courses arc: a peek of an unrated tee still names it and its par, just without
  // rating/slope — the pair is optional here (§1), par is always present.
  it("round-trips a peek of an unrated tee (rating/slope absent, par present)", () => {
    roundTrips(peekRoundResponseSchema, {
      courseName: "Casa Verde GC",
      teeSets: [{ name: "white", par: 72 }],
      createdAt: 1_700_000_000_000,
    });
  });

  it("rejects a tee missing par (par is required, unlike rating/slope)", () => {
    expect(() =>
      parse(peekRoundResponseSchema, { courseName: "Casa Verde GC", teeSets: [{ name: "white", rating: 71.2, slope: 128 }], createdAt: 1 }),
    ).toThrow(ContractError);
  });

  it("rejects a payload missing teeSets", () => {
    expect(() => parse(peekRoundResponseSchema, { courseName: "Casa Verde GC" })).toThrow(ContractError);
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
