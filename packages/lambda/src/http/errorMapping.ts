import type { ApplicationErrorCode, Logger } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { ContractError } from "@swng/contracts";
import { DomainError } from "@swng/domain";

// The ONE code -> HTTP status map (M3 plan, Global Constraints — "error mapping lives in
// ONE lambda module"). `unknown-golfer-in-game` isn't named in the plan's mapping sentence;
// it's a request that names a golfer outside the round, the same "referenced id isn't part
// of this context" shape as domain's `unknown-tee-set` (also 400) — bucketed alongside it
// rather than falling through to the generic 500 (flagged for final review).
const APPLICATION_ERROR_STATUS: Record<ApplicationErrorCode, number> = {
  "invalid-token": 401,
  "not-a-participant": 403,
  "token-round-mismatch": 403,
  "round-not-found": 404,
  "bad-join-code": 404,
  "round-not-live": 409,
  "round-final": 409,
  "unknown-golfer-in-game": 400,
  // Course-cards spec: an unresolvable courseId (getCourse/supersedeCard) is a 404 like
  // round-not-found/bad-join-code. Courses are a write-once card lineage now — there is no
  // optimistic-concurrency "conflict" code; a moved CURRENT pointer surfaces as card-superseded.
  "course-not-found": 404,
  // M7 Task 2 (application/src/errors.ts) forward-provisioned this ahead of M7 Task 5's
  // actual golfer/terminate routes with a 400 (bucketed with unknown-golfer-in-game, a bad
  // BODY field). Task 5's route table puts gameId in the PATH instead
  // (POST /rounds/{roundId}/games/{gameId}/terminate) — a path-embedded resource reference
  // that doesn't exist is the same "identified resource not found" shape as
  // round-not-found/bad-join-code/course-not-found above, so the plan
  // (docs/superpowers/plans/2026-07-10-m7-identity.md, Task 5) pins 404 here instead;
  // golfer-conflict/golfer-already-claimed are failed-precondition 409s, same bucket as
  // crew-conflict.
  "unknown-game": 404,
  "golfer-conflict": 409,
  "golfer-already-claimed": 409,
  // accounts-only identity: joinRound rejects a re-tap from a golfer already seated in THIS round
  // — a failed precondition on the roster, the same shape as golfer-conflict — 409.
  "golfer-already-in-round": 409,
  // M8 Task 2 (application/src/errors.ts) forward-provisions these ahead of M8 Task 4's
  // actual crew routes — same "the map is exhaustive by construction, so a code lands here
  // the instant the union grows" precedent as course-not-found above.
  // crew-conflict is a failed optimistic-concurrency write, same bucket as
  // golfer-conflict; unknown-crew is an unresolvable crewId, same bucket as
  // round-not-found/course-not-found; not-a-member is a forbidden ACTOR, same
  // bucket as not-a-participant; golfer-required is a bad-body precondition
  // (the caller has no account golfer yet), same bucket as unknown-golfer-in-game.
  "crew-conflict": 409,
  "unknown-crew": 404,
  "not-a-member": 403,
  "golfer-required": 400,
  // Navigation spec §6a: GET /golfers/{golferId}'s own unresolvable-id 404, same bucket as
  // round-not-found/course-not-found/unknown-crew above.
  "golfer-not-found": 404,
  // M9 hardening (application/src/errors.ts): deliberately mapped to a genuine-bug 500, not a
  // client-shaped 4xx — the real call site (GolferStore.put) always re-passes its own
  // found.sub, so this should never actually throw; a client can't "fix" the request that
  // triggered one. Still has to be an explicit entry: this Record is exhaustive over
  // ApplicationErrorCode by construction.
  "sub-drop-forbidden": 500,
  // Crew membership (invited in, accountable out — spec §5): peekCrewInvite/joinCrewByInvite's
  // token check. A forbidden ACTOR, same 403 bucket as not-a-member/read-only-token below — the
  // request is well-formed, this specific credential just doesn't authorize the act (never a
  // 401: dispatch.ts's OWN "invalid-token" is reserved for the dispatcher's bearer-auth tier,
  // and these two never reach it — both routes that throw them are "none"/self-service-body
  // checks, not the dispatcher's own auth gate). crew-invite-expired is split from
  // crew-invite-invalid for its own distinct web copy (errors.ts's own doc comment), not a
  // different HTTP status.
  "crew-invite-invalid": 403,
  "crew-invite-expired": 403,
  // M9 Task 3 (share): a spectator token is a verified, real bearer — just not one this WRITE
  // route accepts — a "forbidden actor" 403, same bucket as not-a-participant above, never a 401
  // (401 means "no usable identity at all", which a spectator token isn't).
  "read-only-token": 403,
  // Projection-realignment Task 6: getRoundArchive's own forbidden-actor code — same 403
  // bucket as not-a-participant/not-a-member above.
  "not-a-viewer": 403,
  // Architecture-realignment Task 8 (application/src/errors.ts): CrewStore.addCountedRound's
  // collision signal, forward-provisioned ahead of any real route that calls it (same
  // "exhaustive Record" precedent as crew-conflict above) — a failed
  // precondition on an append, same bucket as crew-conflict/golfer-already-in-round, not a
  // genuine-bug 500.
  "round-already-counted": 409,
  // Architecture-realignment Task 9 (crew seasons + counted rounds + standings-on-read): the
  // append/remove/standings/create-season use cases. Bucketed by the SAME shapes above —
  // invalid-season-name is a bad-body 400 (like invalid-crew-name); season-not-found is an
  // unresolvable id 404 (like unknown-crew); season-closed is a failed lifecycle precondition
  // 409 (like round-already-counted); did-not-play and not-the-appender are forbidden actors
  // 403 (like not-a-member/not-a-viewer).
  "invalid-season-name": 400,
  "season-not-found": 404,
  "season-closed": 409,
  "did-not-play": 403,
  "not-the-appender": 403,
  // Crew membership (invited in, accountable out — spec §1): removeCrewMember/transferOrganizer's
  // organizer-only gate — a forbidden actor, same 403 bucket as not-a-member/not-the-appender
  // above. organizer-must-transfer is leaveCrew's own guard — a failed lifecycle precondition
  // (the crew would be left with no organizer), same 409 bucket as season-closed above.
  "not-organizer": 403,
  "organizer-must-transfer": 409,
  // Course-cards spec §6 (application/src/errors.ts): CardStore.supersede's moved-pointer
  // signal — the CURRENT pointer no longer names the card the caller reviewed. A failed
  // precondition on the write, same 409 bucket as crew-conflict/round-already-counted above.
  "card-superseded": 409,
};

// `unknown-tee-set` (a command names a tee not on the card) and `game-unresolved`
// (finalize's settleRound over a game that never closed out) were this boundary's only two
// documented DomainError codes pre-M6. The course routes (POST /courses, PUT /courses/{courseId})
// go through domain/src/course/course.ts's card validators (validateCourseName / validateTeeSet /
// validateCard / validateTeeContinuity / buildCardRecord), which throw the client-input codes
// below on a bad body — the same shape as `unknown-tee-set`, so they get the same 400
// (`duplicate-tee-name` included: it's a name collision the client can correct, not a
// genuine-bug 409). Any other DomainError reaching here is a genuine bug, not a client-shaped
// error, so it falls through to the generic 500 below.
const DOMAIN_ERROR_STATUS: Record<string, number> = {
  "unknown-tee-set": 400,
  "game-unresolved": 409,
  "invalid-course-name": 400,
  "invalid-tee-name": 400,
  "invalid-rating": 400,
  "invalid-slope": 400,
  // task-1 (unrated courses): validateTeeSet's own pairing rule — rating and slope must be
  // present together or both absent. A bad-body precondition the client can correct, same
  // 400 bucket as invalid-rating/invalid-slope above.
  "rating-slope-paired": 400,
  // task-1 (unrated courses): whs.ts's scoreDifferential/courseHandicapFor — an unrated tee has
  // no differential to post. Same client-correctable-input 400 bucket as rating-slope-paired
  // above (the finalize-path throw is uncaught until T2's handicappingFor `unrated` arm — not
  // this task's concern).
  "tee-unrated": 400,
  "invalid-hole-count": 400,
  "invalid-hole-numbering": 400,
  "invalid-par": 400,
  "invalid-yardage": 400,
  "invalid-stroke-index": 400,
  "duplicate-tee-name": 400,
  // Course-cards spec (domain/course/course.ts): whole-card validation the M6 aggregate never
  // had — a submitted teeId the superseded card never carried (validateTeeContinuity), the same
  // id twice (validateTeeContinuity/buildCardRecord), or a card whose tees disagree on hole
  // count (validateCard). All bad-input the client can correct, same 400 bucket as the
  // invalid-* / duplicate-tee-name rules above.
  "unknown-tee-id": 400,
  "duplicate-tee-id": 400,
  "mismatched-hole-count": 400,
  // task-15: settleRound refused a scrapped round (finalizeRound's own settle-check throws this
  // when its candidate log folds to "abandoned"). A failed precondition on the round's terminal
  // lifecycle state, the same 409 bucket as game-unresolved/round-final above — never a
  // genuine-bug 500.
  "round-abandoned": 409,
  // M8 Task 2 (domain/src/crew/crew.ts's addMember): the golferId named in the request is
  // already on the roster — a failed precondition on the roster, same bucket as
  // crew-conflict/golfer-already-in-round above, not a genuine-bug 500.
  "duplicate-member": 409,
  // M8 close-out fix #1: addMember's sibling throw — the wire's `min(1)` doesn't trim, so a
  // whitespace-only name reaches this. A bad-body precondition, same shape as
  // duplicate-tee-name/unknown-golfer-in-game above — client-correctable, not a genuine bug.
  "invalid-member-name": 400,
  // M9 hardening (papercut 9): crew.ts's validateCrewName — same bucket as invalid-course-name/
  // invalid-member-name above.
  "invalid-crew-name": 400,
  // Crew membership (invited in, accountable out — spec §1): crew.ts's removeMember/
  // transferOrganizer — a golferId (the removeMember target, or transferOrganizer's toGolferId)
  // that isn't on the roster. Reuses the SAME code (and the SAME 403 bucket) as application's
  // own not-a-member (membership.ts's requireCrewMember) — both mean "this golferId has no
  // standing here," whether that's the caller or a named target.
  "not-a-member": 403,
  // Crew membership (invited in, accountable out — spec §1): crew.ts's removeMember — the
  // organizer can't be removed (transfer first). A failed precondition on the roster, same 409
  // bucket as duplicate-member above, not a genuine-bug 500.
  "organizer-immovable": 409,
};

// Exported so every error-shaped response — including dispatch.ts's route-not-found 404,
// which never reaches an `error instanceof ...` branch below — is built by this ONE function
// (M3 plan, Global Constraints: "error mapping lives in ONE lambda module"). Before this, the
// 404 body was a second, hand-built `{ code, message }` literal in dispatch.ts.
export const jsonResponse = (statusCode: number, body: { code: string; message: string }): { statusCode: number; body: string } => ({
  statusCode,
  body: JSON.stringify(body),
});

export const toHttpError = (error: unknown, logger: Logger): { statusCode: number; body: string } => {
  if (error instanceof ContractError) {
    return jsonResponse(400, { code: error.code, message: error.issues.join("; ") });
  }

  if (error instanceof ApplicationError) {
    return jsonResponse(APPLICATION_ERROR_STATUS[error.code], { code: error.code, message: error.message });
  }

  if (error instanceof DomainError) {
    const statusCode = DOMAIN_ERROR_STATUS[error.code];
    if (statusCode !== undefined) {
      return jsonResponse(statusCode, { code: error.code, message: error.message });
    }
  }

  // Unknown errors never leak internals to the client (M3 plan) — full detail goes to the
  // logger only.
  logger.error("dispatcher: unhandled error", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  return jsonResponse(500, { code: "internal-error", message: "an unexpected error occurred" });
};
