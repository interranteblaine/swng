import { describe, expect, it } from "vitest";
import { createNullLogger } from "@swng/application";
import { DomainError } from "@swng/domain";
import { toHttpError } from "./errorMapping.js";

// The ten course-validation DomainError codes thrown by domain/src/course/course.ts
// (validateCourseName / validateTeeSet / addTeeSet's duplicate-name guard) are client-input
// errors — the same "the request you sent is malformed" shape as a zod ContractError — so
// each must map to a coded 400, not fall through to the generic 500. Constructed here exactly
// as course.ts throws them (code + message), not invented strings.
describe("toHttpError — course validation DomainErrors map to coded 400s", () => {
  const logger = createNullLogger();

  const courseValidationCodes = [
    "invalid-course-name",
    "invalid-tee-name",
    "invalid-rating",
    "invalid-slope",
    "invalid-hole-count",
    "invalid-hole-numbering",
    "invalid-par",
    "invalid-yardage",
    "invalid-stroke-index",
    "duplicate-tee-name",
  ] as const;

  it.each(courseValidationCodes)("maps %s to 400 with the code in the body", (code) => {
    const error = new DomainError(code, `${code}: some detail`);
    const result = toHttpError(error, logger);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code, message: `${code}: some detail` });
  });

  // Pre-existing DomainError mappings must survive this addition unchanged.
  it("still maps unknown-tee-set to 400 (pre-existing)", () => {
    const result = toHttpError(new DomainError("unknown-tee-set", "no tee set named \"blue\""), logger);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code: "unknown-tee-set", message: 'no tee set named "blue"' });
  });

  it("still maps game-unresolved to 409 (pre-existing)", () => {
    const result = toHttpError(new DomainError("game-unresolved", "game not finished"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "game-unresolved", message: "game not finished" });
  });

  // An unmapped DomainError code is still a genuine-bug 500, never a client-shaped error.
  it("falls through to 500 for a DomainError code this boundary doesn't recognize", () => {
    const result = toHttpError(new DomainError("some-unmapped-code", "boom"), logger);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ code: "internal-error", message: "an unexpected error occurred" });
  });
});
