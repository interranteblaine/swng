import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoundEvent } from "@swng/domain";
import { deviceId, golferId, opId, roundId } from "@swng/domain";
import { createDynamoEventJournal } from "../createDynamoEventJournal.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M3 plan): proves createDynamoEventJournal against a real DynamoDB Local,
// against the SAME spec application/testing/fakes.ts's in-memory journal satisfies —
// contiguous seq from 1, opId dedupe via duplicateOpIds. Not part of `pnpm validate`; run
// via `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const device = deviceId("contract-test");
const golfer = golferId("golfer-1");
let opCounter = 0;

const makeEvent = (hole: number): RoundEvent => ({
  kind: "score-recorded",
  golferId: golfer,
  hole,
  result: { kind: "strokes", strokes: 4 },
  opId: opId(`op-${(opCounter += 1)}`),
  hlc: { wallMs: 1_000 + opCounter, counter: 0, deviceId: device },
  authorId: golfer,
});

const newJournal = () => createDynamoEventJournal({ client: local.client, tableName: local.roundsTable });

describe("createDynamoEventJournal", () => {
  it("assigns 1..n contiguous seq on the first append", async () => {
    const journal = newJournal();
    const id = roundId(randomUUID());

    const result = await journal.append(id, [makeEvent(1), makeEvent(2), makeEvent(3)]);

    expect(result.duplicateOpIds).toEqual([]);
    expect(result.appended.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("a second append continues the sequence", async () => {
    const journal = newJournal();
    const id = roundId(randomUUID());

    await journal.append(id, [makeEvent(1)]);
    const second = await journal.append(id, [makeEvent(2), makeEvent(3)]);

    expect(second.appended.map((event) => event.seq)).toEqual([2, 3]);
    const log = await journal.read(id, 0);
    expect(log.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("two concurrent 5-event appends interleave to a contiguous 1..10 with no duplicates", async () => {
    const id = roundId(randomUUID());
    const batchA = Array.from({ length: 5 }, (_, i) => makeEvent(i + 1));
    const batchB = Array.from({ length: 5 }, (_, i) => makeEvent(i + 1));

    // Two separate journal instances over the same table+round — nothing coordinates them
    // except the table's own conditional writes.
    const [resultA, resultB] = await Promise.all([newJournal().append(id, batchA), newJournal().append(id, batchB)]);

    expect(resultA.duplicateOpIds).toEqual([]);
    expect(resultB.duplicateOpIds).toEqual([]);

    const combinedSeqs = [...resultA.appended, ...resultB.appended]
      .map((event) => event.seq)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(combinedSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const log = await newJournal().read(id, 0);
    expect(log).toHaveLength(10);
    expect(log.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(log.map((event) => event.opId)).size).toBe(10);
  });

  it("an exact-duplicate opId re-send is a no-op — appended empty, log unchanged", async () => {
    const journal = newJournal();
    const id = roundId(randomUUID());
    const event = makeEvent(1);

    const first = await journal.append(id, [event]);
    expect(first.appended).toHaveLength(1);

    const resend = await journal.append(id, [event]);
    expect(resend).toEqual({ appended: [], duplicateOpIds: [event.opId] });

    const log = await journal.read(id, 0);
    expect(log).toHaveLength(1);
    expect(log[0]?.seq).toBe(1);
  });

  it("read(sinceSeq) slices correctly and paginates across multiple internal pages", async () => {
    const journal = newJournal();
    const id = roundId(randomUUID());
    const events = Array.from({ length: 150 }, (_, i) => makeEvent((i % 18) + 1));

    // Chunked to stay comfortably under TransactWriteItems' 100-item cap (2 items/event).
    for (let i = 0; i < events.length; i += 20) {
      await journal.append(id, events.slice(i, i + 20));
    }

    const all = await journal.read(id, 0);
    expect(all).toHaveLength(150);
    expect(all.map((event) => event.seq)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));

    const sliced = await journal.read(id, 140);
    expect(sliced.map((event) => event.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 141));
  }, 30_000);

  it("read returns [] for a round with no events", async () => {
    const journal = newJournal();
    const log = await journal.read(roundId(randomUUID()), 0);
    expect(log).toEqual([]);
  });

  // M6 Task 4 carry 2: AppendOptions.expectedHeadSeq — the conditional append finalizeRound
  // uses to close the settle-check-vs-append race (eventJournal.ts's doc comment).
  describe("append(..., { expectedHeadSeq })", () => {
    it("succeeds when expectedHeadSeq matches the round's current head", async () => {
      const journal = newJournal();
      const id = roundId(randomUUID());

      await journal.append(id, [makeEvent(1), makeEvent(2)]); // head is now 2

      const result = await journal.append(id, [makeEvent(3)], { expectedHeadSeq: 2 });
      expect(result.headSeqConflict).toBeFalsy();
      expect(result.appended.map((event) => event.seq)).toEqual([3]);
    });

    it("returns headSeqConflict and appends nothing when expectedHeadSeq is stale", async () => {
      const journal = newJournal();
      const id = roundId(randomUUID());

      await journal.append(id, [makeEvent(1), makeEvent(2)]); // head is now 2

      // Validated against a head of 1, but the real head has already moved to 2 — the exact
      // shape of the race finalizeRound.ts's carry 2 closes.
      const result = await journal.append(id, [makeEvent(3)], { expectedHeadSeq: 1 });
      expect(result).toEqual({ appended: [], duplicateOpIds: [], headSeqConflict: true });

      const log = await journal.read(id, 0);
      expect(log.map((event) => event.seq)).toEqual([1, 2]); // unchanged — nothing landed
    });

    it("a conditional append against an empty round (expectedHeadSeq: 0) succeeds", async () => {
      const journal = newJournal();
      const id = roundId(randomUUID());

      const result = await journal.append(id, [makeEvent(1)], { expectedHeadSeq: 0 });
      expect(result.headSeqConflict).toBeFalsy();
      expect(result.appended.map((event) => event.seq)).toEqual([1]);
    });

    // Permanent regression for the M6 Task 4 review (task-4-report.md, "Task review" ->
    // "Important"): the reviewer proved concurrency safety with throwaway probes — 8-way
    // concurrent conditional appends at the same head, exactly one winner, log contiguous,
    // never a false success — then deleted them. This captures that proof for good. The
    // check-then-act head read above is only a fast-path optimization; genuine mutual
    // exclusion comes from the per-slot `attribute_not_exists(sk)` transactional condition
    // (attemptCommit above), which is what this test actually exercises under real
    // concurrency rather than by inspection.
    it("N concurrent conditional appends at the same head: exactly one winner, log stays contiguous", async () => {
      const id = roundId(randomUUID());
      const N = 8;

      await newJournal().append(id, [makeEvent(1), makeEvent(2)]); // head is now 2

      // Every append call is fired (one journal instance each, mirroring the 27-way
      // regression below) before any promise is awaited — genuine concurrency, not
      // sequential turns wearing a Promise.all costume.
      const contenders = Array.from({ length: N }, (_, i) => makeEvent(i + 1));
      const results = await Promise.all(contenders.map((event) => newJournal().append(id, [event], { expectedHeadSeq: 2 })));

      const winners = results.filter((result) => !result.headSeqConflict);
      const losers = results.filter((result) => result.headSeqConflict);

      // Exactly one winner is a correctness guarantee of the transactional per-slot
      // condition, not a timing accident — deterministic to assert even though WHICH
      // contender wins is not.
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(N - 1);
      for (const loser of losers) {
        expect(loser).toEqual({ appended: [], duplicateOpIds: [], headSeqConflict: true });
      }

      const winner = winners[0]!;
      expect(winner.headSeqConflict).toBeFalsy();
      expect(winner.appended).toHaveLength(1);
      expect(winner.duplicateOpIds).toEqual([]);
      const winningOpId = winner.appended[0]!.opId;

      const log = await newJournal().read(id, 0);
      expect(log.map((event) => event.seq)).toEqual([1, 2, 3]); // contiguous — no gaps, no dupes
      expect(log).toHaveLength(3);
      expect(log[2]!.opId).toBe(winningOpId); // the log's only new event is the winner's
    });
  });

  // Regression for task-6-report.md: 27 fully-concurrent single-event appends (one journal
  // instance per call, matching 27 separate Lambda invocations racing one round's head slot,
  // as in the M3 E2E deck's RecordScore burst) must ALL converge — no throw, seqs exactly
  // 1..27, no duplicates. Before the full-jitter backoff + ConsistentRead fix, this reliably
  // produced ~7/27 "did not converge after 10 attempts" failures under lockstep retries.
  it("27 fully-concurrent single-event appends from 27 journal instances all converge to 1..27", async () => {
    const id = roundId(randomUUID());

    const results = await Promise.all(Array.from({ length: 27 }, (_, i) => newJournal().append(id, [makeEvent(i + 1)])));

    for (const result of results) {
      expect(result.duplicateOpIds).toEqual([]);
      expect(result.appended).toHaveLength(1);
    }

    const seqs = results.map((result) => result.appended[0]?.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(seqs).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));

    const log = await newJournal().read(id, 0);
    expect(log).toHaveLength(27);
    expect(log.map((event) => event.seq)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    expect(new Set(log.map((event) => event.opId)).size).toBe(27);
  }, 30_000);
});
