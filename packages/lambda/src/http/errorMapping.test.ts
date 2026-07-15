import { describe, expect, it } from "vitest";
import { ApplicationError, createNullLogger } from "@swng/application";
import { DomainError } from "@swng/domain";
import { toHttpError } from "./errorMapping.js";

// The ten course-validation DomainError codes thrown by domain/src/course/course.ts
// (validateCourseName / validateTeeSet / addTeeSet's duplicate-name guard) are client-input
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
  ] as const;

  it.each(courseValidationCodes)("maps %s to 400 with the code in the body", (code) => {
    const error = new DomainError(code, `${code}: some detail`);
    const result = toHttpError(error, logger);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ code, message: `${code}: some detail` });
  });

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

  // I1 (M6 closing wave): a verify racing a revision it never saw is a 409, the same
  // "your view is stale" shape as course-conflict — not a 400 (the request itself is
  // well-formed) and not silently retried.
  it("maps tee-set-revised to 409", () => {
    const result = toHttpError(new DomainError("tee-set-revised", 'tee "white" is now version 2, expected version 1'), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "tee-set-revised", message: 'tee "white" is now version 2, expected version 1' });
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
  // course-conflict.
  it("maps golfer-conflict to 409", () => {
    const result = toHttpError(new ApplicationError("golfer-conflict", "golfer g-1 revision mismatch (expected 2)"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "golfer-conflict", message: "golfer g-1 revision mismatch (expected 2)" });
  });
});

// accounts-only identity: joinRound rejects a re-tap from a golfer already seated in THIS round —
// constructed exactly as its real throw site does (joinRound.ts), not an invented string (M6 lesson).
describe("toHttpError — joinRound golfer-already-in-round", () => {
  const logger = createNullLogger();

  // A duplicate participant-joined would corrupt the roster — same "failed precondition" 409
  // shape as golfer-conflict/course-conflict above.
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

// Architecture-realignment Task 8 debt (paid here per task-9-brief.md) + Task 9's own crew
// season/counted-round/standings codes — each constructed exactly as its throw site does
// (CrewStore.addCountedRound throws round-already-counted; the season use cases throw the rest).
describe("toHttpError — crew seasons + counted rounds (architecture-realignment Tasks 8/9)", () => {
  const logger = createNullLogger();

  it("maps round-already-counted to 409 (Task 8 debt)", () => {
    const result = toHttpError(new ApplicationError("round-already-counted", "round r-1 is already counted in season s-1 of crew c-1"), logger);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "round-already-counted", message: "round r-1 is already counted in season s-1 of crew c-1" });
  });

  const codeToStatus = [
    ["invalid-season-name", 400],
    ["season-not-found", 404],
    ["season-closed", 409],
    ["did-not-play", 403],
    ["not-the-appender", 403],
  ] as const;

  it.each(codeToStatus)("maps %s to %d", (code, status) => {
    const result = toHttpError(new ApplicationError(code), logger);
    expect(result.statusCode).toBe(status);
    expect(JSON.parse(result.body)).toMatchObject({ code });
  });
});
