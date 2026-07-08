import type { OpId, RoundEvent, RoundId } from "@swng/domain";

// Ingest is idempotent by construction (M3 plan, Global Constraints): a retried opId is a
// no-op success, never an error. `appended` carries only the events that actually landed,
// seq-stamped and contiguous; `duplicateOpIds` names the ones that didn't because the
// journal had already ingested them. Adapters (Dynamo included) must honor this exact split.
export interface AppendResult {
  readonly appended: readonly RoundEvent[];
  readonly duplicateOpIds: readonly OpId[];
}

export interface EventJournal {
  // Input events carry no seq — the journal assigns it. Order of `appended` matches the
  // input order, minus whichever entries turned out to be duplicates.
  //
  // Accepted race (v1, see finalizeRound.ts): append doesn't offer a "only if head seq is
  // still N" condition, so a RecordScore append racing a FinalizeRound append can land its
  // score-recorded AFTER round-finalized. A log refold at that point can include a cell the
  // archive FinalizeRound already wrote lacks. Accepted because finalize recomputes
  // idempotently and putArchive upserts — reopen-and-refinalize heals it. A head-seq
  // condition on append is the M4/M9 candidate fix, not v1 scope.
  append(roundId: RoundId, events: readonly RoundEvent[]): Promise<AppendResult>;
  // seq > sinceSeq, ascending; [] for an unknown round (never throws — distinguishing "no
  // such round" from "no new events yet" is the caller's job, via reduceRound's genesis check).
  read(roundId: RoundId, sinceSeq: number): Promise<readonly RoundEvent[]>;
}
