import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { deviceId, gameId, golferId, opId, roundId } from "@swng/domain";
import type { CourseCard, GameConfig, GameResult, RoundArchive, RoundEvent } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  gameConfigSchemaImpl,
  gameResultSchemaImpl,
  holeResultSchema,
  leaveRoundResponseSchema,
  roundArchiveSchema,
  roundArchiveSchemaImpl,
  roundEventSchema,
  roundEventSchemaImpl,
  shareLinkResponseSchema,
  terminateGameResponseSchema,
} from "./round.js";

const baseHlc = { wallMs: 1_000, counter: 0, deviceId: deviceId("device-1") };

const scoreRecordedEvent: RoundEvent = {
  kind: "score-recorded",
  golferId: golferId("ann"),
  hole: 5,
  result: { kind: "strokes", strokes: 4 },
  opId: opId("op-1"),
  hlc: baseHlc,
  authorId: golferId("ann"),
};

describe("holeResultSchema", () => {
  // A gimme carries the score you would have made — there is no separate "conceded" state to
  // ask the player about (task-1, spec §7). `strokes`/`picked-up`/`cleared` are the whole union.
  it("rejects a conceded hole result — a gimme is recorded as its score", () => {
    expect(() => holeResultSchema.parse({ kind: "conceded", strokes: 4 })).toThrow();
  });
});

describe("roundEventSchema", () => {
  it("parses a valid score-recorded event and round-trips through JSON unchanged", () => {
    const roundTripped = parse(roundEventSchema, JSON.parse(JSON.stringify(scoreRecordedEvent)) as unknown);
    expect(roundTripped).toEqual(scoreRecordedEvent);
  });

  it("parses a score-recorded event carrying a cleared result", () => {
    const event: RoundEvent = { ...scoreRecordedEvent, hole: 3, result: { kind: "cleared" } };
    const roundTripped = parse(roundEventSchema, JSON.parse(JSON.stringify(event)) as unknown);
    expect(roundTripped).toEqual(event);
  });

  it("rejects an event with an unknown kind", () => {
    expect(() => parse(roundEventSchema, { ...scoreRecordedEvent, kind: "score-deleted" })).toThrow(ContractError);
  });

  it("keeps seq when present", () => {
    const withSeq = { ...scoreRecordedEvent, seq: 42 };
    const parsed = parse(roundEventSchema, withSeq);
    expect(parsed.seq).toBe(42);
  });

  it("leaves seq undefined when absent", () => {
    const parsed = parse(roundEventSchema, scoreRecordedEvent);
    expect(parsed.seq).toBeUndefined();
  });

  const gameConfigs: readonly GameConfig[] = [
    { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [golferId("a"), golferId("b")] },
    { kind: "singles-match", id: gameId("g2"), a: golferId("a"), b: golferId("b") },
    { kind: "stableford", id: gameId("g3"), players: [golferId("a"), golferId("b")] },
    { kind: "fourball-match", id: gameId("g4"), a: [golferId("a"), golferId("b")], b: [golferId("c"), golferId("d")] },
    { kind: "skins", id: gameId("g5"), scoring: "net", players: [golferId("a"), golferId("b")] },
  ];

  it.each(gameConfigs)("parses a game-added event carrying a $kind config", (config) => {
    const event: RoundEvent = { kind: "game-added", config, opId: opId("op-config"), hlc: baseHlc, authorId: golferId("author") };
    expect(parse(roundEventSchema, event)).toEqual(event);
  });

  it("parses a valid game-terminated event and round-trips through JSON unchanged (M7 Task 1's union member)", () => {
    const event: RoundEvent = { kind: "game-terminated", gameId: gameId("g1"), opId: opId("op-terminate"), hlc: baseHlc, authorId: golferId("author") };
    const roundTripped = parse(roundEventSchema, JSON.parse(JSON.stringify(event)) as unknown);
    expect(roundTripped).toEqual(event);
  });

  it("parses participant-strokes-set", () => {
    const event = {
      opId: "op-1", hlc: { wallMs: 5, counter: 0, deviceId: "d1" }, authorId: "g-author",
      kind: "participant-strokes-set", golferId: "g-subject", strokes: 20,
    };
    expect(roundEventSchema.parse(event)).toEqual(event);
  });

  // The STORED arm is deliberately unbounded (round.ts's own comment, Arc A's placement rule):
  // the request copy in commands.ts bounds `strokes` to [0, 54], but an already-stored value
  // outside that must still PARSE — a schema rejection on a read path would make the whole round
  // unreadable forever.
  it("parses a stored strokes value outside the request bounds, on both the set and the join", () => {
    const set = {
      opId: "op-2", hlc: { wallMs: 6, counter: 0, deviceId: "d1" }, authorId: "g-author",
      kind: "participant-strokes-set", golferId: "g-subject", strokes: 99,
    };
    expect(roundEventSchema.parse(set)).toEqual(set);
    const join = {
      opId: "op-3", hlc: { wallMs: 7, counter: 0, deviceId: "d1" }, authorId: "g-author",
      kind: "participant-joined", participant: { golferId: "g-subject", name: "Ann", tee: "white", strokes: -3 },
    };
    expect(roundEventSchema.parse(join)).toEqual(join);
  });

  const card: CourseCard = {
    courseName: "Test Links",
    teeSets: [
      {
        name: "white",
        rating: 71.2,
        slope: 128,
        holes: Array.from({ length: 9 }, (_, index) => ({ number: index + 1, par: 4, yardage: 380, strokeIndex: index + 1 })),
      },
    ],
  };

  it("parses a round-created event with no crewId (the untagged case) and round-trips through JSON unchanged", () => {
    const event: RoundEvent = { kind: "round-created", roundId: roundId("r1"), card, opId: opId("op-create"), hlc: baseHlc, authorId: golferId("author") };
    const roundTripped = parse(roundEventSchema, JSON.parse(JSON.stringify(event)) as unknown);
    expect(roundTripped).toEqual(event);
    expect(roundTripped).not.toHaveProperty("crewId");
  });

  // Round-is-a-sealed-leaf + append-only event log: an OLD stored round-created from the M8 era
  // still carries a `crewId` key. The schema no longer declares that field, but it isn't
  // `.strict()` either — so the key parses and is STRIPPED (Zod's default), never rejected. The
  // parsed result must have no crewId property at all.
  it("parses an OLD round-created event carrying a stray crewId and strips it", () => {
    const legacy = {
      kind: "round-created",
      roundId: roundId("r1"),
      card,
      crewId: "crew-1", // the stray key an M8-era stored log still carries
      opId: opId("op-create"),
      hlc: baseHlc,
      authorId: golferId("author"),
    };
    const parsed = parse(roundEventSchema, legacy);
    expect(parsed).not.toHaveProperty("crewId");
    expect(parsed).toMatchObject({ kind: "round-created", roundId: roundId("r1") });
  });

  // Skins' `scoring` arrived AFTER rounds were already on file, and this schema is a READ/FOLD path
  // — the client parses every pulled event through it from seq 0 (client/src/transport.ts), and the
  // WS envelope does too. A stored game-added event written before the field existed carries no
  // `scoring` key, so the shared field set defaults it rather than requiring it: a legacy skins
  // round stays readable, and reads as the net pot it always was. Requiring it here would have left
  // the server finalizing fine while no client could read the round at all.
  it("parses an OLD skins game-added event with no scoring key and reads it as net", () => {
    const legacy = {
      kind: "game-added",
      config: { kind: "skins", id: gameId("g-legacy"), players: [golferId("a"), golferId("b")] },
      opId: opId("op-legacy-skins"),
      hlc: baseHlc,
      authorId: golferId("author"),
    };
    const parsed = parse(roundEventSchema, legacy);
    expect(parsed).toMatchObject({ kind: "game-added", config: { kind: "skins", scoring: "net" } });
  });

  it("roundEventSchema, gameConfigSchema, gameResultSchema and roundArchiveSchema type-parity holds in both directions (compile-time check)", () => {
    // Deliberately checked against the *Impl consts (round.ts), not the exported
    // roundEventSchema / gameConfigSchema / gameResultSchema aliases: those aliases carry
    // an explicit `z.ZodType<RoundEvent>` annotation, which makes
    // `z.infer<typeof roundEventSchema>` equal RoundEvent by declaration — a tautology
    // that compiles even if a union member silently falls out of the schema array. The
    // *Impl consts are unannotated, so z.infer here is TypeScript's own structural
    // inference of what the schema actually parses to; diffing that against the domain
    // type in both directions is the real check. (roundEventSchema — the annotated public
    // alias, same runtime object as roundEventSchemaImpl — is still exercised for real by
    // every parse(...) call elsewhere in this file.)
    const forwardEvent: RoundEvent = {} as z.infer<typeof roundEventSchemaImpl>;
    const backwardEvent: z.infer<typeof roundEventSchemaImpl> = {} as RoundEvent;
    const forwardConfig: GameConfig = {} as z.infer<typeof gameConfigSchemaImpl>;
    const backwardConfig: z.infer<typeof gameConfigSchemaImpl> = {} as GameConfig;
    const forwardResult: GameResult = {} as z.infer<typeof gameResultSchemaImpl>;
    const backwardResult: z.infer<typeof gameResultSchemaImpl> = {} as GameResult;
    const forwardArchive: RoundArchive = {} as z.infer<typeof roundArchiveSchemaImpl>;
    const backwardArchive: z.infer<typeof roundArchiveSchemaImpl> = {} as RoundArchive;
    // These assignments above are the actual test — they only compile if z.infer and the
    // domain type are structurally identical in both directions. This assertion just gives
    // vitest something to run.
    expect([forwardEvent, backwardEvent, forwardConfig, backwardConfig, forwardResult, backwardResult, forwardArchive, backwardArchive]).toHaveLength(8);
  });
});

// The stored shape of a settled round (spec 2026-07-30 §10). Its members are the same wire
// schemas the tests above already exercise, so this suite covers only what composing them adds:
// that a real settled archive round-trips, and that the absences the adapters' old cast waved
// through are now rejected.
describe("roundArchiveSchema", () => {
  const archiveCard: CourseCard = {
    courseName: "Test Links",
    teeSets: [
      { name: "white", rating: 71.2, slope: 128, holes: Array.from({ length: 9 }, (_, index) => ({ number: index + 1, par: 4, yardage: 380, strokeIndex: index + 1 })) },
    ],
  };

  const archive: RoundArchive = {
    roundId: roundId("r1"),
    card: archiveCard,
    participants: [
      { golferId: golferId("ann"), name: "Ann", tee: "white", strokes: 0 },
      // A departed seat that still settled — `departed` is optional and only ever true.
      { golferId: golferId("bo"), name: "Bo", tee: "blue", strokes: 6, departed: true },
    ],
    games: [{ kind: "skins", id: gameId("g1"), scoring: "net", players: [golferId("ann"), golferId("bo")] }],
    cells: { "ann#1": { result: { kind: "strokes", strokes: 4 }, recordedBy: golferId("ann"), hlc: baseHlc, opId: opId("op-cell-1") } },
    events: [scoreRecordedEvent],
    results: [{ kind: "skins", id: gameId("g1"), won: [{ golferId: golferId("ann"), skins: 1 }], carriedOut: 0 }],
    terminatedGameIds: [gameId("g2")],
  };

  it("round-trips a settled archive through JSON unchanged", () => {
    expect(parse(roundArchiveSchema, JSON.parse(JSON.stringify(archive)) as unknown)).toEqual(archive);
  });

  it("rejects a participant with no strokes — the required field the adapters' cast used to wave through", () => {
    const corrupt = { ...archive, participants: [{ golferId: golferId("ann"), name: "Ann", tee: "white" }] };
    expect(() => parse(roundArchiveSchema, corrupt)).toThrow(ContractError);
  });

  it("rejects a cell carrying the deleted `conceded` arm rather than reading it as a pickup", () => {
    const corrupt = { ...archive, cells: { "ann#1": { result: { kind: "conceded", strokes: 5 }, recordedBy: golferId("ann"), hlc: baseHlc, opId: opId("op-cell-1") } } };
    expect(() => parse(roundArchiveSchema, corrupt)).toThrow(ContractError);
  });
});

describe("terminateGameResponseSchema", () => {
  it("round-trips a response carrying the appended game-terminated event", () => {
    const event: RoundEvent = { kind: "game-terminated", gameId: gameId("g1"), opId: opId("op-terminate"), hlc: baseHlc, authorId: golferId("author"), seq: 7 };
    const response = { events: [event] };
    expect(parse(terminateGameResponseSchema, JSON.parse(JSON.stringify(response)) as unknown)).toEqual(response);
  });

  it("round-trips the idempotent no-op response — an empty events array", () => {
    const response = { events: [] };
    expect(parse(terminateGameResponseSchema, response)).toEqual(response);
  });
});

describe("leaveRoundResponseSchema", () => {
  it("round-trips a response carrying the appended participant-left event", () => {
    const event: RoundEvent = { kind: "participant-left", golferId: golferId("bo"), opId: opId("op-leave"), hlc: baseHlc, authorId: golferId("bo"), seq: 9 };
    const response = { events: [event] };
    expect(parse(leaveRoundResponseSchema, JSON.parse(JSON.stringify(response)) as unknown)).toEqual(response);
  });
});

describe("shareLinkResponseSchema", () => {
  it("round-trips a share url", () => {
    const response = { url: "/watch/round-1#eyJyb3VuZElkIjoicm91bmQtMSJ9.sig" };
    expect(parse(shareLinkResponseSchema, JSON.parse(JSON.stringify(response)) as unknown)).toEqual(response);
  });
});
