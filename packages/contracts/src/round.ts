import { z } from "zod";
import type { CourseCard, GameConfig, GameResult, HoleResult, Participant, RoundEvent } from "@swng/domain";
import { gameIdSchema, golferIdSchema, hlcSchema, opIdSchema, roundIdSchema } from "./ids.js";

// Wire mirrors of domain types. These stay structural (loose numeric bounds where the
// domain type itself doesn't declare one) — the source of truth for "is this score
// legal" is domain/M6's course-data validation, not the transport layer; the request
// schemas in commands.ts own the stricter boundary checks (courseHandicap int, hole >= 1, …).
export const holeResultSchema: z.ZodType<HoleResult> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("strokes"), strokes: z.number() }),
  z.object({ kind: z.literal("picked-up") }),
  z.object({ kind: z.literal("conceded") }),
]);

const holeSchema = z.object({
  number: z.number().int(),
  par: z.number().int(),
  yardage: z.number().int(),
  strokeIndex: z.number().int(),
});

// Exported for reuse wherever a wire tee set is needed outside a CourseCard (courses.ts'
// tee-input payloads) — the one wire mirror of domain's TeeSet, not duplicated per caller.
export const teeSetSchema = z.object({
  name: z.string(),
  rating: z.number(),
  slope: z.number(),
  holes: z.array(holeSchema).readonly(),
});

export const courseCardSchema: z.ZodType<CourseCard> = z.object({
  courseName: z.string(),
  teeSets: z.array(teeSetSchema).min(1).readonly(),
});

export const participantSchema: z.ZodType<Participant> = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  tee: z.string(),
  courseHandicap: z.number(),
});

// The per-kind fields shared by GameConfig (below) and GameConfigInput (the id-less,
// client-submitted shape built in commands.ts) — the single source of truth so a new
// game kind only needs its fields declared once. GameConfig wraps the array/tuple
// fields in `.readonly()` (frozen, matching the domain type's shape at game-added
// time); GameConfigInput reuses these same field schemas unwrapped — mutable, as a
// client request body should be — then adds `.strict()` on top.
export const gameConfigFields = {
  "stroke-play": {
    scoring: z.enum(["gross", "net"]),
    players: z.array(golferIdSchema),
    allowance: z.number().optional(),
  },
  "singles-match": {
    a: golferIdSchema,
    b: golferIdSchema,
    allowance: z.number().optional(),
  },
  stableford: {
    players: z.array(golferIdSchema),
    allowance: z.number().optional(),
  },
  "fourball-match": {
    a: z.tuple([golferIdSchema, golferIdSchema]),
    b: z.tuple([golferIdSchema, golferIdSchema]),
    allowance: z.number().optional(),
  },
  skins: {
    players: z.array(golferIdSchema),
    allowance: z.number().optional(),
  },
} as const;

const strokePlayConfigSchema = z.object({
  kind: z.literal("stroke-play"),
  id: gameIdSchema,
  ...gameConfigFields["stroke-play"],
  players: gameConfigFields["stroke-play"].players.readonly(),
});

const singlesMatchConfigSchema = z.object({
  kind: z.literal("singles-match"),
  id: gameIdSchema,
  ...gameConfigFields["singles-match"],
});

const stablefordConfigSchema = z.object({
  kind: z.literal("stableford"),
  id: gameIdSchema,
  ...gameConfigFields.stableford,
  players: gameConfigFields.stableford.players.readonly(),
});

const fourballMatchConfigSchema = z.object({
  kind: z.literal("fourball-match"),
  id: gameIdSchema,
  ...gameConfigFields["fourball-match"],
  a: gameConfigFields["fourball-match"].a.readonly(),
  b: gameConfigFields["fourball-match"].b.readonly(),
});

const skinsConfigSchema = z.object({
  kind: z.literal("skins"),
  id: gameIdSchema,
  ...gameConfigFields.skins,
  players: gameConfigFields.skins.players.readonly(),
});

// Unannotated on purpose: the compile-time parity check in round.test.ts infers this impl's
// own Output type (no `z.ZodType<GameConfig>` steering it toward the domain type) and diffs it
// against GameConfig in both directions, so a union member silently dropped from the array
// below fails typecheck instead of vanishing behind the annotation. `gameConfigSchema` below
// is the same schema object, just re-typed for callers — runtime behavior is identical.
export const gameConfigSchemaImpl = z.discriminatedUnion("kind", [
  strokePlayConfigSchema,
  singlesMatchConfigSchema,
  stablefordConfigSchema,
  fourballMatchConfigSchema,
  skinsConfigSchema,
]);
export const gameConfigSchema: z.ZodType<GameConfig> = gameConfigSchemaImpl;

// Envelope fields shared by every RoundEvent kind (see domain's RoundEventBase).
const envelope = {
  opId: opIdSchema,
  hlc: hlcSchema,
  authorId: golferIdSchema,
  seq: z.number().int().min(0).optional(),
};

// Same unannotated-impl / annotated-alias split as gameConfigSchema above, for the same
// reason: round.test.ts's parity check needs this impl's own inferred Output type, not one
// steered to RoundEvent by an annotation on this const itself.
export const roundEventSchemaImpl = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("round-created"), roundId: roundIdSchema, card: courseCardSchema }),
  z.object({ ...envelope, kind: z.literal("participant-joined"), participant: participantSchema }),
  z.object({ ...envelope, kind: z.literal("game-added"), config: gameConfigSchemaImpl }),
  z.object({ ...envelope, kind: z.literal("round-started") }),
  z.object({ ...envelope, kind: z.literal("score-recorded"), golferId: golferIdSchema, hole: z.number(), result: holeResultSchema }),
  z.object({ ...envelope, kind: z.literal("round-finalized") }),
  z.object({ ...envelope, kind: z.literal("round-reopened") }),
  z.object({ ...envelope, kind: z.literal("game-terminated"), gameId: gameIdSchema }),
]);
export const roundEventSchema: z.ZodType<RoundEvent> = roundEventSchemaImpl;

const runningTotalSchema = z.object({ total: z.number(), pickups: z.number() });

const strokePlayLineSchema = z.object({
  golferId: golferIdSchema,
  thru: z.number(),
  gross: runningTotalSchema,
  net: runningTotalSchema.optional(),
});

const matchOutcomeSchema = z.union([z.object({ winner: golferIdSchema, closing: z.string() }), z.object({ halved: z.literal(true) })]);

const fourballOutcomeSchema = z.union([z.object({ winner: z.enum(["a", "b"]), closing: z.string() }), z.object({ halved: z.literal(true) })]);

// Same unannotated-impl / annotated-alias split as gameConfigSchema and roundEventSchema
// above, for the same reason: round.test.ts's parity check needs this impl's own inferred
// Output type, not one steered to GameResult by an annotation on this const itself.
export const gameResultSchemaImpl = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stroke-play"), id: gameIdSchema, scoring: z.enum(["gross", "net"]), lines: z.array(strokePlayLineSchema).readonly() }),
  z.object({ kind: z.literal("singles-match"), id: gameIdSchema, outcome: matchOutcomeSchema, thru: z.number() }),
  z.object({
    kind: z.literal("stableford"),
    id: gameIdSchema,
    points: z.array(z.object({ golferId: golferIdSchema, points: z.number() })).readonly(),
  }),
  z.object({ kind: z.literal("fourball-match"), id: gameIdSchema, outcome: fourballOutcomeSchema, thru: z.number() }),
  z.object({
    kind: z.literal("skins"),
    id: gameIdSchema,
    won: z.array(z.object({ golferId: golferIdSchema, skins: z.number() })).readonly(),
    carriedOut: z.number(),
  }),
]);
export const gameResultSchema: z.ZodType<GameResult> = gameResultSchemaImpl;
