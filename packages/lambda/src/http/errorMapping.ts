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
  // M6 Task 2 (application/src/errors.ts): courses are a plain CRUD store, and this map is
  // a Record<ApplicationErrorCode, number> — exhaustive by construction, so the two new
  // codes have to land here the moment the union grows, ahead of M6 Task 4's actual course
  // routes. Same bucketing precedent as the pair above: a failed optimistic-concurrency
  // write is a 409 like round-not-live/round-final; an unknown courseId is a 404 like
  // round-not-found/bad-join-code.
  "course-conflict": 409,
  "course-not-found": 404,
  // M7 Task 2 (application/src/errors.ts) forward-provisioned this ahead of M7 Task 5's
  // actual golfer/terminate routes with a 400 (bucketed with unknown-golfer-in-game, a bad
  // BODY field). Task 5's route table puts gameId in the PATH instead
  // (POST /rounds/{roundId}/games/{gameId}/terminate) — a path-embedded resource reference
  // that doesn't exist is the same "identified resource not found" shape as
  // round-not-found/bad-join-code/course-not-found above, so the plan
  // (docs/superpowers/plans/2026-07-10-m7-identity.md, Task 5) pins 404 here instead;
  // golfer-conflict/golfer-already-claimed are failed-precondition 409s, same bucket as
  // course-conflict.
  "unknown-game": 404,
  "golfer-conflict": 409,
  "golfer-already-claimed": 409,
  // Task 5b (.superpowers/sdd/task-5b-brief.md): joinRound's supplied-golferId reuse. A
  // claimed identity is a forbidden ACTOR (not a conflicting write), the same shape as
  // not-a-participant/token-round-mismatch above — 403. A golferId already seated in THIS
  // round is a failed precondition on the roster, the same shape as golfer-conflict — 409.
  "golfer-claimed": 403,
  "golfer-already-in-round": 409,
  // M8 Task 2 (application/src/errors.ts) forward-provisions these ahead of M8 Task 4's
  // actual crew routes — same "the map is exhaustive by construction, so a code lands here
  // the instant the union grows" precedent as course-conflict/course-not-found above.
  // crew-conflict is a failed optimistic-concurrency write, same bucket as course-conflict/
  // golfer-conflict; unknown-crew is an unresolvable crewId or join code, same bucket as
  // round-not-found/bad-join-code/course-not-found; not-a-member is a forbidden ACTOR, same
  // bucket as not-a-participant/golfer-claimed; golfer-required is a bad-body precondition
  // (the caller has no account golfer yet), same bucket as unknown-golfer-in-game.
  "crew-conflict": 409,
  "unknown-crew": 404,
  "not-a-member": 403,
  "golfer-required": 400,
  // M9 hardening (application/src/errors.ts): both deliberately mapped to a genuine-bug 500,
  // not a client-shaped 4xx — every real call site is written so neither should ever actually
  // throw (put always re-passes found.sub; the join-code mint loop only exhausts on a broken
  // generator), so a client can't "fix" the request that triggered one. Still has to be an
  // explicit entry: this Record is exhaustive over ApplicationErrorCode by construction.
  "sub-drop-forbidden": 500,
  "join-code-exhausted": 500,
  // M9 hardening (claim proof-of-context): a forbidden ACTOR (the caller hasn't proven they
  // belong to this golferId's round/crew), same bucket as golfer-claimed/not-a-member above —
  // 403, not a 409 (this isn't a conflicting write, and it's checked before either 409 arm so
  // it never leaks claim status).
  "claim-proof-required": 403,
};

// `unknown-tee-set` (a command names a tee not on the card) and `game-unresolved`
// (finalize's settleRound over a game that never closed out) were this boundary's only two
// documented DomainError codes pre-M6. M6 Task 4 wired POST /courses and POST
// /courses/{courseId}/tees to domain/src/course/course.ts, which validates the request body
// itself (validateCourseName / validateTeeSet / addTeeSet's duplicate-name guard) and throws
// ten more codes on bad input — client-input errors, the same shape as `unknown-tee-set`, so
// they get the same 400 (`duplicate-tee-name` included: it's a new-name collision the client
// can correct, not a genuine-bug 409). Any other DomainError reaching here is a genuine bug,
// not a client-shaped error, so it falls through to the generic 500 below.
const DOMAIN_ERROR_STATUS: Record<string, number> = {
  "unknown-tee-set": 400,
  "game-unresolved": 409,
  "invalid-course-name": 400,
  "invalid-tee-name": 400,
  "invalid-rating": 400,
  "invalid-slope": 400,
  "invalid-hole-count": 400,
  "invalid-hole-numbering": 400,
  "invalid-par": 400,
  "invalid-yardage": 400,
  "invalid-stroke-index": 400,
  "duplicate-tee-name": 400,
  // A verify raced a revision it never saw (M6 closing wave, I1): the client's own numbers
  // are stale, the same "your view of the resource is out of date" shape as an optimistic-
  // concurrency conflict, so it gets the same 409 as course-conflict above.
  "tee-set-revised": 409,
  // M8 Task 2 (domain/src/crew/crew.ts's addMember): the golferId named in the request is
  // already on the roster — a failed precondition on the roster, same bucket as
  // crew-conflict/golfer-already-in-round above, not a genuine-bug 500.
  "duplicate-member": 409,
  // M8 close-out fix #1: addMember's sibling throw — the wire's `min(1)` doesn't trim, so a
  // whitespace-only name reaches this. A bad-body precondition, same shape as
  // duplicate-tee-name/unknown-golfer-in-game above — client-correctable, not a genuine bug.
  "invalid-member-name": 400,
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
