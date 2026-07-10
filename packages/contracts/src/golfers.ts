import { z } from "zod";
import type { CourseId, GolferId, GolferRoundLine } from "@swng/domain";
import { courseIdSchema, golferIdSchema, roundIdSchema } from "./ids.js";

// The wire projection of a Golfer aggregate (application/src/golfers/golferView.ts builds
// it): the three independently-settable handicap numbers (declared/official/computed) ride
// alongside `effective` — domain's effectiveIndex precedence (official > computed >
// declared), pre-resolved server-side so the UI never re-derives it.
export interface GolferView {
  readonly golferId: GolferId;
  readonly name: string;
  readonly homeCourseId?: CourseId;
  readonly declared?: number;
  readonly official?: number;
  readonly computed?: number;
  readonly effective?: { readonly value: number; readonly source: "official" | "computed" | "declared" };
}

const effectiveSchema = z.object({ value: z.number(), source: z.enum(["official", "computed", "declared"]) });

export const golferViewSchema: z.ZodType<GolferView> = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  homeCourseId: courseIdSchema.optional(),
  declared: z.number().optional(),
  official: z.number().optional(),
  computed: z.number().optional(),
  effective: effectiveSchema.optional(),
});

export interface GetMeResponse {
  readonly golfer: GolferView;
}
export const getMeResponseSchema: z.ZodType<GetMeResponse> = z.object({ golfer: golferViewSchema });

// Every field optional — a partial patch (PATCH-like semantics: an absent key leaves the
// stored value untouched; there is no way to CLEAR a set field in v1). `.strict()` like
// courses.ts's request bodies: a client proposing golferId/computed (server-derived, never
// client-set) is a rejection, not a silently-dropped extra key. `official` is self-
// maintained in v1 (architecture.md §2) — a golfer typing their own GHIN index here IS the
// manual maintenance the doc describes, so it's accepted exactly like declared.
export const updateMeRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    homeCourseId: courseIdSchema.optional(),
    declared: z.number().optional(),
    official: z.number().optional(),
  })
  .strict();
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

export const claimGolferRequestSchema = z.object({ golferId: golferIdSchema }).strict();
export type ClaimGolferRequest = z.infer<typeof claimGolferRequestSchema>;

// The wire mirror of domain's GolferRoundLine (golfer/record.ts) — structurally identical,
// same as round.ts's participantSchema mirroring Participant.
const golferRoundLineSchema: z.ZodType<GolferRoundLine> = z.object({
  roundId: roundIdSchema,
  courseName: z.string(),
  tee: z.string(),
  holes: z.union([z.literal(9), z.literal(18)]),
  ags: z.number().optional(),
  differential: z.number().optional(),
  distribution: z.object({
    eagles: z.number().int(),
    birdies: z.number().int(),
    pars: z.number().int(),
    bogeys: z.number().int(),
    doublePlus: z.number().int(),
  }),
});

export interface GetMyRecordResponse {
  readonly index?: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };
  readonly history: readonly GolferRoundLine[]; // newest first (application/src/golfers/getMyRecord.ts)
}

export const getMyRecordResponseSchema: z.ZodType<GetMyRecordResponse> = z.object({
  index: z.object({ value: z.number(), computedAtMs: z.number().int(), differentialsUsed: z.number().int() }).optional(),
  history: z.array(golferRoundLineSchema).readonly(),
});
