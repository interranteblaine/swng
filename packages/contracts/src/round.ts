import { z } from "zod";
import type { CourseCard, GameConfig, GameResult, HoleResult, Participant, RoundEvent } from "@swng/domain";
import { cardIdSchema, courseIdSchema, gameIdSchema, golferIdSchema, hlcSchema, opIdSchema, roundIdSchema, teeIdSchema } from "./ids.js";

// Wire mirrors of domain types. These stay structural (loose numeric bounds where the
// domain type itself doesn't declare one) — the source of truth for "is this score
// legal" is domain/M6's course-data validation, not the transport layer; the request
// schemas in commands.ts own the stricter boundary checks (courseHandicap int, hole >= 1, …).
export const holeResultSchema: z.ZodType<HoleResult> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("strokes"), strokes: z.number() }),
  z.object({ kind: z.literal("picked-up") }),
  z.object({ kind: z.literal("conceded") }),
]);

// Exported (course-cards spec): courses.ts' tee-input payloads reuse the one hole shape rather
// than re-declaring it — the wire mirror of domain's Hole, defined once.
export const holeSchema = z.object({
  number: z.number().int(),
  par: z.number().int(),
  yardage: z.number().int(),
  strokeIndex: z.number().int(),
});

// Exported for reuse wherever a wire tee set is needed outside a CourseCard (courses.ts'
// tee-input payloads) — the one wire mirror of domain's TeeSet, not duplicated per caller.
// `teeId` is optional (course-cards spec §3): pre-scrap stored events/fixtures carry no id;
// every stored/newly-frozen card's tees do (buildCardRecord's invariant). `rating`/`slope` are
// optional AS A PAIR (unrated-courses spec §1) — domain's validateTeeSet enforces the pairing
// and bounds; the wire schema stays structural.
export const teeSetSchema = z.object({
  teeId: teeIdSchema.optional(),
  name: z.string(),
  rating: z.number().optional(),
  slope: z.number().optional(),
  holes: z.array(holeSchema).readonly(),
});

export const courseCardSchema: z.ZodType<CourseCard> = z.object({
  courseName: z.string(),
  // Which course record + exact card this value was frozen from (course-cards spec §2) —
  // optional, same pre-scrap-tolerant split as teeSetSchema's teeId above.
  source: z.object({ cardId: cardIdSchema, courseId: courseIdSchema }).optional(),
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
  // Round-is-a-sealed-leaf: round-created carries only the round's own facts (id + frozen
  // card), never a crew reference. This object is NOT `.strict()`, so an old stored event
  // from the M8 era that still carries a `crewId` key parses fine — Zod's default strips the
  // unknown key rather than rejecting it (event schema is append-only; tolerate old data).
  z.object({ ...envelope, kind: z.literal("round-created"), roundId: roundIdSchema, card: courseCardSchema }),
  z.object({ ...envelope, kind: z.literal("participant-joined"), participant: participantSchema }),
  z.object({ ...envelope, kind: z.literal("game-added"), config: gameConfigSchemaImpl }),
  z.object({ ...envelope, kind: z.literal("round-started") }),
  z.object({ ...envelope, kind: z.literal("score-recorded"), golferId: golferIdSchema, hole: z.number(), result: holeResultSchema }),
  z.object({ ...envelope, kind: z.literal("round-finalized") }),
  z.object({ ...envelope, kind: z.literal("round-reopened") }),
  // task-15: a round scrapped for good — terminal, envelope-only, mirroring round-finalized's
  // shape. Additive (append-only event schema); an old client that never sends it is unaffected.
  z.object({ ...envelope, kind: z.literal("round-abandoned") }),
  z.object({ ...envelope, kind: z.literal("game-terminated"), gameId: gameIdSchema }),
  // accounts-only identity spec §4: a participant walks off. Additive/append-only, like every
  // arm above. `golferId` is the SUBJECT (who left); `authorId` (envelope) is who recorded it.
  z.object({ ...envelope, kind: z.literal("participant-left"), golferId: golferIdSchema }),
]);
export const roundEventSchema: z.ZodType<RoundEvent> = roundEventSchemaImpl;

const runningTotalSchema = z.object({ total: z.number(), pickups: z.number() });

const strokePlayLineSchema = z.object({
  golferId: golferIdSchema,
  thru: z.number(),
  gross: runningTotalSchema,
  net: runningTotalSchema.optional(),
  relativeToPar: z.number(),
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

// POST /rounds/{roundId}/games/{gameId}/terminate has no request body (path params only —
// the M7 plan's Task 2 brief). Response mirrors recordScore's append idiom (commands.ts):
// `events` carries only what THIS call actually appended, seq-stamped — the idempotent
// no-op path (terminating an already-terminated game) appends nothing, so it returns [],
// never a synthesized "as if" event.
export interface TerminateGameResponse {
  readonly events: readonly RoundEvent[];
}

export const terminateGameResponseSchema: z.ZodType<TerminateGameResponse> = z.object({
  events: z.array(roundEventSchema).readonly(),
});

// POST /rounds/{roundId}/leave (accounts-only identity spec §4): no request body — the leaver is
// the participant token's OWN golferId (leaving is self-only by construction). Response mirrors
// terminateGame's append idiom: `events` carries exactly what THIS call appended (the one
// participant-left), seq-stamped. NOT deduped the way terminate's idempotent no-op is — leaving
// twice appends twice (two events, same fold result: the golfer is departed either way), so a
// repeat leave still returns its freshly-appended event, never [].
export interface LeaveRoundResponse {
  readonly events: readonly RoundEvent[];
}

export const leaveRoundResponseSchema: z.ZodType<LeaveRoundResponse> = z.object({
  events: z.array(roundEventSchema).readonly(),
});

// POST /rounds/{roundId}/share (M9 Task 3): `url` is deterministic (same round -> the same
// byte-identical spectator token, hence the same url) and is a PATH+FRAGMENT, not an absolute
// URL — getShareLink.ts has no web-origin config seam to build one from, so the web app
// prefixes its own origin (ShareButton.tsx) rather than the server guessing at a deployment's
// public hostname.
export interface ShareLinkResponse {
  readonly url: string;
}

export const shareLinkResponseSchema: z.ZodType<ShareLinkResponse> = z.object({
  url: z.string(),
});

// GET /rounds/{roundId}/archive (projection-realignment Task 6): the settled snapshot's own
// event log, verbatim — the SAME shape family as EventsResponse (commands.ts), but deliberately
// its own type rather than a reuse: EventsResponse carries `nextSeq` (a live-log catch-up
// cursor), which a frozen archive has no use for — a caller folding this via the domain
// `reduceRound` needs only `events` (apps/web's ArchivedRoundPage mirrors WatchPage's own
// fold-then-ResultsView composition).
export interface GetRoundArchiveResponse {
  readonly events: readonly RoundEvent[];
}

export const getRoundArchiveResponseSchema: z.ZodType<GetRoundArchiveResponse> = z.object({
  events: z.array(roundEventSchema).readonly(),
});
