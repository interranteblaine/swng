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
  | "golfer-required"
  // M9 hardening: GolferStore.put refuses a REPLACE that would clear a currently-bound sub
  // (golferStore.ts's port doc). Every real call site re-passes its own found.sub on every
  // replace, so this only ever fires on a programmer error — deliberately mapped to a 500 in
  // the lambda's error-mapping module (never a client-correctable 4xx), a guard against a bug,
  // not a request shape the caller controls.
  | "sub-drop-forbidden"
  // M9 hardening: createCrew's join-code mint loop (crews/createCrew.ts) exhausted its bounded
  // attempts without finding a code no crew already holds — astronomically unlikely at v1's
  // scale (a fresh 6-char draw from a 32-symbol alphabet colliding 5 times running), so this
  // is a genuine-bug signal (the alphabet/generator itself broken), not a request the caller
  // can retry their way out of — deliberately mapped to 500, same reasoning as
  // sub-drop-forbidden above.
  | "join-code-exhausted"
  // M9 hardening (claim proof-of-context, task-2-brief.md): claimGolfer.ts's `code` failed to
  // resolve to a round or crew that actually contains the target golferId — a forbidden actor
  // (the caller hasn't proven they belong to this golfer's history), the same shape as
  // golfer-claimed/not-a-member above, so 403. Checked BEFORE golfer-already-claimed/
  // golfer-conflict below so a wrong code can never be used to probe whether a golferId is
  // already claimed.
  | "claim-proof-required"
  // M9 Task 3 (share): a spectator token presented to a WRITE route (dispatch.ts's own
  // "participant" tier check) — a forbidden actor, same shape as claim-proof-required/
  // not-a-participant above (403, not 401: the bearer verified fine, it just isn't allowed to
  // do this).
  | "read-only-token"
  // M9 hardening (papercut 8): saveStandingGame.ts's preset names a golferId that isn't (or is
  // no longer) on the crew's own roster — a bad-body precondition the caller can correct (drop
  // or re-add the player), same bucket as unknown-golfer-in-game/duplicate-tee-name, not a
  // genuine-bug 500.
  | "unknown-preset-player"
  // Projection-realignment Task 6: getRoundArchive's authorization check — the caller's
  // account golfer (if any) isn't among archive.participants. A forbidden ACTOR, same shape as
  // not-a-participant/not-a-member above — 403, never a 404 (round-not-found already covers
  // "no snapshot exists at all"; this is "it exists, you may not see it"). Task 9 adds a
  // crew-membership arm ahead of this rejection (see getRoundArchive.ts's own TODO); until
  // then every non-participant, including a stranger with no golfer row at all, lands here.
  | "not-a-viewer"
  // Architecture-realignment Task 8 (task-8-brief.md): CrewStore.addCountedRound's collision
  // signal — the SAME roundId is already counted in THIS season of the crew. Storage-level
  // dedupe only; the SAME round counted in a DIFFERENT season of the same crew is allowed and
  // never trips this.
  | "round-already-counted"
  // Architecture-realignment Task 9 (crew seasons + counted rounds + standings-on-read):
  // createSeason validates the season name inline — trimmed 1-60, the SAME bounds
  // validateCrewName holds a crew name to, but application-layer (a season is store data, not a
  // domain entity), so it lives here rather than in domain/crew. A bad-body precondition the
  // caller can correct, same 400 bucket as golfer-required/unknown-golfer-in-game above.
  | "invalid-season-name"
  // Task 9: getSeason found nothing under (crewId, seasonId) — an unresolvable season id, the
  // same "identified resource not found" 404 shape as unknown-crew/round-not-found above.
  | "season-not-found"
  // Task 9: an append or remove against a CLOSED season — a failed precondition on the season's
  // own lifecycle, same 409 bucket as round-already-counted/crew-conflict above.
  | "season-closed"
  // Task 9: the appender's own golferId isn't among the counted round's snapshot participants
  // ("you can only count a round you actually played" — spec §4). A forbidden actor, same 403
  // bucket as not-a-member/not-a-viewer above.
  | "did-not-play"
  // Task 9: only the member who appended a counted round may remove it. A forbidden actor, same
  // 403 bucket as did-not-play/not-a-member above.
  | "not-the-appender"
  // Task 9 (de-ghost, spec §4 "membership: real accounts only"): addCrewMember now requires the
  // target golfer to already carry a bound sub (a real account) — adding a fresh unclaimed ghost
  // to a crew is gone. A failed precondition on the target, same 409 bucket as crew-conflict/
  // round-already-counted above (client-correctable: claim the ghost first, then add).
  | "ghost-not-addable";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApplicationError";
  }
}
