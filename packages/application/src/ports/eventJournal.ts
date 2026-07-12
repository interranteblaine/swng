import type { OpId, RoundArchive, RoundEvent, RoundId } from "@swng/domain";

// Ingest is idempotent by construction (M3 plan, Global Constraints): a retried opId is a
// no-op success, never an error. `appended` carries only the events that actually landed,
// seq-stamped and contiguous; `duplicateOpIds` names the ones that didn't because the
// journal had already ingested them. Adapters (Dynamo included) must honor this exact split.
export interface AppendResult {
  readonly appended: readonly RoundEvent[];
  readonly duplicateOpIds: readonly OpId[];
  // true iff `options.expectedHeadSeq` was given (see AppendOptions below) and the round's
  // head had already moved past it by commit time — `appended`/`duplicateOpIds` are both []
  // in that case (nothing was written). Absent (never true) for every unconditional append,
  // which is every call site except finalizeRound.ts's conditional one.
  readonly headSeqConflict?: boolean;
}

export interface AppendOptions {
  // When given, the append only lands if the round's head seq at commit time equals this
  // exact value — i.e. no event has landed since the caller last read up to it. A
  // conditional append is single-shot against that one validated head: any collision
  // discovered while committing (not just a stale head at the initial query) also surfaces
  // as `headSeqConflict` rather than silently retrying against a newer head the caller never
  // validated against (see finalizeRound.ts, "Head-seq conditional append").
  readonly expectedHeadSeq?: number;
  // When set, this snapshot's put commits in the SAME transaction as the event append (a
  // cross-table TransactWriteItems: the rounds table's EVT/OPID slots plus the snapshots
  // table's one item) — round-finalized and its settled RoundArchive land atomically or not at
  // all (projection-realignment spec §2: "the snapshot IS the atom"). Only finalizeRound sets
  // it, always alongside expectedHeadSeq: if the EVT slot loses its seq race the whole
  // transaction rolls back, snapshot included, and the caller sees headSeqConflict. The
  // snapshot put is unconditional (a re-finalize replaces it) — the EVT slot's own
  // attribute_not_exists condition is the transaction's guard, so the snapshot needs none.
  readonly snapshot?: RoundArchive;
}

export interface EventJournal {
  // Input events carry no seq — the journal assigns it. Order of `appended` matches the
  // input order, minus whichever entries turned out to be duplicates.
  //
  // Formerly-accepted race (v1, see finalizeRound.ts's "Head-seq conditional append" carry):
  // append used to offer no "only if head seq is still N" condition, so a RecordScore append
  // racing a FinalizeRound append could land its score-recorded AFTER round-finalized based
  // on a settle-check that never saw it. `options.expectedHeadSeq` closes that window for the
  // one caller that needs it (finalizeRound) — every other caller omits `options` and keeps
  // the original unconditional behavior.
  append(roundId: RoundId, events: readonly RoundEvent[], options?: AppendOptions): Promise<AppendResult>;
  // seq > sinceSeq, ascending; [] for an unknown round (never throws — distinguishing "no
  // such round" from "no new events yet" is the caller's job, via reduceRound's genesis check).
  read(roundId: RoundId, sinceSeq: number): Promise<readonly RoundEvent[]>;
}
