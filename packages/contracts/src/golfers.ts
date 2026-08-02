import { z } from "zod";
import type { CourseId, GolferBests, GolferId, GolferMetrics, GolferRoundLine, Milestone, RoundId } from "@swng/domain";
import { courseIdSchema, golferIdSchema, roundIdSchema } from "./ids.js";

// The wire projection of a Golfer aggregate (application/src/golfers/golferView.ts builds it).
// There is no index source and no asserted number here (spec 2026-07-29 §5): the profile is a
// reporting artifact with no inputs beyond name and home course. What a golfer shoots is
// `metrics.average` on the record responses below, computed on read from their own rounds; what
// they play off in a round is the strokes the group typed onto that round's roster.
export interface GolferView {
  readonly golferId: GolferId;
  readonly name: string;
  readonly homeCourseId?: CourseId;
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
// client-set) is a rejection, not a silently-dropped extra key. Name and home course are the
// WHOLE editable profile now (spec 2026-07-29 §5) — the `indexSource` field went with the index
// itself, and `.strict()` means an old bundle still sending one gets a clean 400 rather than a
// silent no-op.
export const updateMeRequestSchema = z
  .object({
    // task-1 (pre-prod hardening): a display name, never a paragraph.
    name: z.string().min(1).max(60).optional(),
    homeCourseId: courseIdSchema.optional(),
  })
  .strict();
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

// The wire mirror of domain's GolferRoundLine (golfer/record.ts) — structurally identical,
// same as round.ts's participantSchema mirroring Participant. Field object, not just a
// finished schema, so GetMyRecordResponse/GetGolferResponse/GetMyRoundsResponse below can each
// extend it with `finalizedAt`/`playedAt`/`createdAt` (same "shared fields object" idiom as
// round.ts's gameConfigFields) rather than duplicating the field declarations a second/third time.
const golferRoundLineFields = {
  roundId: roundIdSchema,
  courseName: z.string(),
  courseId: courseIdSchema.optional(),
  tee: z.string(),
  holes: z.union([z.literal(9), z.literal(18)]),
  par: z.number(),
  // The strokes this player played off (spec 2026-07-30 §2) and the round's own gross — present
  // iff every hole carried a number (`hasCompleteScore`). `score` is what a history row renders:
  // `holeResults` never crosses the wire, so without it a row would have no number at all.
  strokes: z.number(),
  score: z.number().optional(),
  distribution: z.object({
    eagles: z.number().int(),
    birdies: z.number().int(),
    pars: z.number().int(),
    bogeys: z.number().int(),
    doublePlus: z.number().int(),
  }),
} as const;

// The metrics read projection (spec 2026-07-29 §5, domain/golfer/metrics.ts's golferMetrics):
// every derived number in one place, computed at read time and never stored. REQUIRED object;
// `average` stays OPTIONAL — absent is the honest answer for a golfer with no round that carries a
// score (a card with a pickup has none), never a 0 and never a floor — and it is what they shoot
// relative to par over their last ten scored rounds. There is deliberately no
// `spread` on this response (controller ruling): spread is the crew board's own column, over the
// SEASON window (spec §6), and a rolling-10 spread here would be a second number under the same
// name with neither labelled by its window. `typicalEighteen` (career
// scoring buckets normalized to a per-18-hole rate) and `averageHistory` ("your average over
// time" — one point per CONTRIBUTING round, oldest → newest, the headline being exactly its last
// point) are REQUIRED, zeros/`[]` rather than absent. `bests`/`milestones` (analytics spec §3) are
// REQUIRED the same way, `{}`/`[]` rather than absent.
//
// Shared metrics sub-schemas — the domain `GolferMetrics` fold's own shape, reused verbatim by
// BOTH getMyRecordResponseSchema and getGolferResponseSchema, never redeclared. Nothing layers a
// read-time stamp on top anymore: the whsIndex `computedAtMs` that motivated the split is gone
// with the index itself, so both responses now serve the bare fold.
const scoringShapeSchema = z.object({
  eagles: z.number().int(),
  birdies: z.number().int(),
  pars: z.number().int(),
  bogeys: z.number().int(),
  doublePlus: z.number().int(),
});
const averageHistorySchema = z.array(z.object({ roundId: roundIdSchema, average: z.number() })).readonly();

// bests/milestones (analytics spec 2026-07-21 §3, domain/golfer/analytics.ts) mirror the domain
// shapes exactly, no richer than that.
const bestRoundSchema = z.object({ roundId: roundIdSchema, gross: z.number().int(), toPar: z.number().int() });
const bestsSchema: z.ZodType<GolferBests> = z.object({ best18: bestRoundSchema.optional(), best9: bestRoundSchema.optional() });
const milestoneSchema: z.ZodType<Milestone> = z.object({
  kind: z.union([z.literal("first-birdie"), z.literal("first-eagle"), z.literal("broke-100"), z.literal("broke-90"), z.literal("broke-80")]),
  roundId: roundIdSchema,
});

const golferMetricsSchema: z.ZodType<GolferMetrics> = z.object({
  average: z.number().optional(),
  typicalEighteen: scoringShapeSchema,
  averageHistory: averageHistorySchema,
  bests: bestsSchema,
  milestones: z.array(milestoneSchema).readonly(),
});

export interface GetMyRecordResponse {
  readonly metrics: GolferMetrics;
  // newest first (application/src/golfers/getMyRecord.ts); finalizedAt/createdAt (index-chart-
  // polish spec §1.6, the chart's date anchors) mirror GetMyRounds' own rename discipline
  // (finalizedAtMs/createdAtMs -> finalizedAt/createdAt). Optional on the wire so a new bundle
  // against an old lambda still parses; always present in practice for finalizedAt.
  // `playedAt` (spec 2026-08-01 §4b): WHEN THE GOLF HAPPENED — REQUIRED, unlike the two above:
  // projectArchive always provides it (domain's playedAtMsOf never produces undefined for a
  // real archive), so there is no legacy-line case to tolerate the way createdAt has one.
  readonly history: readonly (GolferRoundLine & { readonly finalizedAt?: number; readonly playedAt: number; readonly createdAt?: number })[];
}

export const getMyRecordResponseSchema: z.ZodType<GetMyRecordResponse> = z.object({
  metrics: golferMetricsSchema,
  history: z
    .array(z.object({ ...golferRoundLineFields, finalizedAt: z.number().int().optional(), playedAt: z.number().int(), createdAt: z.number().int().optional() }))
    .readonly(),
});

// GET /me/courses/{courseId}/record (analytics spec 2026-07-21 §4): "Your record here" — the
// caller's OWN rows at one course, folded through domain's `courseRecord` (application/src/
// golfers/getMyCourseRecord.ts runs the getMyRecord idiom exactly: get-or-nothing, no
// ensureGolfer). Mirrors domain's CourseRecord shape field-for-field, wrapped with the courseId
// the caller asked about. Non-strict, house style — `insights` shows only from ≥5 rounds at the
// course (the domain's own gate, never re-derived here).
//
// best/scoringAverage split by hole count (round-plays-a-nine spec 2026-08-02, Finding 1): a
// course can now hold both a 9- and an 18-hole round, so — mirroring `bests`/`GolferBests` above
// — there are two of each rather than one number that would mix them.
export interface GetMyCourseRecordResponse {
  readonly courseId: CourseId;
  readonly rounds: number;
  readonly best18?: { readonly roundId: RoundId; readonly gross: number; readonly toPar: number };
  readonly best9?: { readonly roundId: RoundId; readonly gross: number; readonly toPar: number };
  readonly scoringAverage18?: number;
  readonly scoringAverage9?: number;
  readonly insights?: {
    readonly worstHole?: { readonly hole: number; readonly par: number; readonly plays: number; readonly avgOverPar: number; readonly doublePlus: number };
    readonly scoringHole?: { readonly hole: number; readonly par: number; readonly plays: number; readonly parOrBetter: number };
    readonly neverBirdied?: readonly number[];
  };
}

export const getMyCourseRecordResponseSchema: z.ZodType<GetMyCourseRecordResponse> = z.object({
  courseId: courseIdSchema,
  rounds: z.number().int(),
  best18: bestRoundSchema.optional(),
  best9: bestRoundSchema.optional(),
  scoringAverage18: z.number().optional(),
  scoringAverage9: z.number().optional(),
  insights: z
    .object({
      worstHole: z.object({ hole: z.number().int(), par: z.number().int(), plays: z.number().int(), avgOverPar: z.number(), doublePlus: z.number().int() }).optional(),
      scoringHole: z.object({ hole: z.number().int(), par: z.number().int(), plays: z.number().int(), parOrBetter: z.number().int() }).optional(),
      neverBirdied: z.array(z.number().int()).readonly().optional(),
    })
    .optional(),
});

// GET /golfers/{golferId} (navigation spec §6a): the golfer page's read. Any signed-in golfer
// may view any golfer — golf handicaps are posted in every clubhouse; the record is scores,
// not messages (spec §6a's own visibility decision). Deliberately narrower than GolferView +
// GetMyRecordResponse combined: no homeCourseId/namePlaceholder (the page never renders them —
// serve only what renders) — application/src/golfers/getGolfer.ts runs the SAME lines-to-
// `{metrics, history}` fold getMyRecord.ts runs (recordOf.ts), never a second implementation.
export interface GetGolferResponse {
  readonly name: string;
  readonly metrics: GolferMetrics;
  // finalizedAt/createdAt (index-chart-polish spec §1.6) — same rename discipline and
  // old-lambda tolerance as GetMyRecordResponse's own history above. `playedAt` (spec
  // 2026-08-01 §4b) is REQUIRED for the same reason it is there — see that comment.
  readonly history: readonly (GolferRoundLine & { readonly finalizedAt?: number; readonly playedAt: number; readonly createdAt?: number })[];
}

export const getGolferResponseSchema: z.ZodType<GetGolferResponse> = z.object({
  name: z.string(),
  metrics: golferMetricsSchema,
  history: z
    .array(z.object({ ...golferRoundLineFields, finalizedAt: z.number().int().optional(), playedAt: z.number().int(), createdAt: z.number().int().optional() }))
    .readonly(),
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
// `playedAt` (spec 2026-08-01 §4b): WHEN THE GOLF HAPPENED — REQUIRED like `finalizedAt`,
// unlike `createdAt`: projectArchive always provides it.
export interface GetMyRoundsResponse {
  readonly rounds: readonly (GolferRoundLine & { readonly finalizedAt: number; readonly playedAt: number; readonly createdAt?: number })[];
}

export const getMyRoundsResponseSchema: z.ZodType<GetMyRoundsResponse> = z.object({
  rounds: z.array(z.object({ ...golferRoundLineFields, finalizedAt: z.number().int(), playedAt: z.number().int(), createdAt: z.number().int().optional() })).readonly(),
});

// GET /me/rounds/live (projection-realignment Task 13): "your rounds, right now" — presence
// pointers (application/src/rounds/presence.ts's writePresence, written at seat-time by
// startRound/joinRound and removed at finalize by projections/
// projectArchive.ts's deleteLive loop), a DIFFERENT surface from GetMyRoundsResponse above
// (that one is finalized-round HISTORY). `joinedAt` is the wire name for the projection
// store's own `joinedAtMs` (same rename discipline as GetMyRoundsResponse's `finalizedAt`).
// Sorted newest-joined first (application/src/golfers/getMyLiveRounds.ts).
// `playedAt` (spec 2026-08-01 §4b): WHEN THE GOLF HAPPENED — domain's playedAtMsOf, via
// getMyLiveRounds.ts's own journal read, so the home list can render a live round the SAME way
// the archive/join-link render it ("Casa Verde GC · Sat, Jul 12") — a round-level fact, unlike the
// per-golfer `joinedAt`. REPLACES the old `createdAt` outright rather than adding beside it:
// neither field was ever an audit surface on this response the way finalizedAt/createdAt are on
// GetMyRoundsResponse's finalized HISTORY — a second date here would be one nobody reads.
// REQUIRED (unlike the old createdAt, which was best-effort): a genuinely live round's log always
// has a genesis, so playedAtMsOf never fails for one — getMyLiveRounds.ts drops any entry whose
// presence pointer outlived its own round rather than serving a fact-free stub.
export interface GetMyLiveRoundsResponse {
  readonly rounds: readonly { readonly roundId: RoundId; readonly courseName: string; readonly joinedAt: number; readonly playedAt: number }[];
}

export const getMyLiveRoundsResponseSchema: z.ZodType<GetMyLiveRoundsResponse> = z.object({
  rounds: z.array(z.object({ roundId: roundIdSchema, courseName: z.string(), joinedAt: z.number().int(), playedAt: z.number().int() })).readonly(),
});
