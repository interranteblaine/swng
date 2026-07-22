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
  // Course-cards spec: an unresolvable courseId (getCourse/supersedeCard). Courses are the
  // write-once card-lineage store now — there is no optimistic-concurrency "conflict" code;
  // a moved CURRENT pointer surfaces as card-superseded (below), never a generic conflict.
  | "course-not-found"
  // M7 Task 2: terminateGame's gameId names a game outside the fold — same "referenced id
  // isn't part of this context" shape as unknown-golfer-in-game above.
  | "unknown-game"
  // GolferStore is a plain CRUD store too (see courses' "conflict" precedent above): a
  // failed expectedRevision condition on a golfer put.
  | "golfer-conflict"
  // GolferStore.bindSub's collision code (golferStore.ts's port doc): the target golferId
  // already has a sub bound, OR the calling sub is already bound to a DIFFERENT golferId.
  // ensureGolfer's concurrent-first-request race handling catches this (the loser re-reads the
  // winner's golfer) — the code still surfaces to the client only for a genuine bind conflict.
  | "golfer-already-claimed"
  // accounts-only identity: JoinRound rejects a re-tap from a golfer who is ALREADY a
  // currently-seated participant of THIS round — a clean 409 (UX), not a data-integrity
  // backstop (the domain fold keys participants by golferId with last-write-wins, so a
  // duplicate append collapses harmlessly). A departed golfer is exempt (rejoining is just
  // joining again, spec §4).
  | "golfer-already-in-round"
  // M8: CrewStore is a plain CRUD store too (courses'/golfers' "conflict" precedent above) —
  // a failed expectedRevision condition on a crew put.
  | "crew-conflict"
  // M8: no crew exists under the given crewId.
  | "unknown-crew"
  // M8: the caller's account golfer isn't on this crew's roster (GetCrew/getSeasonStandings) —
  // folds "no account golfer at all" and "a real golfer who just isn't a member of THIS crew"
  // into the one 403 the wire exposes, since only a real GolferId ever lands in crew.members.
  | "not-a-member"
  // M8: CreateCrew (and joinCrewByInvite) need the caller's OWN account golfer to seat as a
  // member — a sub with no golfer yet (never PUT /me) gets this wire-honesty 400 rather than
  // a silent auto-create; the web PUTs /me first (the same T5 pattern GET /me's plan
  // amendment established).
  | "golfer-required"
  // Navigation spec §6a: GET /golfers/{golferId} names a golferId with no row at all
  // (GolferStore.getMany's own miss shape) — an unresolvable path-embedded resource id, the
  // same "identified resource not found" 404 shape as round-not-found/course-not-found/
  // unknown-crew above.
  | "golfer-not-found"
  // M9 hardening: GolferStore.put refuses a REPLACE that would clear a currently-bound sub
  // (golferStore.ts's port doc). Every real call site re-passes its own found.sub on every
  // replace, so this only ever fires on a programmer error — deliberately mapped to a 500 in
  // the lambda's error-mapping module (never a client-correctable 4xx), a guard against a bug,
  // not a request shape the caller controls.
  | "sub-drop-forbidden"
  // Crew membership (invited in, accountable out — spec §5): peekCrewInvite/joinCrewByInvite's
  // token check — signature/shape invalid, the crew itself can't be resolved (crews are never
  // deleted, spec §6 — defensive only), or the token's named inviter has since left the crew
  // (a removed member's outstanding invites die with their membership, checked at BOTH peek and
  // join). NEVER thrown for an expired-but-otherwise-valid token — see crew-invite-expired.
  | "crew-invite-invalid"
  // Crew membership (invited in, accountable out — spec §5): the SAME token check, but the
  // ONE condition that gets its own distinct code — `expiresAtMs` has passed. Kept separate from
  // crew-invite-invalid because the two map to different web copy (M7 never-raw discipline):
  // "this link has expired" vs. "this link isn't valid" are different asks of the user (get a
  // fresh link vs. get a different one) — see TokenClaims' own doc comment (ports/tokenIssuer.ts)
  // for why hmacTokenIssuer's verify() itself never collapses these two into one undefined.
  | "crew-invite-expired"
  // M9 Task 3 (share): a spectator token presented to a WRITE route (dispatch.ts's own
  // "participant" tier check) — a forbidden actor, same shape as not-a-participant above (403,
  // not 401: the bearer verified fine, it just isn't allowed to do this).
  | "read-only-token"
  // Architecture-realignment Task 9 (crew seasons + standings-on-read):
  // createSeason validates the season name inline — trimmed 1-60, the SAME bounds
  // validateCrewName holds a crew name to, but application-layer (a season is store data, not a
  // domain entity), so it lives here rather than in domain/crew. A bad-body precondition the
  // caller can correct, same 400 bucket as golfer-required/unknown-golfer-in-game above.
  | "invalid-season-name"
  // Task 9: getSeason found nothing under (crewId, seasonId) — an unresolvable season id, the
  // same "identified resource not found" 404 shape as unknown-crew/round-not-found above.
  | "season-not-found"
  // Close-season spec (2026-07-21): closeSeason/reopenSeason's own explicit-conflict pair — a
  // stale client learns the truth, never a silent no-op (the tee-set-revised/card-superseded
  // precedent), same 409 bucket as crew-conflict.
  | "season-already-closed"
  | "season-not-closed"
  // Task 9: originally the counted-round use cases' own forbidden-actor codes (a member
  // appending a round they didn't play / removing one they didn't append). The counting
  // apparatus these guarded is deleted whole (crew-scoreboard spec §2b) — kept here, unused,
  // rather than chased as a separate cleanup this task's scope didn't cover.
  | "did-not-play"
  | "not-the-appender"
  // Crew membership (invited in, accountable out — spec §1): removeCrewMember/transferOrganizer's
  // authorization gate — the caller passed requireCrewMember (they ARE a member) but isn't the
  // crew's organizer. A forbidden ACTOR, same 403 bucket as not-a-member/did-not-play above.
  | "not-organizer"
  // Crew membership (invited in, accountable out — spec §1): leaveCrew's organizer guard — the
  // organizer cannot leave (the crew would be left with none). A failed lifecycle precondition,
  // same 409 bucket as season-already-closed/crew-conflict above; the message names the way out
  // (transfer the role first, then leave).
  | "organizer-must-transfer"
  // Course-cards spec §6: CardStore.supersede's collision signal — the CURRENT pointer no
  // longer names the card the caller reviewed (record.supersedes). No retry, no revision
  // counter: a moved pointer means a human re-reviews the now-current card, same 409 bucket as
  // crew-conflict above.
  | "card-superseded";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApplicationError";
  }
}
