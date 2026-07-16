import { z } from "zod";
import type { CourseId, GolferId, GolferRoundLine, RoundId } from "@swng/domain";
import { courseIdSchema, golferIdSchema, roundIdSchema } from "./ids.js";

// The wire projection of a Golfer aggregate (application/src/golfers/golferView.ts builds
// it): the ONE handicap number a golfer sets on themselves — `declared` (unrated-courses
// spec §6 collapsed the old three-number model to two, folding the self-maintained `official`
// into `declared`) — NOT `computed` or an `effective` precedence field. The server has no
// persisted computed index on the golfer item itself (it's a read-time metric on the separate
// record response, application/src/golfers/getMyRecord.ts's metrics.whsIndex), so a
// server-side `effectiveIndex` call here would be silently WRONG whenever a real computed index
// existed. The web composes the true effective index client-side from GET /me (declared) + GET
// /me/record (metrics.whsIndex), via domain's own effectiveIndex — see apps/web/src/routes/
// ProfilePage.tsx.
export interface GolferView {
  readonly golferId: GolferId;
  readonly name: string;
  readonly homeCourseId?: CourseId;
  readonly declared?: number;
  // accounts-only identity spec §2: true iff `name` is the deterministic sub-derived backstop a
  // get-or-create mint used (placeholderName(sub)), not a name the golfer chose — the web prompts
  // for a real one while it's true. Absent means false (old golfers never carry it; a PUT /me with
  // a real name drops it): omitted rather than sent `false`, matching the spread idiom below.
  readonly namePlaceholder?: boolean;
}

export const golferViewSchema: z.ZodType<GolferView> = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  homeCourseId: courseIdSchema.optional(),
  declared: z.number().optional(),
  namePlaceholder: z.boolean().optional(),
});

// Accounts-only identity (spec §2): GET /me ENSURES the caller's golfer (application/src/golfers/
// getMyGolfer.ts's ensureGolfer — get-or-create on first touch, minting a placeholder-named row
// bound to the sub when none exists yet), and PUT /me updates it. The `golfer` field is therefore
// never null in practice, but the type stays nullable — it's the shared wire shape, and tightening
// it isn't this task's concern.
export interface GetMeResponse {
  readonly golfer: GolferView | null;
}
export const getMeResponseSchema: z.ZodType<GetMeResponse> = z.object({ golfer: golferViewSchema.nullable() });

// PUT /me always resolves to a real golfer (a create-or-act path, never a "does this exist"
// read) — a distinct, non-nullable response shape from GetMeResponse so callers of
// updateMyGolfer don't inherit GET /me's null case.
export interface GolferResponse {
  readonly golfer: GolferView;
}
export const golferResponseSchema: z.ZodType<GolferResponse> = z.object({ golfer: golferViewSchema });

// Every field optional — a partial patch (PATCH-like semantics: an absent key leaves the
// stored value untouched; there is no way to CLEAR a set field in v1). `.strict()` like
// courses.ts's request bodies: a client proposing golferId/computed (server-derived, never
// client-set) is a rejection, not a silently-dropped extra key. `declared` is the golfer's own
// self-maintained index (unrated-courses spec §6 — the old `official` folded into it): a golfer
// typing their own index here IS the manual maintenance, no separate verification flow.
export const updateMeRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    homeCourseId: courseIdSchema.optional(),
    declared: z.number().optional(),
  })
  .strict();
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

// The wire mirror of domain's GolferRoundLine (golfer/record.ts) — structurally identical,
// same as round.ts's participantSchema mirroring Participant. Field object, not just the
// finished schema, so GetMyRoundsResponse below can extend it with `finalizedAt` (same
// "shared fields object" idiom as round.ts's gameConfigFields) rather than duplicating five
// field declarations a second time.
const golferRoundLineFields = {
  roundId: roundIdSchema,
  courseName: z.string(),
  courseId: courseIdSchema.optional(),
  tee: z.string(),
  holes: z.union([z.literal(9), z.literal(18)]),
  par: z.number(),
  courseHandicap: z.number(),
  ags: z.number().optional(),
  differential: z.number().optional(),
  distribution: z.object({
    eagles: z.number().int(),
    birdies: z.number().int(),
    pars: z.number().int(),
    bogeys: z.number().int(),
    doublePlus: z.number().int(),
  }),
} as const;

const golferRoundLineSchema: z.ZodType<GolferRoundLine> = z.object(golferRoundLineFields);

// The metrics read projection (unrated-courses spec §6, domain/golfer/metrics.ts's golferMetrics):
// every derived index in one place, computed at read time (never stored). REQUIRED object, its two
// members optional — an empty `{}` is the honest answer for a golfer with no postable rounds.
// `whsIndex` is Rule 5.2a over rated differentials (with getMyRecord's read-time `computedAtMs`
// stamp); `suggestedIndex` is the neutral-course `ags − par` estimate (a declaration aid, no stamp).
// differentialsUsed on each is Rule 5.2a's `use` count (domain's computeIndexDetail, whs.ts) — how
// many differentials were actually averaged, not how many were in the window.
export interface GetMyRecordResponse {
  readonly metrics: {
    readonly whsIndex?: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };
    readonly suggestedIndex?: { readonly value: number; readonly differentialsUsed: number };
  };
  readonly history: readonly GolferRoundLine[]; // newest first (application/src/golfers/getMyRecord.ts)
}

export const getMyRecordResponseSchema: z.ZodType<GetMyRecordResponse> = z.object({
  metrics: z.object({
    whsIndex: z.object({ value: z.number(), computedAtMs: z.number().int(), differentialsUsed: z.number().int() }).optional(),
    suggestedIndex: z.object({ value: z.number(), differentialsUsed: z.number().int() }).optional(),
  }),
  history: z.array(golferRoundLineSchema).readonly(),
});

// GET /me/rounds (projection-realignment Task 6): "list my rounds" — every finalized round
// the caller played, newest first (application/src/golfers/getMyRounds.ts, the SAME sortLines-
// then-reverse discipline getMyRecord's own `history` already uses). Each entry is a
// GolferRoundLine PLUS `finalizedAt` (the wire name for the projection store's own internal
// `finalizedAtMs`) — the one piece a "my rounds" list needs that the index/trend-focused
// GetMyRecordResponse never had to expose: WHEN each round was played, not just what it says
// about the index.
// `createdAt` (accounts-only identity spec §5, the derived "course + date" designation) is the
// round-created event's own wall time — added here alongside `finalizedAt` because the web renders
// each round as "Casa Verde GC · Sat, Jul 12" from course name + created-at, identically across the
// home list, the archive, and the join link. OPTIONAL: old projection lines (written before this
// task) carry no created-at, tolerated on read as absent — a rebuild backfills it, never a
// migration.
export interface GetMyRoundsResponse {
  readonly rounds: readonly (GolferRoundLine & { readonly finalizedAt: number; readonly createdAt?: number })[];
}

export const getMyRoundsResponseSchema: z.ZodType<GetMyRoundsResponse> = z.object({
  rounds: z.array(z.object({ ...golferRoundLineFields, finalizedAt: z.number().int(), createdAt: z.number().int().optional() })).readonly(),
});

// GET /me/rounds/live (projection-realignment Task 13): "your rounds, right now" — presence
// pointers (application/src/rounds/presence.ts's writePresence, written at seat-time by
// startRound/joinRound and removed at finalize by projections/
// projectArchive.ts's deleteLive loop), a DIFFERENT surface from GetMyRoundsResponse above
// (that one is finalized-round HISTORY). `joinedAt` is the wire name for the projection
// store's own `joinedAtMs` (same rename discipline as GetMyRoundsResponse's `finalizedAt`).
// Sorted newest-joined first (application/src/golfers/getMyLiveRounds.ts).
// `createdAt` (accounts-only identity spec §5, the derived "course + date" designation): the
// round-created event's own wall time, so the home list can render a live round the SAME way the
// archive/join-link render it ("Casa Verde GC · Sat, Jul 12") — a round-level fact, unlike the
// per-golfer `joinedAt`. OPTIONAL: best-effort at read time (getMyLiveRounds derives it from the
// round's genesis), omitted if that lookup can't resolve it.
export interface GetMyLiveRoundsResponse {
  readonly rounds: readonly { readonly roundId: RoundId; readonly courseName: string; readonly joinedAt: number; readonly createdAt?: number }[];
}

export const getMyLiveRoundsResponseSchema: z.ZodType<GetMyLiveRoundsResponse> = z.object({
  rounds: z.array(z.object({ roundId: roundIdSchema, courseName: z.string(), joinedAt: z.number().int(), createdAt: z.number().int().optional() })).readonly(),
});
