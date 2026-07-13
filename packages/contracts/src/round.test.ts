import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { deviceId, gameId, golferId, opId, roundId } from "@swng/domain";
import type { CourseCard, GameConfig, GameResult, RoundEvent } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import { gameConfigSchemaImpl, gameResultSchemaImpl, roundEventSchema, roundEventSchemaImpl, shareLinkResponseSchema, terminateGameResponseSchema } from "./round.js";

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

describe("roundEventSchema", () => {
  it("parses a valid score-recorded event and round-trips through JSON unchanged", () => {
    const roundTripped = parse(roundEventSchema, JSON.parse(JSON.stringify(scoreRecordedEvent)) as unknown);
    expect(roundTripped).toEqual(scoreRecordedEvent);
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
    { kind: "skins", id: gameId("g5"), players: [golferId("a"), golferId("b")] },
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

  it("roundEventSchema, gameConfigSchema, and gameResultSchema type-parity holds in both directions (compile-time check)", () => {
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
    // These assignments above are the actual test — they only compile if z.infer and the
    // domain type are structurally identical in both directions. This assertion just gives
    // vitest something to run.
    expect([forwardEvent, backwardEvent, forwardConfig, backwardConfig, forwardResult, backwardResult]).toHaveLength(6);
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

describe("shareLinkResponseSchema", () => {
  it("round-trips a share url", () => {
    const response = { url: "/watch/round-1#eyJyb3VuZElkIjoicm91bmQtMSJ9.sig" };
    expect(parse(shareLinkResponseSchema, JSON.parse(JSON.stringify(response)) as unknown)).toEqual(response);
  });
});
