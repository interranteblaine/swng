import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { deviceId, fixtureLinks, foldAndScore, gameId, golferId, opId, playGoldenRoundLog, roundId } from "@swng/domain";
import type { CourseCard, GameConfig, GameResult, GameState, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import { MAX_STROKES } from "./commands.js";
import { ContractError, parse } from "./parse.js";
import {
  gameConfigSchemaImpl,
  gameResultSchemaImpl,
  gameStateSchema,
  gameStateSchemaImpl,
  holeResultSchema,
  leaveRoundResponseSchema,
  roundArchiveSchema,
  roundArchiveSchemaImpl,
  roundEventSchema,
  roundEventSchemaImpl,
  shareLinkResponseSchema,
  terminateGameResponseSchema,
} from "./round.js";

// parse(JSON.parse(JSON.stringify(x))) === x — the wire round-trip every schema here has to
// survive unchanged, same pattern as courses.test.ts / crews.test.ts / golfers.test.ts.
const roundTrips = <S extends z.ZodType>(schema: S, value: z.infer<S>): void => {
  expect(parse(schema, JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
};

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

// The one course card round-created fixtures in this file build from — hoisted to module scope
// (was describe-local to roundEventSchema) so the holes-on-the-wire suite below can reuse it too.
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
  // the request copy in commands.ts bounds `strokes` to [0, MAX_STROKES], but an already-stored
  // value outside that must still PARSE — a schema rejection on a read path would make the whole
  // round unreadable forever. Both fixtures are outside the request bounds BY CONSTRUCTION
  // (MAX_STROKES + 1 and a negative), so widening or narrowing that ceiling can never quietly turn
  // this into a test of an in-bounds value.
  it("parses a stored strokes value outside the request bounds, on both the set and the join", () => {
    const set = {
      opId: "op-2", hlc: { wallMs: 6, counter: 0, deviceId: "d1" }, authorId: "g-author",
      kind: "participant-strokes-set", golferId: "g-subject", strokes: MAX_STROKES + 1,
    };
    expect(roundEventSchema.parse(set)).toEqual(set);
    const join = {
      opId: "op-3", hlc: { wallMs: 7, counter: 0, deviceId: "d1" }, authorId: "g-author",
      kind: "participant-joined", participant: { golferId: "g-subject", name: "Ann", tee: "white", strokes: -3 },
    };
    expect(roundEventSchema.parse(join)).toEqual(join);
  });

  it("parses a round-created event with no crewId (the untagged case) and round-trips through JSON unchanged", () => {
    const event: RoundEvent = {
      kind: "round-created",
      roundId: roundId("r1"),
      card,
      playedAtMs: baseHlc.wallMs,
      opId: opId("op-create"),
      hlc: baseHlc,
      authorId: golferId("author"),
    };
    const roundTripped = parse(roundEventSchema, JSON.parse(JSON.stringify(event)) as unknown);
    expect(roundTripped).toEqual(event);
    expect(roundTripped).not.toHaveProperty("crewId");
  });

  // THE no-fallback pin (spec 2026-08-01 §3a / domain events.ts's own comment): playedAtMs is
  // REQUIRED on round-created, deliberately with no fallback to hlc.wallMs or any other value. If
  // this ever passes, the required-ness has been quietly relaxed — e.g. by adding `.optional()` or
  // `.default()` back onto the field below.
  it("rejects a round-created with no playedAtMs", () => {
    const event = { kind: "round-created", roundId: roundId("r1"), card, opId: opId("op-create"), hlc: baseHlc, authorId: golferId("author") };
    expect(() => roundEventSchema.parse(event)).toThrow();
  });

  // Arc A's placement rule (pre-prod hardening, restated in commands.ts's playedAtInputSchema
  // comment): a bound belongs on the REQUEST ingress only. The stored round-created arm here
  // carries no bound at all, so a value the request schema would reject (well before 2000, and
  // negative to boot) must still parse — rejecting it would brick an already-stored round on read.
  it("accepts a stored round-created whose playedAtMs is outside the request bounds", () => {
    const event = { kind: "round-created", roundId: roundId("r1"), card, playedAtMs: -1, opId: opId("op-create"), hlc: baseHlc, authorId: golferId("author") };
    const parsed = roundEventSchema.parse(event);
    expect(parsed).toMatchObject({ playedAtMs: -1 });
  });

  it("round-trips a round-played-at-set", () => {
    const event: RoundEvent = { kind: "round-played-at-set", playedAtMs: 1_700_000_000_000, opId: opId("op-playedat"), hlc: baseHlc, authorId: golferId("author") };
    const roundTripped = parse(roundEventSchema, JSON.parse(JSON.stringify(event)) as unknown);
    expect(roundTripped).toEqual(event);
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
      playedAtMs: baseHlc.wallMs,
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

  it("roundEventSchema, gameConfigSchema, gameResultSchema, gameStateSchema and roundArchiveSchema type-parity holds in both directions (compile-time check)", () => {
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
    const forwardState: GameState = {} as z.infer<typeof gameStateSchemaImpl>;
    const backwardState: z.infer<typeof gameStateSchemaImpl> = {} as GameState;
    // The archive's own reach is NARROWER than the three above, and the difference is worth
    // stating so nothing here is credited with work it isn't doing: `roundArchiveSchemaImpl` is
    // unannotated, so a field dropped or renamed at the ARCHIVE level fails to compile — but four
    // of its members (courseCardSchema, rosterEntrySchema, scoreCellSchema, and the annotated
    // alias family) carry `z.ZodType<T>` annotations, which make z.infer equal T by declaration
    // inside them. Drift WITHIN a member is invisible here. The `roundArchiveSchema` round-trip
    // fixture below is the guard that actually bites for that.
    const forwardArchive: RoundArchive = {} as z.infer<typeof roundArchiveSchemaImpl>;
    const backwardArchive: z.infer<typeof roundArchiveSchemaImpl> = {} as RoundArchive;
    // These assignments above are the actual test — they only compile if z.infer and the
    // domain type are structurally identical in both directions. This assertion just gives
    // vitest something to run.
    expect([
      forwardEvent, backwardEvent,
      forwardConfig, backwardConfig,
      forwardResult, backwardResult,
      forwardState, backwardState,
      forwardArchive, backwardArchive,
    ]).toHaveLength(10);
  });
});

describe("gameStateSchema", () => {
  // Every fixture below folds a REAL event log through foldAndScore (domain's own reduceRound +
  // scoreGame composition) rather than building a GameState literal by hand — a hand-built
  // literal would be written from the same reading of the domain type as the schema, so both
  // could be wrong together and agree anyway. fixtureLinks is domain's own 9-hole golden card.
  const A = golferId("ann");
  const B = golferId("bo");
  const players: readonly Participant[] = [
    { golferId: A, name: "Ann", tee: "white", strokes: 6 },
    { golferId: B, name: "Bo", tee: "white", strokes: 0 },
  ];

  const gamesByKind = {
    "stroke-play": { kind: "stroke-play", id: gameId("sp1"), scoring: "net", players: [A, B] } as const,
    "singles-match": { kind: "singles-match", id: gameId("sm1"), a: A, b: B } as const,
    stableford: { kind: "stableford", id: gameId("sf1"), players: [A, B] } as const,
    "fourball-match": { kind: "fourball-match", id: gameId("fb1"), a: [A, B] as const, b: [A, B] as const } as const,
    skins: { kind: "skins", id: gameId("sk1"), scoring: "net", players: [A, B] } as const,
  };

  // A partial, unfinalized card — thru 7 of 9 — is enough to exercise every live-only field
  // (thru, remaining, dormie, carrying, holesDecided, the per-hole trails) that resultOf never
  // reaches, since a settled GameResult never carries them.
  const scores = {
    [A]: [5, 5, 3, 6, 4, 4, 5],
    [B]: [4, 5, 4, 5, 5, 3, 5],
  };

  for (const kind of ["stroke-play", "singles-match", "stableford", "fourball-match", "skins"] as const) {
    it(`round-trips a live ${kind} game`, () => {
      const events = playGoldenRoundLog(fixtureLinks, players, [gamesByKind[kind]], scores, [], false);
      const [state] = foldAndScore(events).games;
      expect(parse(gameStateSchema, JSON.parse(JSON.stringify(state)) as unknown)).toEqual(state);
    });
  }

  // The arm most likely to be missed: a singles match where up === remaining. Same card as
  // singlesMatch.test.ts's own golden dormie fixture — h7 halves, leaving Ann 2 up with 2 to play.
  it("round-trips a match that has gone dormie", () => {
    const dormieScores = {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 4],
    };
    const events = playGoldenRoundLog(fixtureLinks, players, [gamesByKind["singles-match"]], dormieScores, [], false);
    const [state] = foldAndScore(events).games;
    expect(state).toMatchObject({ dormie: true });
    expect(parse(gameStateSchema, JSON.parse(JSON.stringify(state)) as unknown)).toEqual(state);
  });
});

describe("holes on the wire (spec 2026-08-02)", () => {
  // A genesis event, built from the same course card + envelope pieces every round-created
  // fixture above already uses. Not typed as `RoundEvent`: keeping it structural lets the spread
  // below add `holes` without the whole-union spread ambiguity that annotation would introduce.
  const genesis = {
    kind: "round-created" as const,
    roundId: roundId("r1"),
    card,
    playedAtMs: baseHlc.wallMs,
    opId: opId("op-genesis-holes"),
    hlc: baseHlc,
    authorId: golferId("author"),
  };

  // A bare envelope — just the fields every RoundEvent kind carries (RoundEventBase) — for
  // building the round-holes-set correction event below.
  const envelope = { opId: opId("op-holes-set"), hlc: baseHlc, authorId: golferId("author") };

  it("round-trips a genesis carrying a nine", () => {
    roundTrips(roundEventSchema, { ...genesis, holes: "back" });
  });

  // The no-migration pin: a stored genesis with no `holes` key parses, and stays without one.
  it("parses a genesis with no holes and does not invent one", () => {
    const parsed = parse(roundEventSchema, genesis);
    expect("holes" in parsed).toBe(false);
  });

  it("round-trips the correction event", () => {
    roundTrips(roundEventSchema, { ...envelope, kind: "round-holes-set", holes: "front" });
  });

  it("rejects a selection that is not one of the three", () => {
    expect(() => parse(roundEventSchema, { ...envelope, kind: "round-holes-set", holes: "middle" })).toThrow(ContractError);
  });

  // holes is REQUIRED on the correction arm (unlike round-created's own optional holes above) —
  // pinned separately so a future .optional() edit on this arm fails here, not silently.
  it("rejects a correction with no holes at all", () => {
    expect(() => parse(roundEventSchema, { ...envelope, kind: "round-holes-set" })).toThrow(ContractError);
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

  // The hole this task exists to close (spec 2026-08-02 §5): `roundArchiveSchemaImpl` had no
  // `holes` key and was non-strict, so a settled nine parsed through this schema silently lost its
  // selection and read back as an 18-hole round. Optional, same no-migration shape as the event
  // schemas above — a stored archive with no `holes` key must parse and must NOT come back with
  // one added.
  it("round-trips an archive carrying a nine, and one without", () => {
    roundTrips(roundArchiveSchema, { ...archive, holes: "front" });
    const parsed = parse(roundArchiveSchema, archive);
    expect("holes" in parsed).toBe(false);
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
