import { describe, expect, it } from "vitest";
import { ApplicationError, createNullLogger } from "@swng/application";
import { DomainError } from "@swng/domain";
import { toHttpError } from "./errorMapping.js";

// The course-validation DomainError codes thrown by domain/src/course/course.ts
// (validateCourseName / validateTeeSet / validateCard's duplicate-name guard) are client-input
// errors — the same "the request you sent is malformed" shape as a zod ContractError — so
// each must map to a coded 400, not fall through to the generic 500. Constructed here exactly
// as course.ts throws them (code + message), not invented strings.
describe("toHttpError — course validation DomainErrors map to coded 400s", () => {
  const logger = createNullLogger();

  const courseValidationCodes = [
    "invalid-course-name",
    "invalid-tee-name",
    "invalid-rating",
    "invalid-slope",
    "invalid-hole-count",
    "invalid-hole-numbering",
    "invalid-par",
    "invalid-yardage",
    "invalid-stroke-index",
    "duplicate-tee-name",
    // task-1 (unrated courses): validateTeeSet's pairing rule — exactly one of rating/slope set.
    "rating-slope-paired",
  ] as const;

  it.each(courseValidationCodes)("maps %s to 400 with the code in the body", (code) => {
    const error = new DomainError(code, `${code}: some detail`);
    const result = toHttpError(error, logger);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code, message: `${code}: some detail` });
  });

  // "tee-unrated" is no longer in the table (spec 2026-07-29 §7): the only thrower was
  // handicap/whs.ts, deleted whole. An unmapped DomainError falls through to the table's own
  // default, which this suite's fallback test below already pins.

  // Pre-existing DomainError mappings must survive this addition unchanged.
  it("still maps unknown-tee-set to 400 (pre-existing)", () => {
    const result = toHttpError(new DomainError("unknown-tee-set", "no tee set named \"blue\""), logger);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code: "unknown-tee-set", message: 'no tee set named "blue"' });
  });

  it("still maps game-unresolved to 409 (pre-existing)", () => {
    const result = toHttpError(new DomainError("game-unresolved", "game not finished"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "game-unresolved", message: "game not finished" });
  });

  // Course-cards spec: the whole-card validators (validateTeeContinuity / validateCard /
  // buildCardRecord) throw these on a bad supersede/create body — client-input the caller can
  // correct, the same 400 bucket as unknown-tee-set / duplicate-tee-name above.
  it.each([
    ["unknown-tee-id", 'tee "white" claims id "t-9", which the superseded card does not have'],
    ["duplicate-tee-id", 'tee id "t-1" submitted more than once'],
    ["mismatched-hole-count", "every tee in a card must describe the same holes; got counts 9, 18"],
  ])("maps %s to 400", (code, message) => {
    const result = toHttpError(new DomainError(code, message), logger);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code, message });
  });

  // task-15: settleRound throws round-abandoned when finalize's candidate log folds to a scrapped
  // round — a 409 terminal-state precondition, the same bucket as game-unresolved, never a 500.
  it("maps round-abandoned to 409", () => {
    const result = toHttpError(new DomainError("round-abandoned", "a scrapped round has no snapshot"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "round-abandoned", message: "a scrapped round has no snapshot" });
  });

  // An unmapped DomainError code is still a genuine-bug 500, never a client-shaped error.
  it("falls through to 500 for a DomainError code this boundary doesn't recognize", () => {
    const result = toHttpError(new DomainError("some-unmapped-code", "boom"), logger);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ code: "internal-error", message: "an unexpected error occurred" });
  });
});

// M7 Task 5: the three ApplicationErrorCodes forward-provisioned in the exhaustive map ahead
// of this task's actual golfer/terminate routes (M7 Task 2's own errors.ts comment) — each
// constructed exactly as its real throw site does (terminateGame.ts / createDynamoGolferStore's
// put+claim), never an invented string (M6 lesson: a mapping test that invents its own error
// strings proves nothing).
describe("toHttpError — M7 golfer/terminate ApplicationErrors", () => {
  const logger = createNullLogger();

  // terminateGame.ts: `if (!state.games.some(...)) throw new ApplicationError("unknown-game")`
  // — a gameId the route's OWN path segment names but the round never added. Unlike
  // unknown-golfer-in-game (a body field), this is a path-embedded resource reference, the
  // same "the identified resource doesn't exist" shape as round-not-found/course-not-found —
  // 404, not 400 (plan: docs/superpowers/plans/2026-07-10-m7-identity.md, Task 5's route
  // table).
  it("maps unknown-game to 404", () => {
    const result = toHttpError(new ApplicationError("unknown-game"), logger);
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ code: "unknown-game", message: "unknown-game" });
  });

  // createDynamoGolferStore.ts's bindSub: a TransactionCanceledException on
  // attribute_not_exists(sub) — the target golferId already has a bound sub, OR the calling sub
  // is already bound to a DIFFERENT golferId (ensureGolfer's own concurrent-mint race then
  // re-reads the winner rather than surfacing this).
  it("maps golfer-already-claimed to 409", () => {
    const result = toHttpError(new ApplicationError("golfer-already-claimed", "golfer g-1 already claimed"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "golfer-already-claimed", message: "golfer g-1 already claimed" });
  });

  // createDynamoGolferStore.ts's `put`: a ConditionalCheckFailedException on the
  // expectedRevision condition — a failed optimistic-concurrency write, same bucket as
  // crew-conflict.
  it("maps golfer-conflict to 409", () => {
    const result = toHttpError(new ApplicationError("golfer-conflict", "golfer g-1 revision mismatch (expected 2)"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "golfer-conflict", message: "golfer g-1 revision mismatch (expected 2)" });
  });

  // Navigation spec §6a: GET /golfers/{golferId}'s own getGolfer.ts throw — a path-embedded
  // golferId with no row at all, same "identified resource not found" 404 shape as
  // round-not-found/course-not-found/unknown-crew above.
  it("maps golfer-not-found to 404", () => {
    const result = toHttpError(new ApplicationError("golfer-not-found"), logger);
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ code: "golfer-not-found", message: "golfer-not-found" });
  });
});

// accounts-only identity: joinRound rejects a re-tap from a golfer already seated in THIS round —
// constructed exactly as its real throw site does (joinRound.ts), not an invented string (M6 lesson).
describe("toHttpError — joinRound golfer-already-in-round", () => {
  const logger = createNullLogger();

  // A duplicate participant-joined would corrupt the roster — same "failed precondition" 409
  // shape as golfer-conflict/crew-conflict above.
  it("maps golfer-already-in-round to 409", () => {
    const result = toHttpError(new ApplicationError("golfer-already-in-round", "golfer g-1 is already a participant in this round"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "golfer-already-in-round", message: "golfer g-1 is already a participant in this round" });
  });
});

// M8 Task 2: domain/src/crew/crew.ts's addMember throws this DomainError when the golferId
// named in the request is already on the roster — constructed exactly as that throw site
// does (code + message), not an invented string (M6 lesson).
describe("toHttpError — M8 crew DomainErrors", () => {
  const logger = createNullLogger();

  // Same "failed precondition on the aggregate" 409 shape as golfer-already-in-round above,
  // not a genuine-bug 500.
  it("maps duplicate-member to 409", () => {
    const result = toHttpError(new DomainError("duplicate-member", 'golfer "g-1" is already a member of crew "c-1"'), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "duplicate-member", message: 'golfer "g-1" is already a member of crew "c-1"' });
  });

  // M8 close-out fix #1: crew.ts's addMember throws this when the (trimmed) name is empty —
  // the wire's `min(1)` doesn't trim, so a whitespace-only name reaches this throw. A bad-body
  // precondition, same shape as unknown-golfer-in-game/duplicate-tee-name above — a coded 400,
  // not the generic 500 it fell through to before this fix.
  it("maps invalid-member-name to 400", () => {
    const result = toHttpError(new DomainError("invalid-member-name", 'member name must be at least 1 character(s): "   "'), logger);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code: "invalid-member-name", message: 'member name must be at least 1 character(s): "   "' });
  });
});

// M9 hardening (application/src/errors.ts): a deliberate genuine-bug 500 — a programmer-error
// guard, never a request the client sent wrong. Constructed exactly as its real throw site
// does (createDynamoGolferStore's put/bindSub), not an invented string (M6 lesson).
describe("toHttpError — M9 hardening ApplicationErrors (deliberate 500s)", () => {
  const logger = createNullLogger();

  it("maps sub-drop-forbidden to 500", () => {
    const result = toHttpError(new ApplicationError("sub-drop-forbidden", "put on golfer g-1 would drop its bound sub"), logger);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ code: "sub-drop-forbidden", message: "put on golfer g-1 would drop its bound sub" });
  });
});

// Crew membership (invited in, accountable out — spec §5): peekCrewInvite/joinCrewByInvite's
// token-check codes — both 403 (a forbidden ACTOR, never the dispatcher's OWN "invalid-token"
// 401 tier — errorMapping.ts's own doc comment on why), split from each other for their own
// distinct web copy, not a different HTTP status.
describe("toHttpError — crew-invite token codes (crew membership, invited in)", () => {
  const logger = createNullLogger();

  it("maps crew-invite-invalid to 403", () => {
    const result = toHttpError(new ApplicationError("crew-invite-invalid"), logger);
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ code: "crew-invite-invalid", message: "crew-invite-invalid" });
  });

  it("maps crew-invite-expired to 403", () => {
    const result = toHttpError(new ApplicationError("crew-invite-expired"), logger);
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ code: "crew-invite-expired", message: "crew-invite-expired" });
  });
});

// M9 Task 3 (share): dispatch.ts's own "participant" tier throws this when a verified
// SPECTATOR token is presented to a write route — constructed exactly as that throw site does.
describe("toHttpError — M9 Task 3 read-only-token", () => {
  const logger = createNullLogger();

  it("maps read-only-token to 403", () => {
    const result = toHttpError(new ApplicationError("read-only-token"), logger);
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ code: "read-only-token", message: "read-only-token" });
  });
});

// Architecture-realignment Task 9's own crew season/standings codes (the counted-round
// use cases' forbidden-actor codes died with the counting apparatus — crew-scoreboard
// spec §2b).
describe("toHttpError — crew seasons (architecture-realignment Task 9)", () => {
  const logger = createNullLogger();

  const codeToStatus = [
    ["invalid-season-name", 400],
    ["season-not-found", 404],
    // Spec 2026-07-22 "the season is the record" §1/§2: createSeason/updateSeason's own date
    // guard (review M4 — this is the ONLY test edit in this describe block for that arc; the
    // close/reopen codes it replaces had no rows here to delete).
    ["invalid-season-window", 400],
  ] as const;

  it.each(codeToStatus)("maps %s to %d", (code, status) => {
    const result = toHttpError(new ApplicationError(code), logger);
    expect(result.statusCode).toBe(status);
    expect(JSON.parse(result.body)).toMatchObject({ code });
  });
});

// Crew membership (invited in, accountable out — spec §1): the organizer's authority —
// removeCrewMember/transferOrganizer's organizer-only gate (ApplicationError) and leaveCrew's
// organizer guard (ApplicationError), plus crew.ts's own two domain-level roster invariants
// (DomainError) — not-a-member reuses the SAME code+status as application's own not-a-member
// (membership.ts's requireCrewMember), organizer-immovable is a fresh code.
describe("toHttpError — crew organizer authority (crew membership, invited in — spec §1)", () => {
  const logger = createNullLogger();

  it("maps ApplicationError not-organizer to 403", () => {
    const result = toHttpError(new ApplicationError("not-organizer"), logger);
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ code: "not-organizer", message: "not-organizer" });
  });

  it("maps ApplicationError organizer-must-transfer to 409", () => {
    const result = toHttpError(new ApplicationError("organizer-must-transfer", "transfer the organizer role before leaving"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "organizer-must-transfer", message: "transfer the organizer role before leaving" });
  });

  it("maps DomainError not-a-member (crew.ts's removeMember/transferOrganizer) to 403", () => {
    const result = toHttpError(new DomainError("not-a-member", 'golfer "g-1" is not a member of crew "c-1"'), logger);
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ code: "not-a-member", message: 'golfer "g-1" is not a member of crew "c-1"' });
  });

  it("maps DomainError organizer-immovable to 409", () => {
    const result = toHttpError(new DomainError("organizer-immovable", 'the organizer of crew "c-1" cannot be removed'), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "organizer-immovable", message: 'the organizer of crew "c-1" cannot be removed' });
  });
});

// Course-cards spec Task 3: CardStore.supersede's own collision code, forward-provisioned
// ahead of T4's actual card routes — same "exhaustive Record, so the mapping lands the moment
// the union grows" precedent as the crew-conflict/season-already-closed pairs above.
describe("toHttpError — course-cards (Task 3)", () => {
  it("maps ApplicationError card-superseded to 409", () => {
    const result = toHttpError(new ApplicationError("card-superseded", "course c-1: the card being replaced is no longer current"), createNullLogger());
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "card-superseded", message: "course c-1: the card being replaced is no longer current" });
  });
});
