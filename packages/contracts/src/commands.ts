import { z } from "zod";
import type { GameId, GameResult, GolferId, HoleResult, RoundArchive, RoundEvent, RoundId } from "@swng/domain";
import { cardIdSchema, courseIdSchema, gameIdSchema, golferIdSchema, hlcSchema, opIdSchema, roundIdSchema } from "./ids.js";
import { gameConfigFields, gameResultSchema, roundEventSchema } from "./round.js";

// gameConfigFields' five field sets, minus `id` (they never had one — id-ness is
// GameConfig's addition, applied in round.ts) — the server assigns the id on the
// authoritative game-added event, so a client never gets to propose one. `.strict()`
// on every member makes "carries an id" a rejection, not a silently-dropped extra key.
//
// task-1 (pre-prod hardening, placement rule): the three `players` arrays below get a
// request-ingress-only `.max(12)` bound, applied by OVERRIDING the spread field rather than
// touching gameConfigFields itself — that shared object also builds round.ts's stored
// `*ConfigSchema`s, which back roundEventSchema's game-added arm (a read/fold path parsing
// already-stored events). Bounding the shared schema would reject a legitimately-large game
// already on file; overriding only here keeps the bound on the wire ingress alone.
const strokePlayConfigInputSchema = z
  .object({ kind: z.literal("stroke-play"), ...gameConfigFields["stroke-play"], players: gameConfigFields["stroke-play"].players.max(12) })
  .strict();

const singlesMatchConfigInputSchema = z.object({ kind: z.literal("singles-match"), ...gameConfigFields["singles-match"] }).strict();

const stablefordConfigInputSchema = z
  .object({ kind: z.literal("stableford"), ...gameConfigFields.stableford, players: gameConfigFields.stableford.players.max(12) })
  .strict();

const fourballMatchConfigInputSchema = z.object({ kind: z.literal("fourball-match"), ...gameConfigFields["fourball-match"] }).strict();

const skinsConfigInputSchema = z.object({ kind: z.literal("skins"), ...gameConfigFields.skins, players: gameConfigFields.skins.players.max(12) }).strict();

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
// Course-cards spec §4: a REFERENCE, never a card — the server resolves and freezes the
// lineage's current card itself (spec invariant 4/5: the client can never author a card; the
// old `card:` shape is gone, not tolerated — an old client gets 400 invalid-request).
export const startRoundRequestSchema = z.object({
  course: z.object({ courseId: courseIdSchema, cardId: cardIdSchema }),
  host: z.object({
    // task-1 (pre-prod hardening): a tee name is a short label, never a paragraph.
    tee: z.string().min(1).max(40),
    // Widened from the original [-10, 54] (pre-prod hardening fix wave, post-review): that range
    // rejected LEGITIMATE WHS values. Course Handicap = round(Index × Slope/113 + (Rating − Par))
    // [WHS Rule 6.1a] — a max index (54.0) on a max slope (155) alone computes ≈74 before the
    // rating term, and a hard/long course's (Rating − Par) can push a max-handicap player's course
    // handicap toward 100; symmetrically, an extreme plus player (index ≈ −9, the best humans) can
    // compute below −10. [-20, 100] is a plausibility bound with margin on both ends, not a WHS
    // hard limit — it exists only to reject nonsense input, never a real player.
    courseHandicap: z.number().int().min(-20).max(100),
  }),
});
export type StartRoundRequest = z.infer<typeof startRoundRequestSchema>;

// Accounts-only identity (spec §3): JoinRound is always as-self from the caller's Bearer — no
// `name` (frozen from the golfer record at join time, sealed leaf) and no `golferId` (the seat
// is always the caller's own, resolved via ensureGolfer). NOT `.strict()`, so an old client
// still sending name / golferId strips silently rather than being rejected.
export const joinRoundRequestSchema = z.object({
  // task-1 (pre-prod hardening): the join-code alphabet excludes visually-ambiguous characters
  // (0/O/1/I/L) — mirrors compositionRoot.ts's JOIN_CODE_ALPHABET, the real minting alphabet.
  code: z.string().length(6).regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/),
  tee: z.string().min(1).max(40),
  // [-20, 100] — see startRoundRequestSchema's own comment above for the WHS 6.1a derivation.
  courseHandicap: z.number().int().min(-20).max(100),
});
export type JoinRoundRequest = z.infer<typeof joinRoundRequestSchema>;

export const addGameRequestSchema = z.object({
  game: gameConfigInputSchema,
});
export type AddGameRequest = z.infer<typeof addGameRequestSchema>;

// task-1 (pre-prod hardening, placement rule): round.ts's holeResultSchema also backs
// roundEventSchema's stored/fold arm (the score-recorded event, parsed by EventsResponse /
// GetRoundArchiveResponse — read paths) — bounding it there would reject an already-stored
// strokes count. This is the request-ingress-only copy, structurally identical except for the
// bound: 30 comfortably covers any realistic single-hole count (incl. a very bad par-3) without
// letting a client stuff an unbounded number into the log.
// Fix wave (post-review): anchored to the domain HoleResult union so a wrong-shaped or extra arm
// fails to typecheck HERE rather than silently drifting from the domain type it bounds. Built as
// an UNANNOTATED literal first (`scoreResultInputArms`) — annotating this declaration directly as
// `z.ZodType<HoleResult>` would make `typeof` resolve to that wider annotated type everywhere it's
// referenced, which erases the narrower literal-kind union the exhaustiveness check below needs
// (verified empirically, TS 5.9.3 + zod 4.4.3: with the annotation inline, z.infer<typeof
// scoreResultInputSchema>["kind"] is always the full HoleResult["kind"], even with an arm missing
// — the check would be vacuous). `scoreResultInputSchema` below re-applies the annotation on a
// separate binding, so callers still get the z.ZodType<HoleResult> field-shape/extra-arm guarantee.
const scoreResultInputArms = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("strokes"), strokes: z.number().min(1).max(30) }),
  z.object({ kind: z.literal("picked-up") }),
  z.object({ kind: z.literal("conceded") }),
  z.object({ kind: z.literal("cleared") }),
]);

// Compile-time exhaustiveness: every HoleResult kind must have a request arm above. If the domain
// HoleResult union grows a kind (or an arm is dropped here), this fails to typecheck until the arms
// match — the request schema can't silently fall behind the domain type. Wrapped in one-tuples
// ([...] extends [...]) to force a non-distributive check: a naked `A extends B` distributes over
// a union A, so a single missing member's `never` branch just vanishes from the resulting union
// instead of poisoning the whole check (verified empirically — the naked form let a missing arm
// through silently; caught only by then testing the RED case, not by reading the type alone).
type _RequestCoversEveryHoleResultKind =
  [HoleResult["kind"]] extends [z.infer<typeof scoreResultInputArms>["kind"]] ? true : never;
export const _scoreResultExhaustive: _RequestCoversEveryHoleResultKind = true;

const scoreResultInputSchema: z.ZodType<HoleResult> = scoreResultInputArms;

export const recordScoreRequestSchema = z.object({
  golferId: golferIdSchema,
  // task-1: a round has at most 18 holes.
  hole: z.number().int().min(1).max(18),
  result: scoreResultInputSchema,
  opId: opIdSchema,
  hlc: hlcSchema,
});
export type RecordScoreRequest = z.infer<typeof recordScoreRequestSchema>;

// POST /rounds/{roundId}/handicap (spec 2026-07-20): any participant corrects any participant —
// the score-for-anyone trust model, so the SUBJECT rides the body while the author is the
// token's own golferId. The server minds the envelope (server-minted, like join/leave); the
// value may be negative (plus handicap), and the correction is retroactive by construction.
export const setHandicapRequestSchema = z.object({
  golferId: golferIdSchema,
  // [-20, 100] — see startRoundRequestSchema's own comment above for the WHS 6.1a derivation.
  courseHandicap: z.number().int().min(-20).max(100),
});
export type SetHandicapRequest = z.infer<typeof setHandicapRequestSchema>;

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
  // The round's join code — participant-scoped round metadata, delivered with the credential
  // (spec 2026-07-20 §2): holding a participant token means holding the code, on every door in
  // (join here, re-mint via POST /rounds/{roundId}/token; StartRoundResponse already carries it).
  readonly joinCode: string;
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
  joinCode: z.string(),
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
  z.object({ golferId: golferIdSchema, kind: z.literal("unrated"), ags: z.number() }),
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
