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

// M8: an initial roster entry beyond the host — StartRound's `players` field appends these
// as participant-joined events, in order, right after the host's own join (the crew
// one-tap flow: seed a round with the whole crew in one call instead of N separate joins).
const startRoundPlayerSchema = z.object({
  name: z.string().min(1),
  tee: z.string().min(1),
  courseHandicap: z.number().int(),
  golferId: golferIdSchema.optional(),
});

export const startRoundRequestSchema = z.object({
  card: courseCardSchema,
  host: z.object({
    name: z.string().min(1),
    tee: z.string().min(1),
    courseHandicap: z.number().int(), // may be negative (plus handicap)
  }),
  // M8 "as-self create": the host's own existing golferId, subject to the SAME claimed-
  // golferId rule as JoinRound's golferId (application/src/rounds/golferIdentity.ts) — a
  // signed-in golfer can start a round playing as themselves instead of a fresh ghost.
  golferId: golferIdSchema.optional(),
  // No crewId: round-is-a-sealed-leaf, so a round never tags itself with a crew. This object
  // is NOT `.strict()`, so an old client still sending `crewId` isn't rejected — Zod's default
  // strips the unknown key. Consent to seat a claimed fellow golfer now flows from
  // co-membership (the resolver derives it from the caller's own crews — golferIdentity.ts),
  // not from a tag on the round.
  // Capped well below DynamoDB's own hard limit: StartRound's whole event batch (round-
  // created + host-joined + round-started + one participant-joined per player) rides ONE
  // createDynamoEventJournal transaction, and DynamoDB caps a single TransactWriteItems call
  // at 100 items — 2 items per event (EVT Put + its OPID dedup Put), so more than 50 events
  // fails with a ValidationException (that adapter's own append() comment). 40 players is
  // 43 events = 86 items, comfortably clear of the cap while still far beyond any realistic
  // roster — an honest 400 here beats a 500 surfaced from deep inside the transaction.
  players: z.array(startRoundPlayerSchema).max(40).optional(),
});
export type StartRoundRequest = z.infer<typeof startRoundRequestSchema>;

export const joinRoundRequestSchema = z.object({
  code: z.string().length(6),
  name: z.string().min(1),
  tee: z.string().min(1),
  courseHandicap: z.number().int(),
  // Task 5b (ghost continuity): a joiner may present an existing GolferId so the SAME ghost
  // recurs across rounds. application's joinRound.ts is the enforcement point (reuse allowed
  // IFF the golfer is unclaimed) — this schema only shapes the wire, it doesn't authorize.
  golferId: golferIdSchema.optional(),
});
export type JoinRoundRequest = z.infer<typeof joinRoundRequestSchema>;

// POST /rounds/{roundId}/players (participant auth, M8): an already-seated participant adds
// someone else to the roster — the crew one-tap flow's mid-round counterpart to StartRound's
// own `players` array. Same shape as JoinRound's own fields (minus `code`: the round is
// already known from the participant token) plus the same optional golferId, resolved by
// the SAME shared resolver (golferIdentity.ts).
export const addParticipantRequestSchema = z.object({
  name: z.string().min(1),
  tee: z.string().min(1),
  courseHandicap: z.number().int(),
  golferId: golferIdSchema.optional(),
});
export type AddParticipantRequest = z.infer<typeof addParticipantRequestSchema>;

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

// Mirrors round.ts' terminateGameResponseSchema: only the events THIS call actually
// appended, seq-stamped — never a synthesized "as if" event.
export interface AddParticipantResponse {
  readonly events: readonly RoundEvent[];
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

export const addParticipantResponseSchema: z.ZodType<AddParticipantResponse> = z.object({
  events: z.array(roundEventSchema).readonly(),
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
