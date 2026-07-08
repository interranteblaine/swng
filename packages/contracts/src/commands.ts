import { z } from "zod";
import type { GameId, GameResult, GolferId, RoundArchive, RoundEvent, RoundId } from "@swng/domain";
import { gameIdSchema, golferIdSchema, hlcSchema, opIdSchema, roundIdSchema } from "./ids.js";
import { courseCardSchema, gameResultSchema, holeResultSchema, roundEventSchema } from "./round.js";

// gameConfigSchema's five members, minus `id` — the server assigns the id on the
// authoritative game-added event, so a client never gets to propose one. `.strict()`
// on every member makes "carries an id" a rejection, not a silently-dropped extra key.
const strokePlayConfigInputSchema = z
  .object({
    kind: z.literal("stroke-play"),
    scoring: z.enum(["gross", "net"]),
    players: z.array(golferIdSchema),
    allowance: z.number().optional(),
  })
  .strict();

const singlesMatchConfigInputSchema = z
  .object({
    kind: z.literal("singles-match"),
    a: golferIdSchema,
    b: golferIdSchema,
    allowance: z.number().optional(),
  })
  .strict();

const stablefordConfigInputSchema = z
  .object({
    kind: z.literal("stableford"),
    players: z.array(golferIdSchema),
    allowance: z.number().optional(),
  })
  .strict();

const fourballMatchConfigInputSchema = z
  .object({
    kind: z.literal("fourball-match"),
    a: z.tuple([golferIdSchema, golferIdSchema]),
    b: z.tuple([golferIdSchema, golferIdSchema]),
    allowance: z.number().optional(),
  })
  .strict();

const skinsConfigInputSchema = z
  .object({
    kind: z.literal("skins"),
    players: z.array(golferIdSchema),
    allowance: z.number().optional(),
  })
  .strict();

export const gameConfigInputSchema = z.discriminatedUnion("kind", [
  strokePlayConfigInputSchema,
  singlesMatchConfigInputSchema,
  stablefordConfigInputSchema,
  fourballMatchConfigInputSchema,
  skinsConfigInputSchema,
]);
export type GameConfigInput = z.infer<typeof gameConfigInputSchema>;

export const startRoundRequestSchema = z.object({
  card: courseCardSchema,
  host: z.object({
    name: z.string().min(1),
    tee: z.string().min(1),
    courseHandicap: z.number().int(), // may be negative (plus handicap)
  }),
});

export const joinRoundRequestSchema = z.object({
  code: z.string().length(6),
  name: z.string().min(1),
  tee: z.string().min(1),
  courseHandicap: z.number().int(),
});

export const addGameRequestSchema = z.object({
  game: gameConfigInputSchema,
});

export const recordScoreRequestSchema = z.object({
  golferId: golferIdSchema,
  hole: z.number().int().min(1),
  result: holeResultSchema,
  opId: opIdSchema,
  hlc: hlcSchema,
});

export interface StartRoundResponse {
  readonly roundId: RoundId;
  readonly joinCode: string;
  readonly token: string;
  readonly golferId: GolferId;
}

export interface JoinRoundResponse {
  readonly roundId: RoundId;
  readonly token: string;
  readonly golferId: GolferId;
}

export interface AddGameResponse {
  readonly gameId: GameId;
  readonly seq: number;
}

// seq is absent when duplicate: the original event's seq isn't re-derived on a replay.
export interface RecordScoreResponse {
  readonly seq?: number;
  readonly duplicate: boolean;
}

export interface FinalizeRoundResponse {
  readonly results: readonly GameResult[];
  readonly handicapping: RoundArchive["handicapping"];
}

export interface EventsResponse {
  readonly events: readonly RoundEvent[];
  readonly nextSeq: number;
}

export const startRoundResponseSchema: z.ZodType<StartRoundResponse> = z.object({
  roundId: roundIdSchema,
  joinCode: z.string(),
  token: z.string(),
  golferId: golferIdSchema,
});

export const joinRoundResponseSchema: z.ZodType<JoinRoundResponse> = z.object({
  roundId: roundIdSchema,
  token: z.string(),
  golferId: golferIdSchema,
});

export const addGameResponseSchema: z.ZodType<AddGameResponse> = z.object({
  gameId: gameIdSchema,
  seq: z.number().int(),
});

export const recordScoreResponseSchema: z.ZodType<RecordScoreResponse> = z.object({
  seq: z.number().int().optional(),
  duplicate: z.boolean(),
});

// Mirrors RoundArchive["handicapping"]'s element union exactly (domain/round/archive.ts).
const handicappingEntrySchema = z.discriminatedUnion("kind", [
  z.object({ golferId: golferIdSchema, kind: z.literal("complete"), ags: z.number(), differential: z.number() }),
  z.object({ golferId: golferIdSchema, kind: z.literal("incomplete") }),
]);

export const finalizeRoundResponseSchema: z.ZodType<FinalizeRoundResponse> = z.object({
  results: z.array(gameResultSchema).readonly(),
  handicapping: z.array(handicappingEntrySchema).readonly(),
});

export const eventsResponseSchema: z.ZodType<EventsResponse> = z.object({
  events: z.array(roundEventSchema).readonly(),
  nextSeq: z.number().int(),
});

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});
