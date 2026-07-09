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
  | "course-not-found";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApplicationError";
  }
}
