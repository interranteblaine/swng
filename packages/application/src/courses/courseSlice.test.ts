import { describe, expect, it } from "vitest";
import { courseId, fixtureWhite, golferId } from "@swng/domain";
import type { CardRecord, CourseId } from "@swng/domain";
import type { CardStore } from "../ports/cardStore.js";
import { ApplicationError } from "../errors.js";
import { createFixedClock, createInMemoryGolferStore, createNullLogger, createSequentialIds, putAndBindGolfer } from "../testing/fakes.js";
import { createCourse } from "./createCourse.js";
import { getCourse } from "./getCourse.js";
import { searchCourses } from "./searchCourses.js";
import { supersedeCard } from "./supersedeCard.js";

// An in-memory CardStore: one append-only lineage (Array<CardRecord>) per courseId, current =
// the last element. supersede is the store's own concurrency arbiter — it throws card-superseded
// unless the last element's cardId still names the card the caller reviewed (record.supersedes),
// the same one rule the Dynamo transact condition enforces (spec §6). Kept local to this test
// file, like roundSlice.test.ts's own createTestTokenIssuer.
const createInMemoryCardStore = (): CardStore => {
  const lineages = new Map<CourseId, CardRecord[]>();
  return {
    create: async (record) => {
      if (lineages.has(record.courseId)) throw new ApplicationError("card-superseded", `course ${record.courseId} already exists`);
      lineages.set(record.courseId, [record]);
    },
    supersede: async (record) => {
      const lineage = lineages.get(record.courseId);
      const current = lineage?.[lineage.length - 1];
      if (!lineage || !current) throw new ApplicationError("course-not-found");
      if (current.cardId !== record.supersedes) throw new ApplicationError("card-superseded", `course ${record.courseId}: pointer moved`);
      lineage.push(record);
    },
    getCurrent: async (id) => {
      const lineage = lineages.get(id);
      return lineage?.[lineage.length - 1];
    },
    search: async (nameKeyPrefix, limit) =>
      [...lineages.values()]
        .map((lineage) => lineage[lineage.length - 1]!)
        .filter((record) => record.card.courseName.toLowerCase().replace(/\s+/g, " ").trim().startsWith(nameKeyPrefix))
        .slice(0, limit)
        .map((record) => ({ courseId: record.courseId, name: record.card.courseName, holeCount: record.card.teeSets[0]!.holes.length as 9 | 18 })),
  };
};

// An input tee (POST body / supersede body): the frozen fixture's numbers, no teeId — the
// server mints (create) or the continuity rule tracks (supersede) every id. fixtureWhite is
// always rated (its own module pins concrete rating/slope literals); the `!`s just narrow past
// TeeSet.rating/slope's now-optional type (unrated-courses spec Task 1) for this rated-only suite.
const whiteInput = { name: fixtureWhite.name, rating: fixtureWhite.rating!, slope: fixtureWhite.slope!, holes: fixtureWhite.holes };
const blueInput = { ...whiteInput, name: "blue", rating: 73.1, slope: 132 };

const ANN_SUB = "ann-sub";
const ANN_ID = golferId("g-ann");

const setup = (cardStore: CardStore = createInMemoryCardStore()) => {
  const idGenerator = createSequentialIds("c");
  const clock = createFixedClock(1_000);
  const logger = createNullLogger();
  const golferStore = createInMemoryGolferStore();
  return {
    cardStore,
    golferStore,
    create: createCourse({ cardStore, golferStore, idGenerator, clock, logger }),
    supersede: supersedeCard({ cardStore, golferStore, idGenerator, clock, logger }),
    get: getCourse({ cardStore }),
    search: searchCourses({ cardStore }),
  };
};

// Seeds Ann as a real account golfer bound to her sub, so ensureGolfer resolves a known
// id/name for the attribution frozen into every record (createCourse/supersedeCard's spec
// invariant 7 — enteredBy derives from the account, never the wire).
const seedAnn = async (ctx: ReturnType<typeof setup>) => putAndBindGolfer(ctx.golferStore, ANN_ID, ANN_SUB, "Ann");
const claims = { sub: ANN_SUB };

describe("createCourse", () => {
  it("mints distinct tee ids and returns a view whose card.source matches the record's identity", async () => {
    const ctx = setup();
    await seedAnn(ctx);
    const created = await ctx.create(claims, { name: "Casa Verde GC", teeSets: [whiteInput, blueInput] });

    expect(created.course.enteredBy).toBe("Ann");
    expect(created.course.card.courseName).toBe("Casa Verde GC");
    // card.source is exactly the record's own identity (the view IS the card plus attribution).
    expect(created.course.card.source).toEqual({ cardId: created.course.cardId, courseId: created.course.courseId });
    const ids = created.course.card.teeSets.map((tee) => tee.teeId);
    expect(new Set(ids).size).toBe(2); // distinct, server-minted
    expect(ids.every((id) => id !== undefined)).toBe(true);

    const fetched = await ctx.get(created.course.courseId);
    expect(fetched).toEqual(created);
  });
});

describe("getCourse", () => {
  it("throws course-not-found for an unknown id", async () => {
    const ctx = setup();
    await expect(ctx.get(courseId("nope"))).rejects.toMatchObject({ code: "course-not-found" });
  });
});

describe("supersedeCard", () => {
  it("preserves a kept teeId and mints a fresh id for a brand-new tee", async () => {
    const ctx = setup();
    await seedAnn(ctx);
    const created = await ctx.create(claims, { name: "Casa Verde GC", teeSets: [whiteInput] });
    const keptTeeId = created.course.card.teeSets[0]!.teeId!;

    const revised = await ctx.supersede(claims, created.course.courseId, {
      name: "Casa Verde GC",
      teeSets: [{ ...whiteInput, rating: 72.5, teeId: keptTeeId }, blueInput],
      supersedes: created.course.cardId,
    });

    const white = revised.course.card.teeSets.find((tee) => tee.name === "white");
    const blue = revised.course.card.teeSets.find((tee) => tee.name === "blue");
    expect(white?.teeId).toBe(keptTeeId); // same tee, same id
    expect(white?.rating).toBe(72.5); // numbers corrected
    expect(blue?.teeId).toBeDefined();
    expect(blue?.teeId).not.toBe(keptTeeId); // new tee, fresh id
    expect(revised.course.cardId).not.toBe(created.course.cardId); // a new card in the lineage
  });

  it("reports card-superseded early when `supersedes` is stale (someone else already moved the pointer)", async () => {
    const ctx = setup();
    await seedAnn(ctx);
    const created = await ctx.create(claims, { name: "Casa Verde GC", teeSets: [whiteInput] });

    await expect(
      ctx.supersede(claims, created.course.courseId, { name: "Casa Verde GC", teeSets: [whiteInput], supersedes: "stale-card-id" }),
    ).rejects.toMatchObject({ code: "card-superseded" });
  });

  it("propagates unknown-tee-id when a submitted teeId isn't on the superseded card", async () => {
    const ctx = setup();
    await seedAnn(ctx);
    const created = await ctx.create(claims, { name: "Casa Verde GC", teeSets: [whiteInput] });

    await expect(
      ctx.supersede(claims, created.course.courseId, {
        name: "Casa Verde GC",
        teeSets: [{ ...whiteInput, teeId: "never-existed" }],
        supersedes: created.course.cardId,
      }),
    ).rejects.toMatchObject({ code: "unknown-tee-id" });
  });

  it("throws course-not-found for an unknown lineage", async () => {
    const ctx = setup();
    await seedAnn(ctx);
    await expect(
      ctx.supersede(claims, courseId("nope"), { name: "x", teeSets: [whiteInput], supersedes: "whatever" }),
    ).rejects.toMatchObject({ code: "course-not-found" });
  });
});

describe("searchCourses", () => {
  it("normalizes the query via courseNameKey and returns holeCount", async () => {
    const ctx = setup();
    await seedAnn(ctx);
    await ctx.create(claims, { name: "Casa Verde GC", teeSets: [whiteInput] });
    await ctx.create(claims, { name: "Cedar Ridge", teeSets: [whiteInput] });

    const results = await ctx.search("  CASA ");
    expect(results.courses.map((c) => c.name)).toEqual(["Casa Verde GC"]);
    expect(results.courses[0]?.holeCount).toBe(9);
  });

  it("clamps limit to 1..25 and defaults to 10", async () => {
    const ctx = setup();
    await seedAnn(ctx);
    for (let i = 0; i < 3; i += 1) {
      await ctx.create(claims, { name: `Casa ${i}`, teeSets: [whiteInput] });
    }

    expect((await ctx.search("casa", 0)).courses).toHaveLength(1);
    expect((await ctx.search("casa", 999)).courses.length).toBeLessThanOrEqual(25);
    expect((await ctx.search("casa")).courses).toHaveLength(3);
  });
});
