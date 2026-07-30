import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { OpId, RoundArchive, RoundEvent, RoundId } from "@swng/domain";
import { DomainError } from "@swng/domain";
import type { AppendOptions, AppendResult, EventJournal } from "@swng/application";
import { finalizedAtMsOf } from "@swng/application";
import { evtSk, evtSkMax, opIdSk, roundPk, snapshotPk } from "./keys.js";
import { queryAllPages } from "./paginate.js";
import { STORED_EVENT_INVALID, parseStoredEvent } from "./parseStored.js";

// Each Query page is capped well under DynamoDB's natural ~1MB boundary so `read` always
// exercises its own pagination loop rather than relying on payload size — a round's log is
// a few thousand events at outing scale (architecture.md), never remotely 1MB.
const READ_PAGE_SIZE = 50;

// A seq race or an opId race can each cost one round-trip; this bounds the retry loop so a
// pathological hot round fails loudly instead of spinning forever. Raised from 10 to 30
// alongside the full-jitter backoff below: with retries spaced out instead of firing in
// lockstep, a genuinely hot round (e.g. 27-way concurrent RecordScore appends, the M3 E2E
// deck) needs more attempts to converge, not fewer — see .superpowers/sdd/task-6-report.md.
const MAX_APPEND_ATTEMPTS = 30;

// Full-jitter exponential backoff (AWS's own recommended formula: random(0, min(cap, base *
// 2^attempt))), applied only between seq-collision retries. Base 25ms, capped at 1000ms —
// with 27-way concurrency (the E2E deck) this spreads losers out over a handful of attempts
// instead of every concurrent writer re-querying head and racing the same slot again
// immediately, which is what produced "did not converge after 10 attempts" under load
// (task-6-report.md).
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 1000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const backoffMs = (attempt: number, random: () => number): number => random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);

const headSeq = async (client: DynamoDBDocumentClient, tableName: string, roundId: RoundId): Promise<number> => {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :evtPrefix)",
      ExpressionAttributeValues: { ":pk": roundPk(roundId), ":evtPrefix": "EVT#" },
      ScanIndexForward: false,
      Limit: 1,
      // The rounds table's event log is the source of truth for every command — an
      // eventually-consistent read here can hand out a seq another writer already claimed
      // under a hot write burst, widening the collision window instead of just costing one
      // retry (task-6-report.md). This is the correctness path, not a scan; pay the 2x RCU.
      ConsistentRead: true,
    }),
  );
  const item = result.Items?.[0];
  if (item === undefined) return 0; // no EVT items yet — this round's log starts at seq 1.

  // Deliberately NOT a roundEventSchema parse, and the difference is the point of spec §10 rather
  // than an exception to it: this reads ONE number to pick the next seq slot and hands no
  // domain-typed value to anyone, so it declares only what it actually needs — and CHECKS that —
  // instead of asserting a whole RoundEvent it never looks at. (Parsing the head event here would
  // also make every append attempt of the hot write path pay for a full event parse, and would
  // reject the atomicity fixture in journal.contract.test.ts that deliberately pre-occupies a slot
  // with a seq-only sentinel.)
  const seq = (item["event"] as { seq?: unknown } | undefined)?.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    // The code is repeated into the message for the same reason parseStored does it — see there.
    throw new DomainError(
      STORED_EVENT_INVALID,
      `${STORED_EVENT_INVALID} — createDynamoEventJournal.headSeq: round ${roundId}'s head event carries no non-negative integer seq (got ${JSON.stringify(seq)})`,
    );
  }
  return seq;
};

// Stamps `batch` starting at `head + 1` and attempts to land every event + its OPID marker
// in one transaction. When `snapshot` is given, its Put joins the SAME transaction as one more
// item (the finalize atom — projection-realignment spec §2), so round-finalized and its
// settled archive commit together or roll back together. Returns the events that need retrying
// (either because their own EVT slot lost a seq race, or because a sibling in the same
// transaction did and rolled the whole batch back) alongside any opIds now confirmed as
// permanent duplicates.
const attemptCommit = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  roundId: RoundId,
  batch: readonly RoundEvent[],
  head: number,
  snapshot?: { tableName: string; archive: RoundArchive },
): Promise<{ committed: readonly RoundEvent[] } | { retry: readonly RoundEvent[]; duplicateOpIds: readonly OpId[] }> => {
  const stamped = batch.map((event, i) => ({ ...event, seq: head + 1 + i }));

  const eventItems = stamped.flatMap((event) => [
    {
      Put: {
        TableName: tableName,
        Item: { pk: roundPk(roundId), sk: evtSk(event.seq), event, opId: event.opId },
        ConditionExpression: "attribute_not_exists(sk)",
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: { pk: roundPk(roundId), sk: opIdSk(event.opId) },
        ConditionExpression: "attribute_not_exists(sk)",
      },
    },
  ]);

  // The snapshot Put is LAST and carries NO condition — a re-finalize replaces it, and the
  // EVT slots' own attribute_not_exists conditions are the transaction's guard (if any of them
  // loses its seq race the whole transaction, snapshot included, rolls back). Because it's
  // unconditional it can never be the cancellation cause, so the CancellationReasons indexing
  // below (which only inspects the per-event reasons at positions i*2 / i*2+1) is unaffected by
  // this trailing item. pk is the bare roundId (snapshotPk); `finalizedAt` is the archive's own
  // round-finalized wallMs (finalizedAtMsOf — one definition, shared with the projector).
  const snapshotItems = snapshot
    ? [{ Put: { TableName: snapshot.tableName, Item: { pk: snapshotPk(roundId), finalizedAt: finalizedAtMsOf(snapshot.archive), archive: snapshot.archive } } }]
    : [];

  try {
    await client.send(new TransactWriteCommand({ TransactItems: [...eventItems, ...snapshotItems] }));
    return { committed: stamped };
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;
    const reasons = error.CancellationReasons ?? [];
    const retry: RoundEvent[] = [];
    const duplicateOpIds: OpId[] = [];
    batch.forEach((event, i) => {
      // Reasons parallel TransactItems 1:1: [evtPut0, opidPut0, evtPut1, opidPut1, ...].
      // An OPID collision means this exact opId already landed — permanent, no retry. Any
      // other outcome (its own EVT slot lost a seq race, or it was rolled back only because
      // a sibling in the batch failed) needs a fresh seq on the next attempt.
      const opidReason = reasons[i * 2 + 1];
      if (opidReason?.Code === "ConditionalCheckFailed") {
        duplicateOpIds.push(event.opId);
      } else {
        retry.push(event);
      }
    });
    return { retry, duplicateOpIds };
  }
};

export const createDynamoEventJournal = (config: {
  client: DynamoDBDocumentClient;
  tableName: string;
  // The snapshots table the atomic finalize commit puts into (projection-realignment spec §2).
  // Optional because only httpFn ever carries it (swngStack.ts) and only finalizeRound ever
  // sets options.snapshot; an append that DOES set options.snapshot with this unconfigured is a
  // composition-root bug and throws loudly at call time below (never a silent no-snapshot
  // finalize).
  snapshotsTableName?: string;
  // Injection points for the contract suite to run fast/deterministic if it ever needs to —
  // production callers omit both and get a real timer-based sleep and Math.random.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): EventJournal => {
  const { client, tableName, snapshotsTableName, sleep = defaultSleep, random = Math.random } = config;

  return {
    append: async (roundId: RoundId, events: readonly RoundEvent[], options?: AppendOptions): Promise<AppendResult> => {
      // The snapshot leg needs a table to put into — a snapshot without one configured is a
      // wiring bug, caught here rather than committing round-finalized with no snapshot beside it.
      if (options?.snapshot !== undefined && snapshotsTableName === undefined) {
        throw new Error("createDynamoEventJournal: append was given options.snapshot but no snapshotsTableName was configured (composition-root bug)");
      }
      const snapshotPut =
        options?.snapshot !== undefined && snapshotsTableName !== undefined ? { tableName: snapshotsTableName, archive: options.snapshot } : undefined;
      // Each event costs 2 TransactItems (the EVT Put + its OPID marker Put, see
      // attemptCommit above), and DynamoDB caps a single TransactWriteItems call at 100
      // items — so a batch of more than 50 events would exceed the cap and fail with a
      // ValidationException from the SDK, surfaced by the first attemptCommit call this loop
      // makes (not before the loop — the loop itself doesn't count items). No caller does
      // that today: the largest real batch is StartRound's 3 events (genesis, host join,
      // round-started). Chunking a >50-event batch into multiple transactions is deliberate
      // future work, not a v1 gap.
      let pending = events;
      const duplicateOpIds: OpId[] = [];
      const expectedHeadSeq = options?.expectedHeadSeq;

      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt >= MAX_APPEND_ATTEMPTS) {
          throw new Error(`createDynamoEventJournal: append to round ${roundId} did not converge after ${MAX_APPEND_ATTEMPTS} attempts`);
        }

        const head = await headSeq(client, tableName, roundId);
        // A conditional append validates against ONE specific head, queried fresh right
        // here — if it's already moved past `expectedHeadSeq`, something landed since the
        // caller's settle-check read and this must fail now, not retry against the new head
        // (eventJournal.ts's AppendOptions doc).
        if (expectedHeadSeq !== undefined && head !== expectedHeadSeq) {
          return { appended: [], duplicateOpIds: [], headSeqConflict: true };
        }

        const outcome = await attemptCommit(client, tableName, roundId, pending, head, snapshotPut);

        if ("committed" in outcome) return { appended: outcome.committed, duplicateOpIds };

        if (expectedHeadSeq !== undefined) {
          // Same single-shot rule as the stale-head check above: attemptCommit only lands
          // here if the EVT slot it just tried lost a race (or a sibling in the batch did),
          // meaning the head moved between the query above and this transaction — surface as
          // a conflict rather than looping around to a new, unvalidated head.
          return { appended: [], duplicateOpIds, headSeqConflict: true };
        }

        // A duplicate-opId split needs no backoff — attemptCommit already told us definitively
        // which events landed elsewhere, so retrying the remainder isn't racing anyone. A pure
        // seq collision (nothing in this attempt resolved to a duplicate) means we're actually
        // contending with concurrent writers for the same head slot, so back off with full
        // jitter before the next attempt to break the lockstep.
        if (outcome.duplicateOpIds.length === 0) {
          await sleep(backoffMs(attempt, random));
        }

        duplicateOpIds.push(...outcome.duplicateOpIds);
        pending = outcome.retry;
      }

      return { appended: [], duplicateOpIds };
    },

    read: (roundId: RoundId, sinceSeq: number): Promise<readonly RoundEvent[]> =>
      queryAllPages(
        client,
        {
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
          ExpressionAttributeValues: { ":pk": roundPk(roundId), ":lo": evtSk(sinceSeq + 1), ":hi": evtSkMax },
          Limit: READ_PAGE_SIZE,
          // Same rationale as headSeq above: every use case reduces this log (via
          // loadRoundState) to decide things like "is this round live" — a stale read here
          // silently drops recent events (e.g. round-started) and produces a spurious
          // rejection under a hot write burst, not just a delayed broadcast
          // (task-6-report.md's "round-not-live" failure mode).
          ConsistentRead: true,
        },
        // Spec 2026-07-30 §10: PARSE, don't assert. This is the read every use case folds through
        // loadRoundState and every pull hands to a client, so it is the exact seam where a stored
        // shape the domain type no longer describes — a deleted `conceded` cell, a seat with no
        // `strokes` — used to be believed rather than caught (parseStored.ts's own doc).
        (item) => parseStoredEvent(`createDynamoEventJournal.read: round ${roundId} ${String(item["sk"])}`, item["event"]),
      ),
  };
};
