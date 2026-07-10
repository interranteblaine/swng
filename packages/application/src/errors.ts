// Typed, code-carrying errors for everything application enforces (authorization,
// orchestration, lookups) — DomainError covers invariants domain itself owns (e.g.
// unknown-tee-set) and is left to propagate uncaught; the two vocabularies are mapped to
// HTTP status in exactly one place, the lambda error-mapping module (M3 Task 4).
export type ApplicationErrorCode =
  | "round-not-found"
  | "bad-join-code"
  | "invalid-token"
  | "token-round-mismatch"
  | "not-a-participant"
  | "round-not-live"
  | "round-final"
  | "unknown-golfer-in-game"
  // M6: courses are a plain CRUD store (CourseStore), not event-sourced — "conflict" is
  // this layer's optimistic-concurrency signal (a failed expectedRevision condition),
  // mirroring what a head-seq condition would be for the journal (see startRound.ts's
  // accepted-race comment) if one existed there.
  | "course-conflict"
  | "course-not-found"
  // M7 Task 2: terminateGame's gameId names a game outside the fold — same "referenced id
  // isn't part of this context" shape as unknown-golfer-in-game above.
  | "unknown-game"
  // GolferStore is a plain CRUD store too (see courses' "conflict" precedent above): a
  // failed expectedRevision condition on a golfer put.
  | "golfer-conflict"
  // claimGolfer's one failure code for BOTH collision arms (golferStore.ts's port doc):
  // the target golferId already has a sub bound, OR the calling sub is already bound to a
  // DIFFERENT golferId (the "GolferMerged" case, explicitly out of v1 scope).
  | "golfer-already-claimed"
  // Task 5b (ghost continuity, .superpowers/sdd/task-5b-brief.md): joinRound's supplied-
  // golferId reuse — the target golfer's row carries a sub (claimed). A claimed identity may
  // not be joined-as by anyone in v1; join-as-self with a matching Bearer token is deferred
  // to M8. Distinct from golfer-already-claimed above (that's claimGolfer's OWN collision).
  | "golfer-claimed"
  // Task 5b: the supplied golferId is already a participant in THIS round's fold — appending
  // a second participant-joined for it would corrupt the roster (two rows, one golfer).
  | "golfer-already-in-round";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApplicationError";
  }
}
