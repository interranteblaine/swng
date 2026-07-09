import { randomUUID } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Course } from "@swng/domain";
import { courseId, fixtureWhite } from "@swng/domain";
import { addTeeSet, createFixedClock, createNullLogger } from "@swng/application";
import { createDynamoCourseStore } from "../createDynamoCourseStore.js";
import { courseGsi1pk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M6 Task 3), same idiom as store.contract.test.ts/journal.contract.test.ts:
// proves createDynamoCourseStore against a real DynamoDB Local, including the search GSI
// (gsi1) the CDK stack provisions for real. Not part of `pnpm validate`; run via
// `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const newStore = () => createDynamoCourseStore({ client: local.client, tableName: local.coreTable });

const blueTee = { ...fixtureWhite, name: "blue", rating: 73.1, slope: 132 };

const makeCourse = (name: string): Course => ({
  courseId: courseId(randomUUID()),
  name,
  teeSets: [
    {
      version: 1,
      status: "current",
      provenance: "community",
      enteredBy: "Ann",
      enteredAtMs: 1_000,
      verifications: [],
      tee: fixtureWhite,
    },
  ],
});

describe("createDynamoCourseStore", () => {
  it("put (create) + get round-trip", async () => {
    const store = newStore();
    const course = makeCourse("Casa Verde GC");

    await store.put(course, undefined);

    const found = await store.get(course.courseId);
    expect(found).toEqual({ course, revision: 1 });
  });

  it("get on an unknown courseId returns undefined", async () => {
    const store = newStore();
    expect(await store.get(courseId(randomUUID()))).toBeUndefined();
  });

  it("create-when-exists (expectedRevision undefined against an existing item) throws course-conflict", async () => {
    const store = newStore();
    const course = makeCourse("Cedar Ridge");
    await store.put(course, undefined);

    await expect(store.put(course, undefined)).rejects.toMatchObject({ code: "course-conflict" });
  });

  it("stale-revision replace throws course-conflict, and a correct-revision replace lands + bumps revision", async () => {
    const store = newStore();
    const course = makeCourse("Pine Hollow");
    await store.put(course, undefined);

    // Stale: the item is at revision 1, not 2.
    await expect(store.put(course, 2)).rejects.toMatchObject({ code: "course-conflict" });

    const renamed = { ...course, name: "Pine Hollow GC" };
    await store.put(renamed, 1);

    const found = await store.get(course.courseId);
    expect(found).toEqual({ course: renamed, revision: 2 });
  });

  it("search returns {courseId, name} prefix matches by the normalized name key, respecting limit", async () => {
    const store = newStore();
    // A per-run random token, not a literal like "casa": the whole suite shares one
    // DynamoDB Local table/gsi1 partition across tests (like store.contract.test.ts's
    // shared `local`), so a fixed literal prefix could collide with a course another test
    // in this file created (e.g. "Casa Verde GC" from the round-trip test above).
    const token = randomUUID().slice(0, 8);
    const matchA = makeCourse(`${token}a verde gc`);
    const matchB = makeCourse(`${token}a blanca`);
    const nonMatch = makeCourse(`zz-${token} ridge`);
    await store.put(matchA, undefined);
    await store.put(matchB, undefined);
    await store.put(nonMatch, undefined);

    const results = await store.search(`${token}a`, 25);
    expect(new Set(results.map((r) => r.courseId))).toEqual(new Set([matchA.courseId, matchB.courseId]));
    expect(new Set(results.map((r) => r.name))).toEqual(new Set([matchA.name, matchB.name]));

    const limited = await store.search(`${token}a`, 1);
    expect(limited).toHaveLength(1);
  });

  it("search's underlying gsi1 query is INCLUDE-projected to name only — no course document or revision leaks over the wire", async () => {
    const store = newStore();
    const course = makeCourse("Whistling Sands");
    await store.put(course, undefined);

    const raw = await local.client.send(
      new QueryCommand({
        TableName: local.coreTable,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":gsi1pk": courseGsi1pk, ":prefix": "whistling" },
      }),
    );

    expect(raw.Items).toHaveLength(1);
    const item = raw.Items?.[0] as Record<string, unknown>;
    expect(item.name).toBe("Whistling Sands");
    expect(item.course).toBeUndefined();
    expect(item.revision).toBeUndefined();
  });

  it("two concurrent addTeeSet writers over the real use case both land — no lost tee set", async () => {
    const store = newStore();
    const course = makeCourse("Twin Oaks");
    await store.put(course, undefined);

    const deps = { courseStore: store, clock: createFixedClock(2_000), logger: createNullLogger() };
    const teeA = { ...fixtureWhite, name: "green", rating: 71.0, slope: 128 };
    const teeB = blueTee;

    // Two racing calls to the REAL addTeeSet use case (application/src/courses/addTeeSet.ts),
    // which retries on the store's own "course-conflict" (retryOnConflict.ts) — the
    // invariant under test is that DynamoDB's conditional write is what actually arbitrates
    // the race, not that both calls happen to interleave nicely in-process.
    await Promise.all([addTeeSet(deps)(course.courseId, { tee: teeA, enteredBy: "Bo" }), addTeeSet(deps)(course.courseId, { tee: teeB, enteredBy: "Cy" })]);

    const found = await store.get(course.courseId);
    const teeNames = found?.course.teeSets.filter((v) => v.status === "current").map((v) => v.tee.name).sort();
    expect(teeNames).toEqual(["blue", "green", "white"]);
  });
});
