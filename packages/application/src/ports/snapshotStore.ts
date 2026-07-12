import type { RoundArchive, RoundId } from "@swng/domain";

// The read side of the snapshots table (projection-realignment spec §1/§11: "the snapshot IS
// the atom") — one immutable item per finalized round, keyed by the bare roundId (a key is an
// identity; time is an attribute, never a sort key). This port is READ-ONLY by design: a
// snapshot is only ever written as one leg of EventJournal.append's cross-table
// TransactWriteItems finalize commit (AppendOptions.snapshot), so the round-finalized event
// and its settled snapshot land atomically or not at all. There is deliberately no put() here
// — a caller that could write a snapshot outside that transaction could write one whose event
// log never gained its round-finalized, exactly the split-brain the atom exists to rule out.
export interface SnapshotStore {
  // undefined for a round that was never finalized. finalizeRound's idempotent branch reads
  // this (ConsistentRead in the adapter) to hand back an already-final round's settled results
  // without appending a second round-finalized; a final round whose snapshot is missing here is
  // corrupt, never silently re-settled.
  get(roundId: RoundId): Promise<RoundArchive | undefined>;
  // Batch fetch — order is NOT guaranteed and absent ids are omitted (a roundId with no
  // snapshot simply doesn't appear in the result), same contract a DynamoDB BatchGetItem gives.
  getMany(roundIds: readonly RoundId[]): Promise<readonly RoundArchive[]>;
  // Forward-only pagination over the whole table (the rebuild's replay source, Task 5). The
  // cursor is opaque to callers — pass back the one a prior page returned; a page with no
  // cursor is the last one.
  page(cursor?: string): Promise<{ snapshots: readonly RoundArchive[]; cursor?: string }>;
}
