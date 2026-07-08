import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { deviceId, gameId, golferId, opId } from "@swng/domain";
import type { GameConfig, GameResult, RoundEvent } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import { gameConfigSchemaImpl, gameResultSchemaImpl, roundEventSchema, roundEventSchemaImpl } from "./round.js";

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
