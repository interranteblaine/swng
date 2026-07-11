import { describe, expect, it } from "vitest";
import { ApplicationError } from "./errors.js";
import { retryOnConflict } from "./retryOnConflict.js";

// A minimal revision-conditional single-cell store — enough to pin the generic retry loop's
// own behavior in isolation. Store-specific wiring (CourseStore's plain put, CrewStore's
// joinCode-threaded put) gets its own conflict-retry coverage through real use cases in
// courseSlice.test.ts (addTeeSet) and crewSlice.test.ts (addCrewMember).
const codes = { notFound: "course-not-found", conflict: "course-conflict" } as const;

const createFlakyCell = (initial: number, failCount: number) => {
  let value = initial;
  let revision = 0;
  let putAttempts = 0;
  return {
    putAttempts: () => putAttempts,
    get: async () => ({ value, revision }),
    put: async (next: number, expectedRevision: number | undefined) => {
      putAttempts += 1;
      if (putAttempts <= failCount) throw new ApplicationError("course-conflict", `synthetic conflict #${putAttempts}`);
      if (expectedRevision !== revision) throw new ApplicationError("course-conflict", "real conflict");
      value = next;
      revision += 1;
    },
  };
};

describe("retryOnConflict", () => {
  it("retries once on a synthetic conflict from the store, then succeeds", async () => {
    const cell = createFlakyCell(1, 1);
    const result = await retryOnConflict(cell, (current) => current + 1, codes);

    expect(result).toBe(2);
    // More than one put attempt is the proof the retry path actually ran, not that the first
    // attempt just happened to succeed.
    expect(cell.putAttempts()).toBeGreaterThan(1);
  });

  it("gives up after bounded attempts and rethrows the conflict when the store never stops conflicting", async () => {
    const cell = createFlakyCell(1, Number.POSITIVE_INFINITY);

    await expect(retryOnConflict(cell, (current) => current + 1, codes)).rejects.toMatchObject({ code: "course-conflict" });
    expect(cell.putAttempts()).toBeGreaterThan(1);
  });

  it("get() resolving undefined throws the configured notFound code", async () => {
    const store = { get: async () => undefined, put: async () => {} };

    await expect(retryOnConflict(store, (current: number) => current, codes)).rejects.toMatchObject({ code: "course-not-found" });
  });

  // A DIFFERENT error than the one the loop discriminates on (course-conflict) — thrown by
  // `mutate` itself, the same shape as a DomainError a real course/crew mutation would raise
  // (e.g. a duplicate member, a stale expected version) — propagates UNCAUGHT on the very
  // first attempt, never retried and never mistaken for a conflict to recover from.
  it("propagates an error from `mutate` uncaught, without retrying", async () => {
    const cell = createFlakyCell(1, 0);
    let mutateCalls = 0;

    await expect(
      retryOnConflict(
        cell,
        () => {
          mutateCalls += 1;
          throw new Error("not a store conflict");
        },
        codes,
      ),
    ).rejects.toThrow("not a store conflict");
    expect(mutateCalls).toBe(1);
    expect(cell.putAttempts()).toBe(0);
  });
});
