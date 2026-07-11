import { z } from "zod";
import type { CourseId, GolferId, GolferRoundLine } from "@swng/domain";
import { courseIdSchema, golferIdSchema, roundIdSchema } from "./ids.js";

// The wire projection of a Golfer aggregate (application/src/golfers/golferView.ts builds
// it): the two independently-settable handicap numbers the client itself declares
// (declared/official) — NOT `computed` or an `effective` precedence field. Those two used to
// ride along here, but the server has no persisted computed index on the golfer item itself
// (it lives in the separate index projection, application/src/golfers/getMyRecord.ts), so a
// server-side `effectiveIndex(golfer.handicap)` call here was silently WRONG whenever a real
// computed index existed elsewhere (e.g. declared 15 + a computed 7.2 the server didn't know
// about → wire said effective 15/declared). The web composes the true effective index
// client-side from GET /me (declared/official) + GET /me/record (computed), via domain's own
// effectiveIndex — see apps/web/src/routes/ProfilePage.tsx.
export interface GolferView {
  readonly golferId: GolferId;
  readonly name: string;
  readonly homeCourseId?: CourseId;
  readonly declared?: number;
  readonly official?: number;
}

export const golferViewSchema: z.ZodType<GolferView> = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  homeCourseId: courseIdSchema.optional(),
  declared: z.number().optional(),
  official: z.number().optional(),
});

// golfer is null for an unbound sub — GET /me NEVER creates (plan amendment: the original
// "get-or-create" deadlocked claiming, since the auto-created golfer binds the sub before a
// later claimGolfer call ever runs, so every claim hit the sub-already-bound collision arm).
// updateMyGolfer (PUT /me) is the one create path now.
export interface GetMeResponse {
  readonly golfer: GolferView | null;
}
export const getMeResponseSchema: z.ZodType<GetMeResponse> = z.object({ golfer: golferViewSchema.nullable() });

// PUT /me and POST /golfers/claim always resolve to a real golfer (both are create-or-act
// paths, never a "does this exist" read) — a distinct, non-nullable response shape from
// GetMeResponse so callers of updateMyGolfer/claimGolfer don't inherit GET /me's null case.
export interface GolferResponse {
  readonly golfer: GolferView;
}
export const golferResponseSchema: z.ZodType<GolferResponse> = z.object({ golfer: golferViewSchema });

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

// name (papercut 5, M8 plan) is used ONLY when the claim lazily CREATES the golfer row
// (application/src/golfers/claimGolfer.ts) — a claim binding an EXISTING row never renames,
// same "name only seeds a fresh item" invariant golferStore.ts's port doc already states for
// `claim`. Optional: absent falls back to defaultGolferName(claims), unchanged from before
// this field existed.
//
// `code` (M9 hardening, claim proof-of-context) is REQUIRED: before this field existed, a
// bare golferId was the entire claim capability — anyone who merely LEARNED an id (shared in
// a text thread, visible in a URL) could claim its whole history. The server now resolves
// `code` as a round join code (the round's own participants must include `golferId`) or else
// a crew join code (the crew's own members must include `golferId`) before either collision
// arm runs — see claimGolfer.ts's own doc comment for the exact ordering and why it matters.
export const claimGolferRequestSchema = z.object({ golferId: golferIdSchema, name: z.string().min(1).optional(), code: z.string().min(1) }).strict();
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
  // differentialsUsed: WHS Rule 5.2a's `use` count (domain's computeIndexDetail, whs.ts) —
  // how many differentials were actually averaged, not how many were in the window.
  readonly index?: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number };
  readonly history: readonly GolferRoundLine[]; // newest first (application/src/golfers/getMyRecord.ts)
}

export const getMyRecordResponseSchema: z.ZodType<GetMyRecordResponse> = z.object({
  index: z.object({ value: z.number(), computedAtMs: z.number().int(), differentialsUsed: z.number().int() }).optional(),
  history: z.array(golferRoundLineSchema).readonly(),
});
