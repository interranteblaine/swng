import { z } from "zod";
import type { CourseCard, CourseId, Provenance } from "@swng/domain";
import { courseIdSchema } from "./ids.js";
import { courseCardSchema, teeSetSchema } from "./round.js";

// The wire projection of a Course aggregate (application/src/courses/courseView.ts builds
// it): `card` is exactly what StartRound consumes (courseCardOf's output — a round freezes
// this whole), while `teeSets` is CURRENT-versions-only metadata for the UI's badges
// (name/version/provenance/enteredBy/verifiedBy) — the full superseded-version audit trail
// stays server-side in v1 (the UI shows badges, not history).
export interface CourseView {
  readonly courseId: CourseId;
  readonly name: string;
  readonly card: CourseCard;
  readonly teeSets: readonly {
    readonly name: string;
    readonly version: number;
    readonly provenance: Provenance;
    readonly enteredBy: string;
    readonly verifiedBy: readonly string[];
  }[];
}

const courseViewTeeSetSchema = z.object({
  name: z.string(),
  version: z.number().int(),
  provenance: z.enum(["community", "imported"]),
  enteredBy: z.string(),
  verifiedBy: z.array(z.string()).readonly(),
});

export const courseViewSchema: z.ZodType<CourseView> = z.object({
  courseId: courseIdSchema,
  name: z.string(),
  card: courseCardSchema,
  teeSets: z.array(courseViewTeeSetSchema).readonly(),
});

// Request bodies are `.strict()` (like commands.ts' *ConfigInput schemas): a client
// proposing extra fields — a courseId, a version, a provenance, an enteredAtMs — is a
// rejection, not a silently-dropped extra key, because every one of those is server-assigned.
export const createCourseRequestSchema = z
  .object({
    name: z.string().min(1),
    tee: teeSetSchema,
    enteredBy: z.string().min(1),
  })
  .strict();
export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;

export const addTeeSetRequestSchema = z
  .object({
    tee: teeSetSchema,
    enteredBy: z.string().min(1),
  })
  .strict();
export type AddTeeSetRequest = z.infer<typeof addTeeSetRequestSchema>;

export const verifyTeeSetRequestSchema = z
  .object({
    teeName: z.string().min(1),
    verifierName: z.string().min(1),
    // The version of the tee set the golfer is DISPLAYING when they tap verify — matches
    // CourseView.teeSets[].version, which the UI already shows. Required, not optional: a
    // verify with no version can't be checked against a revision landing between page load
    // and POST, which is exactly the transplant this field exists to prevent (domain's
    // verifyTeeSet, "expectedVersion").
    version: z.number().int().min(1),
  })
  .strict();
export type VerifyTeeSetRequest = z.infer<typeof verifyTeeSetRequestSchema>;

export interface CreateCourseResponse {
  readonly course: CourseView;
}
export interface AddTeeSetResponse {
  readonly course: CourseView;
}
export interface VerifyTeeSetResponse {
  readonly course: CourseView;
}
export interface GetCourseResponse {
  readonly course: CourseView;
}
export interface SearchCoursesResponse {
  readonly courses: readonly { readonly courseId: CourseId; readonly name: string }[];
}
// A pre-join preview of the round's frozen card — deliberately just enough to pick a tee
// before JoinRound, nothing else (capability discipline): no roundId, no full CourseCard,
// no participants.
export interface PeekRoundResponse {
  readonly courseName: string;
  readonly teeSets: readonly { readonly name: string; readonly rating: number; readonly slope: number }[];
}

export const createCourseResponseSchema: z.ZodType<CreateCourseResponse> = z.object({ course: courseViewSchema });
export const addTeeSetResponseSchema: z.ZodType<AddTeeSetResponse> = z.object({ course: courseViewSchema });
export const verifyTeeSetResponseSchema: z.ZodType<VerifyTeeSetResponse> = z.object({ course: courseViewSchema });
export const getCourseResponseSchema: z.ZodType<GetCourseResponse> = z.object({ course: courseViewSchema });

export const searchCoursesResponseSchema: z.ZodType<SearchCoursesResponse> = z.object({
  courses: z.array(z.object({ courseId: courseIdSchema, name: z.string() })).readonly(),
});

export const peekRoundResponseSchema: z.ZodType<PeekRoundResponse> = z.object({
  courseName: z.string(),
  teeSets: z.array(z.object({ name: z.string(), rating: z.number(), slope: z.number() })).readonly(),
});
