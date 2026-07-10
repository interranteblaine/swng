import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { courseId } from "@swng/domain";
import type { TeeSet } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addTeeSetRequestSchema,
  addTeeSetResponseSchema,
  createCourseRequestSchema,
  createCourseResponseSchema,
  getCourseResponseSchema,
  peekRoundResponseSchema,
  searchCoursesResponseSchema,
  verifyTeeSetRequestSchema,
  verifyTeeSetResponseSchema,
} from "./courses.js";

const tee: TeeSet = {
  name: "white",
  rating: 71.2,
  slope: 128,
  holes: Array.from({ length: 9 }, (_, index) => ({ number: index + 1, par: 4, yardage: 380, strokeIndex: index + 1 })),
};

// parse(JSON.parse(JSON.stringify(x))) === x — the wire round-trip every schema here has to
// survive unchanged, same pattern as round.test.ts / commands.test.ts.
const roundTrips = <S extends z.ZodType>(schema: S, value: z.infer<S>): void => {
  expect(parse(schema, JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
};

describe("createCourseRequestSchema", () => {
  it("round-trips a valid create-course request", () => {
    roundTrips(createCourseRequestSchema, { name: "Casa Verde GC", tee, enteredBy: "Ann" });
  });

  it.each([
    ["empty name", { name: "", tee, enteredBy: "Ann" }],
    ["empty enteredBy", { name: "Casa Verde GC", tee, enteredBy: "" }],
    ["missing tee", { name: "Casa Verde GC", enteredBy: "Ann" }],
    ["extra field (courseId) rejected by .strict()", { name: "Casa Verde GC", tee, enteredBy: "Ann", courseId: "sneaky" }],
  ])("rejects: %s", (_label, payload) => {
    expect(() => parse(createCourseRequestSchema, payload)).toThrow(ContractError);
  });
});

describe("createCourseResponseSchema", () => {
  it("round-trips a valid create-course response", () => {
    roundTrips(createCourseResponseSchema, {
      course: {
        courseId: courseId("course-1"),
        name: "Casa Verde GC",
        card: { courseName: "Casa Verde GC", teeSets: [tee] },
        teeSets: [{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] }],
      },
    });
  });
});

describe("addTeeSetRequestSchema", () => {
  it("round-trips a valid add-tee-set request", () => {
    roundTrips(addTeeSetRequestSchema, { tee, enteredBy: "Ann" });
  });

  it("rejects an extra field (version) — server-assigned, never client-proposed", () => {
    expect(() => parse(addTeeSetRequestSchema, { tee, enteredBy: "Ann", version: 2 })).toThrow(ContractError);
  });
});

describe("addTeeSetResponseSchema", () => {
  it("round-trips a valid add-tee-set response", () => {
    roundTrips(addTeeSetResponseSchema, {
      course: {
        courseId: courseId("course-1"),
        name: "Casa Verde GC",
        card: { courseName: "Casa Verde GC", teeSets: [tee] },
        teeSets: [{ name: "white", version: 2, provenance: "community", enteredBy: "Ann", verifiedBy: ["Bo"] }],
      },
    });
  });
});

describe("verifyTeeSetRequestSchema", () => {
  it("round-trips a valid verify-tee-set request", () => {
    roundTrips(verifyTeeSetRequestSchema, { teeName: "white", verifierName: "Bo", version: 1 });
  });

  it.each([
    ["empty teeName", { teeName: "", verifierName: "Bo", version: 1 }],
    ["empty verifierName", { teeName: "white", verifierName: "", version: 1 }],
    ["missing version", { teeName: "white", verifierName: "Bo" }],
    ["version below 1", { teeName: "white", verifierName: "Bo", version: 0 }],
    ["non-integer version", { teeName: "white", verifierName: "Bo", version: 1.5 }],
  ])("rejects: %s", (_label, payload) => {
    expect(() => parse(verifyTeeSetRequestSchema, payload)).toThrow(ContractError);
  });
});

describe("verifyTeeSetResponseSchema", () => {
  it("round-trips a valid verify-tee-set response", () => {
    roundTrips(verifyTeeSetResponseSchema, {
      course: {
        courseId: courseId("course-1"),
        name: "Casa Verde GC",
        card: { courseName: "Casa Verde GC", teeSets: [tee] },
        teeSets: [{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: ["Bo"] }],
      },
    });
  });
});

describe("getCourseResponseSchema", () => {
  it("round-trips a valid get-course response", () => {
    roundTrips(getCourseResponseSchema, {
      course: {
        courseId: courseId("course-1"),
        name: "Casa Verde GC",
        card: { courseName: "Casa Verde GC", teeSets: [tee] },
        teeSets: [{ name: "white", version: 1, provenance: "imported", enteredBy: "Ann", verifiedBy: [] }],
      },
    });
  });
});

describe("searchCoursesResponseSchema", () => {
  it("round-trips a valid search-courses response", () => {
    roundTrips(searchCoursesResponseSchema, { courses: [{ courseId: courseId("course-1"), name: "Casa Verde GC" }] });
  });
});

describe("peekRoundResponseSchema", () => {
  it("round-trips a valid peek-round response", () => {
    roundTrips(peekRoundResponseSchema, { courseName: "Casa Verde GC", teeSets: [{ name: "white", rating: 71.2, slope: 128 }] });
  });

  it("rejects a payload missing teeSets", () => {
    expect(() => parse(peekRoundResponseSchema, { courseName: "Casa Verde GC" })).toThrow(ContractError);
  });
});
