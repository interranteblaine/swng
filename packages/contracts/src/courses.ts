import { z } from "zod";
import type { CourseCard, CourseId, HoleSelection } from "@swng/domain";
import { courseIdSchema } from "./ids.js";
import { courseCardSchema, holeSchema, holeSelectionSchema } from "./round.js";

// The wire view of a lineage's CURRENT card (course-cards spec §4): the exact frozen-able
// value plus attribution. No `name` field — the card carries courseName; no per-tee badge
// metadata — verification is gone (§8) and the audit trail stays server-side.
export interface CourseView {
  readonly courseId: CourseId;
  readonly cardId: string;
  readonly card: CourseCard;
  readonly enteredBy: string; // display name only; golferId stays server-side
  readonly updatedAtMs: number;
}

export const courseViewSchema: z.ZodType<CourseView> = z.object({
  courseId: courseIdSchema,
  cardId: z.string(),
  card: courseCardSchema,
  enteredBy: z.string(),
  updatedAtMs: z.number(),
});

// Input tees: POST mints every id (no teeId accepted — .strict() rejects it); PUT takes an
// optional teeId per the continuity rule (§3: with id = same tee, without = new, absent = removed).
// rating/slope are optional-as-a-pair here purely STRUCTURALLY (unrated-courses spec §1) —
// mirroring round.ts's teeSetSchema so an unrated tee can be POSTed at all. The pairing + the
// bounds are the domain's job: validateCard rejects one-of-two with `rating-slope-paired` and
// enforces the 30..90 / 55..155 ranges. Keeping the wire purely structural (both `.optional()`,
// no `.refine`) is what lets that single server-side rule stay the sole authority, un-mirrored here.
// task-1 (pre-prod hardening, placement rule): these bounds are request-ingress ONLY — they
// live on newTeeInputSchema/continuingTeeInputSchema (this file's own request-body schemas),
// never on round.ts's teeSetSchema/holeSchema/courseCardSchema (the read-side mirrors backing
// courseViewSchema/peekRoundResponseSchema above), so an already-stored course/card is never
// rejected on read.
const newTeeInputSchema = z
  .object({
    name: z.string().min(1).max(40),
    rating: z.number().optional(),
    slope: z.number().optional(),
    holes: z.array(holeSchema).min(1).max(18).readonly(),
  })
  .strict();
const continuingTeeInputSchema = newTeeInputSchema.extend({ teeId: z.string().min(1).optional() }).strict();

export const createCourseRequestSchema = z
  .object({ name: z.string().min(1).max(80), teeSets: z.array(newTeeInputSchema).min(1).max(12) })
  .strict();
export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;

export const supersedeCardRequestSchema = z
  .object({ name: z.string().min(1).max(80), teeSets: z.array(continuingTeeInputSchema).min(1).max(12), supersedes: z.string().min(1) })
  .strict();
export type SupersedeCardRequest = z.infer<typeof supersedeCardRequestSchema>;

export interface CreateCourseResponse {
  readonly course: CourseView;
}
export interface SupersedeCardResponse {
  readonly course: CourseView;
}
export interface GetCourseResponse {
  readonly course: CourseView;
}
export interface SearchCoursesResponse {
  readonly courses: readonly { readonly courseId: CourseId; readonly name: string; readonly holeCount: 9 | 18 }[];
}

export const createCourseResponseSchema: z.ZodType<CreateCourseResponse> = z.object({ course: courseViewSchema });
export const supersedeCardResponseSchema: z.ZodType<SupersedeCardResponse> = z.object({ course: courseViewSchema });
export const getCourseResponseSchema: z.ZodType<GetCourseResponse> = z.object({ course: courseViewSchema });
export const searchCoursesResponseSchema: z.ZodType<SearchCoursesResponse> = z.object({
  courses: z
    .array(z.object({ courseId: courseIdSchema, name: z.string(), holeCount: z.union([z.literal(9), z.literal(18)]) }))
    .readonly(),
});

// A pre-join preview of the round's frozen card — deliberately just enough to pick a tee
// before JoinRound, nothing else (capability discipline): no roundId, no full CourseCard,
// no participants. `rating`/`slope` are optional as a pair (unrated-courses spec §1), mirroring
// domain's TeeSet — a peek of an unrated tee still names it, just without numbers.
export interface PeekRoundResponse {
  readonly courseName: string;
  // Name + rating/slope only. `par` and `holes` used to ride here for the join-side strokes
  // derivation (the handicap-model legibility arc: par fed the rated conversion, the hole count
  // made the unrated estimate hole-count-correct). Nothing derives strokes any more — they are one
  // integer someone typed onto the roster (spec 2026-07-30 §2) — and no dormant fields are kept,
  // so both are gone. The one reader of a peek tee is
  // JoinRoundPage's picker, which renders `name` and `teeNumbers(tee)`; teeNumbers reads
  // rating/slope alone.
  readonly teeSets: readonly { readonly name: string; readonly rating?: number; readonly slope?: number }[];
  // playedAt (spec 2026-08-01 §4b): WHEN THE GOLF HAPPENED — domain's playedAtMsOf over the
  // round's log, so the join-link sign-up framing can render the round the SAME way
  // ("Casa Verde GC · Sat, Jul 12") the home list and archive do. REPLACES the old `createdAt`
  // outright rather than adding beside it: a peek carries no audit surface at all (unlike a
  // history line's finalizedAt/createdAt pair), so a second date here would be one nobody reads.
  // Required — a peek always reads a live round, whose log always has round-created, and a peek is
  // already capability-scoped to disclose the round's day, so this discloses nothing new.
  readonly playedAt: number;
  // Which holes the round set out to play (spec 2026-08-02 §3c) — the join-side tee picker needs
  // this the same way it needs playedAt above. Optional: absence means the whole card, true of
  // every round on file before this arc, so nothing migrates.
  readonly holes?: HoleSelection;
}

export const peekRoundResponseSchema: z.ZodType<PeekRoundResponse> = z.object({
  courseName: z.string(),
  teeSets: z.array(z.object({ name: z.string(), rating: z.number().optional(), slope: z.number().optional() })).readonly(),
  playedAt: z.number().int(),
  holes: holeSelectionSchema.optional(),
});
