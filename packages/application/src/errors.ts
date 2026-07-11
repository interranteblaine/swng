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
  // Task 5b: the supplied golferId is already a participant in THIS round's fold — the check
  // exists for a clean 409 (UX), not as a data-integrity backstop. The domain fold keys
  // participants by golferId with last-write-wins, so a duplicate append collapses
  // harmlessly. Enforced here to avoid surprising joiners with silent participation changes.
  | "golfer-already-in-round"
  // M8: CrewStore is a plain CRUD store too (courses'/golfers' "conflict" precedent above) —
  // a failed expectedRevision condition on a crew put.
  | "crew-conflict"
  // M8: no crew exists under the given crewId, or the given join code names no crew.
  | "unknown-crew"
  // M8: the caller's account golfer isn't on this crew's roster (GetCrew/AddCrewMember/
  // SaveStandingGame/StartRound-with-crewId) — folds "no account golfer at all" and "a real
  // golfer who just isn't a member of THIS crew" into the one 403 the wire exposes, since
  // only a real GolferId ever lands in crew.members.
  | "not-a-member"
  // M8: CreateCrew (and JoinCrewByCode) need the caller's OWN account golfer to seat as a
  // member — a sub with no golfer yet (never PUT /me) gets this wire-honesty 400 rather than
  // a silent auto-create; the web PUTs /me first (the same T5 pattern GET /me's plan
  // amendment established).
  | "golfer-required";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApplicationError";
  }
}
