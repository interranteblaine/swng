import { z } from "zod";
import type { CourseCard, CourseId } from "@swng/domain";
import { courseIdSchema } from "./ids.js";
import { courseCardSchema, holeSchema } from "./round.js";

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
const newTeeInputSchema = z
  .object({ name: z.string().min(1), rating: z.number(), slope: z.number(), holes: z.array(holeSchema).min(1).readonly() })
  .strict();
const continuingTeeInputSchema = newTeeInputSchema.extend({ teeId: z.string().min(1).optional() }).strict();

export const createCourseRequestSchema = z
  .object({ name: z.string().min(1), teeSets: z.array(newTeeInputSchema).min(1) })
  .strict();
export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;

export const supersedeCardRequestSchema = z
  .object({ name: z.string().min(1), teeSets: z.array(continuingTeeInputSchema).min(1), supersedes: z.string().min(1) })
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
// no participants.
export interface PeekRoundResponse {
  readonly courseName: string;
  readonly teeSets: readonly { readonly name: string; readonly rating: number; readonly slope: number }[];
  // accounts-only identity spec §5: the round-created event's own wall time, so the join-link
  // sign-up framing can render the round the SAME way ("Casa Verde GC · Sat, Jul 12") the home list
  // and archive do. Required — a peek always reads a live round, whose log always has round-created.
  readonly createdAt: number;
}

export const peekRoundResponseSchema: z.ZodType<PeekRoundResponse> = z.object({
  courseName: z.string(),
  teeSets: z.array(z.object({ name: z.string(), rating: z.number(), slope: z.number() })).readonly(),
  createdAt: z.number().int(),
});
