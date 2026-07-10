import { describe, expect, it } from "vitest";
import { courseId, fixtureWhite } from "@swng/domain";
import type { CourseStore } from "../ports/courseStore.js";
import { ApplicationError } from "../errors.js";
import { createFixedClock, createInMemoryCourseStore, createNullLogger, createSequentialIds } from "../testing/fakes.js";
import { addTeeSet } from "./addTeeSet.js";
import { createCourse } from "./createCourse.js";
import { getCourse } from "./getCourse.js";
import { searchCourses } from "./searchCourses.js";
import { verifyTeeSet } from "./verifyTeeSet.js";

// fixtureWhite is a known-valid 9-hole TeeSet (shared with the scoring golden decks, see
// domain/course/course.test.ts's own reuse of it) — a second, differently-named tee is just
// a rename of the same valid holes, so every test here mutates exactly one known-good field.
const whiteTee = fixtureWhite;
const blueTee = { ...fixtureWhite, name: "blue", rating: 73.1, slope: 132 };

const setup = (courseStore: CourseStore = createInMemoryCourseStore()) => {
  const idGenerator = createSequentialIds("c");
  const clock = createFixedClock(1_000);
  const logger = createNullLogger();
  return {
    courseStore,
    create: createCourse({ courseStore, idGenerator, clock, logger }),
    addTee: addTeeSet({ courseStore, clock, logger }),
    verify: verifyTeeSet({ courseStore, clock, logger }),
    get: getCourse({ courseStore }),
    search: searchCourses({ courseStore }),
  };
};

// A CourseStore decorator that fails its first `failCount` `put` calls with a synthetic
// "course-conflict" before delegating to `inner` — the controllable stand-in the brief's
// conflict-retry step calls for ("fake throws course-conflict once..."), kept local to this
// test file (like roundSlice.test.ts's own createTestTokenIssuer) rather than folded into
// the shared fakes.ts, since it's a single-test's failure-injection harness, not a reusable
// product-surface fake.
interface FlakyCourseStore extends CourseStore {
  readonly putAttempts: () => number;
}
const createFlakyCourseStore = (inner: CourseStore, failCount: number): FlakyCourseStore => {
  let putAttempts = 0;
  return {
    putAttempts: () => putAttempts,
    get: inner.get,
    search: inner.search,
    put: async (course, expectedRevision) => {
      putAttempts += 1;
      if (putAttempts <= failCount) throw new ApplicationError("course-conflict", `synthetic conflict #${putAttempts}`);
      return inner.put(course, expectedRevision);
    },
  };
};

describe("createCourse / getCourse", () => {
  it("round-trips: create then get returns the same CourseView", async () => {
    const ctx = setup();
    const created = await ctx.create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });

    expect(created.course.name).toBe("Casa Verde GC");
    expect(created.course.card).toEqual({ courseName: "Casa Verde GC", teeSets: [whiteTee] });
    expect(created.course.teeSets).toEqual([{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] }]);

    const fetched = await ctx.get(created.course.courseId);
    expect(fetched).toEqual(created);
  });

  it("getCourse on an unknown id throws course-not-found", async () => {
    const ctx = setup();
    await expect(ctx.get(courseId("nope"))).rejects.toMatchObject({ code: "course-not-found" });
  });
});

describe("addTeeSet", () => {
  it("adding a new tee name extends CourseView.card with it", async () => {
    const ctx = setup();
    const created = await ctx.create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });
    const added = await ctx.addTee(created.course.courseId, { tee: blueTee, enteredBy: "Bo" });

    expect(added.course.card.teeSets.map((t) => t.name).sort()).toEqual(["blue", "white"]);
    expect(added.course.teeSets.map((t) => t.name).sort()).toEqual(["blue", "white"]);
  });

  it("revising an existing tee name supersedes the prior version — CourseView.card and teeSets reflect only the new one", async () => {
    const ctx = setup();
    const created = await ctx.create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });
    const revisedTee = { ...whiteTee, rating: 72.5 };
    const revised = await ctx.addTee(created.course.courseId, { tee: revisedTee, enteredBy: "Bo" });

    // Exactly one "white" entry (the revision), not two — supersession, not accumulation.
    expect(revised.course.teeSets).toEqual([{ name: "white", version: 2, provenance: "community", enteredBy: "Bo", verifiedBy: [] }]);
    expect(revised.course.card).toEqual({ courseName: "Casa Verde GC", teeSets: [revisedTee] });
  });

  it("retries once on a synthetic course-conflict from the store, then succeeds", async () => {
    const inner = createInMemoryCourseStore();
    const created = await setup(inner).create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });

    const flaky = createFlakyCourseStore(inner, 1);
    const flakyCtx = setup(flaky);
    const result = await flakyCtx.addTee(created.course.courseId, { tee: blueTee, enteredBy: "Bo" });

    expect(result.course.teeSets.map((t) => t.name).sort()).toEqual(["blue", "white"]);
    // More than one put attempt is the proof the retry path actually ran, not that the
    // first attempt just happened to succeed.
    expect(flaky.putAttempts()).toBeGreaterThan(1);
  });

  it("gives up after bounded attempts and rethrows course-conflict when the store never stops conflicting", async () => {
    const inner = createInMemoryCourseStore();
    const created = await setup(inner).create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });

    const flaky = createFlakyCourseStore(inner, Number.POSITIVE_INFINITY);
    const flakyCtx = setup(flaky);

    await expect(flakyCtx.addTee(created.course.courseId, { tee: blueTee, enteredBy: "Bo" })).rejects.toMatchObject({ code: "course-conflict" });
    expect(flaky.putAttempts()).toBeGreaterThan(1);
  });
});

describe("verifyTeeSet", () => {
  it("is idempotent for a repeat verifier name — no duplicate credit", async () => {
    const ctx = setup();
    const created = await ctx.create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });

    const once = await ctx.verify(created.course.courseId, { teeName: "white", verifierName: "Bo", version: 1 });
    expect(once.course.teeSets[0]?.verifiedBy).toEqual(["Bo"]);

    const twice = await ctx.verify(created.course.courseId, { teeName: "white", verifierName: "Bo", version: 1 });
    expect(twice.course.teeSets[0]?.verifiedBy).toEqual(["Bo"]);
  });

  it("on an unknown tee name propagates the domain's unknown-tee-set error", async () => {
    const ctx = setup();
    const created = await ctx.create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });
    await expect(ctx.verify(created.course.courseId, { teeName: "gold", verifierName: "Bo", version: 1 })).rejects.toMatchObject({
      code: "unknown-tee-set",
    });
  });

  // I1 (M6 final review): a verify racing a revision must never silently transplant onto
  // numbers the verifier never saw. This reproduces the review's exact interleaving — Cal
  // reads the course at v1 and taps verify, but Bo's correction (a revision to v2) lands
  // mid-retry, DURING retryOnConflict's own bounded loop (not merely before the whole call):
  // the `racy` store injects Bo's real addTeeSet the first time Cal's verify attempts to put,
  // so the put itself genuinely conflicts (a real optimistic-concurrency failure, not a
  // synthetic one), retryOnConflict re-reads (now v2), and re-applies the SAME expectedVersion
  // (1) the caller originally pinned — which must now fail outright, not retry into a
  // transplant.
  it("a verify racing a revision mid-retry surfaces tee-set-revised, not a silent transplant", async () => {
    const inner = createInMemoryCourseStore();
    const innerCtx = setup(inner);
    const created = await innerCtx.create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });
    const revisedTee = { ...whiteTee, rating: 72.5 };

    let injected = false;
    const racy: CourseStore = {
      get: inner.get,
      search: inner.search,
      put: async (course, expectedRevision) => {
        // On the FIRST put attempt only, land Bo's real revision through the inner store
        // before delegating — expectedRevision below is now stale, so inner.put's own
        // optimistic-concurrency check throws a genuine course-conflict (not synthesized).
        if (!injected) {
          injected = true;
          await innerCtx.addTee(created.course.courseId, { tee: revisedTee, enteredBy: "Bo" });
        }
        return inner.put(course, expectedRevision);
      },
    };
    const racyCtx = setup(racy);

    await expect(
      racyCtx.verify(created.course.courseId, { teeName: "white", verifierName: "Cal", version: 1 }),
    ).rejects.toMatchObject({ code: "tee-set-revised" });

    // The stored course keeps v2 unverified (CourseView.teeSets is current-versions-only, per
    // toCourseView) — Cal's credit never attached anywhere.
    const stored = await innerCtx.get(created.course.courseId);
    expect(stored.course.teeSets).toEqual([{ name: "white", version: 2, provenance: "community", enteredBy: "Bo", verifiedBy: [] }]);

    // The superseded v1 (server-side-only history) also carries no verification — reaching
    // past the CourseView projection into the raw store to confirm the transplant didn't land
    // anywhere at all, not just off-screen.
    const raw = await inner.get(created.course.courseId);
    const v1 = raw?.course.teeSets.find((v) => v.version === 1);
    expect(v1).toMatchObject({ status: "superseded", verifications: [] });
  });
});

describe("searchCourses", () => {
  it("normalizes the query via courseNameKey — untrimmed, mixed-case input still matches by name prefix", async () => {
    const ctx = setup();
    await ctx.create({ name: "Casa Verde GC", tee: whiteTee, enteredBy: "Ann" });
    await ctx.create({ name: "Cedar Ridge", tee: whiteTee, enteredBy: "Ann" });

    const results = await ctx.search("  CASA ");
    expect(results.courses.map((c) => c.name)).toEqual(["Casa Verde GC"]);
  });

  it("clamps limit to 1..25 and defaults to 10", async () => {
    const ctx = setup();
    for (let i = 0; i < 3; i += 1) {
      await ctx.create({ name: `Casa ${i}`, tee: whiteTee, enteredBy: "Ann" });
    }

    const zeroClampedToOne = await ctx.search("casa", 0);
    expect(zeroClampedToOne.courses).toHaveLength(1);

    const hugeClampedToTwentyFive = await ctx.search("casa", 999);
    expect(hugeClampedToTwentyFive.courses.length).toBeLessThanOrEqual(25);

    const defaulted = await ctx.search("casa");
    expect(defaulted.courses).toHaveLength(3); // all 3 fit under the default limit of 10
  });
});
