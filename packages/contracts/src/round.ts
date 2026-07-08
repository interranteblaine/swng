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

const teeSetSchema = z.object({
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

const strokePlayConfigSchema = z.object({
  kind: z.literal("stroke-play"),
  id: gameIdSchema,
  scoring: z.enum(["gross", "net"]),
  players: z.array(golferIdSchema).readonly(),
  allowance: z.number().optional(),
});

const singlesMatchConfigSchema = z.object({
  kind: z.literal("singles-match"),
  id: gameIdSchema,
  a: golferIdSchema,
  b: golferIdSchema,
  allowance: z.number().optional(),
});

const stablefordConfigSchema = z.object({
  kind: z.literal("stableford"),
  id: gameIdSchema,
  players: z.array(golferIdSchema).readonly(),
  allowance: z.number().optional(),
});

const fourballMatchConfigSchema = z.object({
  kind: z.literal("fourball-match"),
  id: gameIdSchema,
  a: z.tuple([golferIdSchema, golferIdSchema]).readonly(),
  b: z.tuple([golferIdSchema, golferIdSchema]).readonly(),
  allowance: z.number().optional(),
});

const skinsConfigSchema = z.object({
  kind: z.literal("skins"),
  id: gameIdSchema,
  players: z.array(golferIdSchema).readonly(),
  allowance: z.number().optional(),
});

export const gameConfigSchema: z.ZodType<GameConfig> = z.discriminatedUnion("kind", [
  strokePlayConfigSchema,
  singlesMatchConfigSchema,
  stablefordConfigSchema,
  fourballMatchConfigSchema,
  skinsConfigSchema,
]);

// Envelope fields shared by every RoundEvent kind (see domain's RoundEventBase).
const envelope = {
  opId: opIdSchema,
  hlc: hlcSchema,
  authorId: golferIdSchema,
  seq: z.number().int().min(0).optional(),
};

export const roundEventSchema: z.ZodType<RoundEvent> = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("round-created"), roundId: roundIdSchema, card: courseCardSchema }),
  z.object({ ...envelope, kind: z.literal("participant-joined"), participant: participantSchema }),
  z.object({ ...envelope, kind: z.literal("game-added"), config: gameConfigSchema }),
  z.object({ ...envelope, kind: z.literal("round-started") }),
  z.object({ ...envelope, kind: z.literal("score-recorded"), golferId: golferIdSchema, hole: z.number(), result: holeResultSchema }),
  z.object({ ...envelope, kind: z.literal("round-finalized") }),
  z.object({ ...envelope, kind: z.literal("round-reopened") }),
]);

const runningTotalSchema = z.object({ total: z.number(), pickups: z.number() });

const strokePlayLineSchema = z.object({
  golferId: golferIdSchema,
  thru: z.number(),
  gross: runningTotalSchema,
  net: runningTotalSchema.optional(),
});

const matchOutcomeSchema = z.union([z.object({ winner: golferIdSchema, closing: z.string() }), z.object({ halved: z.literal(true) })]);

const fourballOutcomeSchema = z.union([z.object({ winner: z.enum(["a", "b"]), closing: z.string() }), z.object({ halved: z.literal(true) })]);

export const gameResultSchema: z.ZodType<GameResult> = z.discriminatedUnion("kind", [
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
