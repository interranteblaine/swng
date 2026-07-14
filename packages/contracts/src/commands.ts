import { z } from "zod";
import type { GameId, GameResult, GolferId, RoundArchive, RoundEvent, RoundId } from "@swng/domain";
import { gameIdSchema, golferIdSchema, hlcSchema, opIdSchema, roundIdSchema } from "./ids.js";
import { courseCardSchema, gameConfigFields, gameResultSchema, holeResultSchema, roundEventSchema } from "./round.js";

// gameConfigFields' five field sets, minus `id` (they never had one — id-ness is
// GameConfig's addition, applied in round.ts) — the server assigns the id on the
// authoritative game-added event, so a client never gets to propose one. `.strict()`
// on every member makes "carries an id" a rejection, not a silently-dropped extra key.
const strokePlayConfigInputSchema = z.object({ kind: z.literal("stroke-play"), ...gameConfigFields["stroke-play"] }).strict();

const singlesMatchConfigInputSchema = z.object({ kind: z.literal("singles-match"), ...gameConfigFields["singles-match"] }).strict();

const stablefordConfigInputSchema = z.object({ kind: z.literal("stableford"), ...gameConfigFields.stableford }).strict();

const fourballMatchConfigInputSchema = z.object({ kind: z.literal("fourball-match"), ...gameConfigFields["fourball-match"] }).strict();

const skinsConfigInputSchema = z.object({ kind: z.literal("skins"), ...gameConfigFields.skins }).strict();

export const gameConfigInputSchema = z.discriminatedUnion("kind", [
  strokePlayConfigInputSchema,
  singlesMatchConfigInputSchema,
  stablefordConfigInputSchema,
  fourballMatchConfigInputSchema,
  skinsConfigInputSchema,
]);
export type GameConfigInput = z.infer<typeof gameConfigInputSchema>;

// Accounts-only identity (spec §3): StartRound seats its creator ONLY, always as-self from the
// caller's Bearer (application/src/golfers/ensureGolfer.ts resolves the account golfer by sub).
// No `host.name` — the participant name is the golfer record's name at start time, frozen into
// the event (sealed leaf; a later rename never rewrites the card). No `golferId` (the seat is
// always the caller's own), no `players[]` roster seeding (nobody puts anyone on a card — the
// join link is the one way onto it). This object is NOT `.strict()`, so an OLD client still
// sending host.name / golferId / players / crewId isn't rejected — Zod's default strips the
// unknown keys silently.
export const startRoundRequestSchema = z.object({
  card: courseCardSchema,
  host: z.object({
    tee: z.string().min(1),
    courseHandicap: z.number().int(), // may be negative (plus handicap)
  }),
});
export type StartRoundRequest = z.infer<typeof startRoundRequestSchema>;

// Accounts-only identity (spec §3): JoinRound is always as-self from the caller's Bearer — no
// `name` (frozen from the golfer record at join time, sealed leaf) and no `golferId` (the seat
// is always the caller's own, resolved via ensureGolfer). NOT `.strict()`, so an old client
// still sending name / golferId strips silently rather than being rejected.
export const joinRoundRequestSchema = z.object({
  code: z.string().length(6),
  tee: z.string().min(1),
  courseHandicap: z.number().int(),
});
export type JoinRoundRequest = z.infer<typeof joinRoundRequestSchema>;

export const addGameRequestSchema = z.object({
  game: gameConfigInputSchema,
});
export type AddGameRequest = z.infer<typeof addGameRequestSchema>;

export const recordScoreRequestSchema = z.object({
  golferId: golferIdSchema,
  hole: z.number().int().min(1),
  result: holeResultSchema,
  opId: opIdSchema,
  hlc: hlcSchema,
});
export type RecordScoreRequest = z.infer<typeof recordScoreRequestSchema>;

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

// POST /rounds/{roundId}/abandon (task-15): a scrapped round produces no snapshot and counts
// nowhere. `status` is the literal "abandoned", not the full RoundStatus union — this endpoint
// only ever yields that one terminal state on success (a non-abandonable round, e.g. one already
// final, is a 409, never a 200 carrying a different status).
export interface AbandonRoundResponse {
  readonly status: "abandoned";
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

export const abandonRoundResponseSchema: z.ZodType<AbandonRoundResponse> = z.object({
  status: z.literal("abandoned"),
});

export const eventsResponseSchema: z.ZodType<EventsResponse> = z.object({
  events: z.array(roundEventSchema).readonly(),
  nextSeq: z.number().int(),
});

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});
