import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CardRecord } from "@swng/domain";
import { buildCardRecord, cardId, courseId, fixtureWhite, golferId, teeId } from "@swng/domain";
import { createDynamoCardStore } from "../createDynamoCardStore.js";
import { cardSk, coursePk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (course-cards plan Task 3), same idiom as courseStore.contract.test.ts:
// proves createDynamoCardStore against a real DynamoDB Local, including the search GSI
// (gsi1, shared with the old CourseStore) the CDK stack provisions for real. Not part of
// `pnpm validate`; run via `pnpm test:contract`.

let local: LocalDynamo;
beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);
afterAll(async () => {
  await local?.stop();
});

const newStore = () => createDynamoCardStore({ client: local.client, tableName: local.coreTable });

const makeRecord = (name: string, over?: Partial<Parameters<typeof buildCardRecord>[0]>): CardRecord =>
  buildCardRecord({
    cardId: cardId(randomUUID()),
    courseId: courseId(randomUUID()),
    courseName: name,
    teeSets: [{ ...fixtureWhite, teeId: teeId(randomUUID()) }],
    enteredBy: { golferId: golferId(randomUUID()), name: "Ann" },
    enteredAtMs: 1_000,
    ...over,
  });

// helper: rebuild a valid buildCardRecord input from an existing record with a fresh cardId.
// Hoisted above the describe block (its first use) — the brief's listing defines this below
// the describe block, which vitest's collect-then-run lifecycle tolerates at runtime, but
// declaring it before first use keeps the file readable top-to-bottom and avoids a
// no-use-before-define lint trip.
const recordInput = (from: CardRecord, courseName: string) => ({
  cardId: cardId(randomUUID()),
  courseId: from.courseId,
  courseName,
  teeSets: from.card.teeSets,
  enteredBy: from.enteredBy,
});

describe("createDynamoCardStore", () => {
  it("create + getCurrent round-trips the exact CardRecord", async () => {
    const store = newStore();
    const record = makeRecord("Casa Verde GC");
    await store.create(record);
    expect(await store.getCurrent(record.courseId)).toEqual(record);
  });

  it("getCurrent on an unknown lineage returns undefined", async () => {
    expect(await newStore().getCurrent(courseId(randomUUID()))).toBeUndefined();
  });

  it("supersede moves the pointer and keeps the old card item intact (append-only lineage)", async () => {
    const store = newStore();
    const first = makeRecord("Pine Hollow");
    await store.create(first);
    const second = buildCardRecord({
      cardId: cardId(randomUUID()),
      courseId: first.courseId,
      courseName: "Pine Hollow GC",
      teeSets: first.card.teeSets,
      enteredBy: first.enteredBy,
      enteredAtMs: 2_000,
      supersedes: first.cardId,
    });
    await store.supersede(second);
    expect(await store.getCurrent(first.courseId)).toEqual(second);
    // The superseded card is still there, byte-identical — never deleted (spec invariant 1).
    const raw = await local.client.send(
      new GetCommand({ TableName: local.coreTable, Key: { pk: coursePk(first.courseId), sk: cardSk(first.cardId) } }),
    );
    expect(raw.Item?.record).toEqual(first);
  });

  it("a stale supersedes (pointer already moved) throws card-superseded and writes nothing current", async () => {
    const store = newStore();
    const first = makeRecord("Twin Oaks");
    await store.create(first);
    const winner = buildCardRecord({ ...recordInput(first, "Twin Oaks"), enteredAtMs: 2_000, supersedes: first.cardId });
    const loser = buildCardRecord({ ...recordInput(first, "Twin Oaks"), enteredAtMs: 3_000, supersedes: first.cardId });
    await store.supersede(winner);
    await expect(store.supersede(loser)).rejects.toMatchObject({ code: "card-superseded" });
    expect((await store.getCurrent(first.courseId))?.cardId).toBe(winner.cardId);
  });

  it("search returns {courseId, name, holeCount} prefix matches over CURRENT pointers only, respecting limit", async () => {
    const store = newStore();
    const token = randomUUID().slice(0, 8);
    const a = makeRecord(`${token}a verde gc`);
    const b = makeRecord(`${token}a blanca`);
    const miss = makeRecord(`zz-${token} ridge`);
    await store.create(a);
    await store.create(b);
    await store.create(miss);
    const results = await store.search(`${token}a`, 25);
    expect(new Set(results.map((r) => r.courseId))).toEqual(new Set([a.courseId, b.courseId]));
    expect(results.every((r) => r.holeCount === a.card.teeSets[0]!.holes.length)).toBe(true);
    expect(await store.search(`${token}a`, 1)).toHaveLength(1);
  });

  it("a rename via supersede is found under its NEW normalized name, not the old", async () => {
    const store = newStore();
    const token = randomUUID().slice(0, 8);
    const first = makeRecord(`${token}-before`);
    await store.create(first);
    const renamed = buildCardRecord({ ...recordInput(first, `${token}-after`), enteredAtMs: 2_000, supersedes: first.cardId });
    await store.supersede(renamed);
    expect(await store.search(`${token}-after`, 5)).toHaveLength(1);
    expect(await store.search(`${token}-before`, 5)).toHaveLength(0);
  });
});
