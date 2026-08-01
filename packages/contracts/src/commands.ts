import { z } from "zod";
import type { GameId, GameResult, GolferId, HoleResult, RoundEvent, RoundId } from "@swng/domain";
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

// Same override split as the `players` bounds above, for the other direction: skins' `scoring` is
// `.default("net")` on the shared field set so a legacy STORED game-added event (written before the
// field existed) still parses on the client's read path, and REQUIRED here so a client proposing a
// new skins game has to say which pot it is rather than silently getting net.
const skinsConfigInputSchema = z
  .object({
    kind: z.literal("skins"),
    ...gameConfigFields.skins,
    scoring: z.enum(["gross", "net"]),
    players: gameConfigFields.skins.players.max(12),
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

// The ceiling on a stroke count, shared so the wire and the roster editor can never drift apart:
// `strokesInputSchema` below bounds the request with it, and apps/web's SetupPanel bounds its own
// input, its Save-enabled predicate AND the sentence it shows when Save is off with the SAME
// constant. Two independent literals is exactly how a control comes to accept a number the wire
// always rejects.
//
// 100 — the value Arc A (2026-07-23) already ratified for this class of bound when it widened
// `courseHandicap` from `[-10,54]` on the finding that 54 rejects legitimate play, "exactly the
// anti-pattern the arc's own placement rule forbids." A typed stroke count is a raw DIFFERENCE
// between two players (spec 2026-07-30 §2/§3), so nothing caps it at a course handicap: a beginner
// who shoots +58 playing off a scratch anchor is a real pairing that 54 refuses outright. This is a
// nonsense filter — 100 is more than five shots a hole over eighteen — never a statement about how
// many strokes a group is allowed to give.
export const MAX_STROKES = 100;

// A player's strokes at the REQUEST ingress (spec 2026-07-30 §2). `setStrokesRequestSchema` is its
// ONE consumer — start and join ask nothing about anyone's game (spec §9), so there is no other
// command that takes a number. Request ingress ONLY: the stored `participant-joined` and
// `participant-strokes-set` arms in round.ts stay unbounded, per Arc A's placement rule (a bound on
// a stored/fold schema rejects already-stored data on a read path), the same input/stored split
// `gameConfigInputSchema` and `scoreResultInputSchema` already follow.
//
// This is therefore the SOLE enforcement point of the non-negative invariant — the old
// `resolveStrokes` clamp went with the derivation. That is the correct placement, not a gap: the
// alternative bounds a read path, which bricks a legitimate round on data already written. The
// render site degrades instead of trusting (ScorecardGrid's dot span).
//
// NOT signed: nobody gives strokes back, so min(0) makes a negative unrepresentable at the wire.
// MAX_STROKES is a plausibility limit with real margin (see its own comment above), there to reject
// nonsense rather than a real player — a bound that refuses a pairing somebody actually plays is
// worse than no bound at all.
export const strokesInputSchema = z.number().int().min(0).max(MAX_STROKES);

// Typo protection on a user-typed instant, NOT a product limit (spec 2026-08-01 §6). Request
// schemas only — the stored round-created arm carries no bound at all, because a bound on a
// stored/fold path rejects already-stored data on a read (pre-prod hardening Arc A's placement
// rule). Future dates ARE allowed: setting up Saturday's round on Thursday is the same round
// entered early instead of late.
const MIN_PLAYED_AT_MS = Date.UTC(2000, 0, 1);
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1_000;
export const playedAtInputSchema = z
  .number()
  .int()
  .min(MIN_PLAYED_AT_MS)
  .refine((ms) => ms <= Date.now() + TWO_YEARS_MS, { message: "playedAtMs is too far in the future" });

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
  // Just a tee (spec 2026-07-30 §9): the creator's strokes start at 0 like everyone else's, and
  // are typed onto the roster when the group settles them on the first tee.
  host: z.object({
    // task-1 (pre-prod hardening): a tee name is a short label, never a paragraph.
    tee: z.string().min(1).max(40),
  }),
  // spec 2026-08-01 §3a: absent means now — exactly today's behaviour. A golfer entering
  // Friday's paper card on Sunday types Friday's date here instead; the application layer is
  // where "absent" becomes "now" (a later task), so the wire itself just needs to allow the gap.
  playedAtMs: playedAtInputSchema.optional(),
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
  // Just a tee (spec 2026-07-30 §9): joining asks no question about your game.
  tee: z.string().min(1).max(40),
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
  // .int(): a fractional stroke count is nonsense on a scorecard.
  z.object({ kind: z.literal("strokes"), strokes: z.number().int().min(1).max(30) }),
  z.object({ kind: z.literal("picked-up") }),
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

// POST /rounds/{roundId}/strokes (spec 2026-07-30 §2): any participant sets any participant's
// strokes — the score-for-anyone trust model, so the SUBJECT rides the body while the author is
// the token's own golferId. The server mints the envelope (like join/leave), and the change is
// retroactive by construction: nothing snapshots strokes, so the card's dots and every standing
// move on the next read.
export const setStrokesRequestSchema = z.object({
  golferId: golferIdSchema,
  strokes: strokesInputSchema,
});
export type SetStrokesRequest = z.infer<typeof setStrokesRequestSchema>;

// POST /rounds/{roundId}/played-at (spec 2026-08-01 §3b): any participant corrects the round's
// played date — a round-level fact, so there is no subject in the body. Server-minted envelope,
// like join/leave/strokes.
export const setPlayedAtRequestSchema = z.object({ playedAtMs: playedAtInputSchema });
export type SetPlayedAtRequest = z.infer<typeof setPlayedAtRequestSchema>;

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

// `handicapping` (per-participant adjusted gross score + differential) is DELETED with the whole
// WHS pipeline (spec 2026-07-29 §7), here and on RoundArchive itself. The finished round's numbers
// are the card's own totals, which the results view computes from the cells it already renders.
export interface FinalizeRoundResponse {
  readonly results: readonly GameResult[];
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

export const finalizeRoundResponseSchema: z.ZodType<FinalizeRoundResponse> = z.object({
  results: z.array(gameResultSchema).readonly(),
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
