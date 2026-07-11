import { z } from "zod";
import type { CourseId, CrewId, CrewRole, GolferId } from "@swng/domain";
import type { GameConfigInput } from "./commands.js";
import { gameConfigInputSchema } from "./commands.js";
import { courseIdSchema, crewIdSchema, golferIdSchema } from "./ids.js";

// The wire mirror of domain's CrewRole (crew/crew.ts) — "organizer" carries no extra
// authority in v1 (same doc comment as the domain type), recorded now so it can be
// surfaced/enforced later without a data migration.
export const crewRoleSchema: z.ZodType<CrewRole> = z.enum(["organizer", "member"]);

// claimed is NOT on the domain CrewMember — it's a golfer-store lookup done at read time
// (crews/crewView.ts), same "derive, don't store" reasoning as courseView's teeSets badges.
export interface CrewMemberView {
  readonly golferId: GolferId;
  readonly name: string;
  readonly role: CrewRole;
  readonly claimed: boolean;
}

export const crewMemberViewSchema: z.ZodType<CrewMemberView> = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  role: crewRoleSchema,
  claimed: z.boolean(),
});

// The wire mirror of domain's StandingGame (crew/crew.ts): `games` reuses commands.ts'
// GameConfigInput (id-less, client-submitted game shapes) rather than a crews-local schema —
// it is structurally the SAME shape as domain's GameConfigDraft (a standing game's preset
// games have no GameId yet either), so one schema serves both StartRound's `game` field and
// a crew's standing preset.
export interface StandingGameView {
  readonly courseId?: CourseId;
  readonly tee?: string;
  readonly games: readonly GameConfigInput[];
}

export const standingGameViewSchema: z.ZodType<StandingGameView> = z.object({
  courseId: courseIdSchema.optional(),
  tee: z.string().optional(),
  games: z.array(gameConfigInputSchema).readonly(),
});

// The wire projection of a Crew aggregate (application/src/crews/crewView.ts builds it):
// `joinCode` is store-level metadata (mirrors RoundStore's join-code split — the domain Crew
// type itself carries no joinCode field, same reason RoundState carries no joinCode either).
export interface CrewView {
  readonly crewId: CrewId;
  readonly name: string;
  readonly joinCode: string;
  readonly members: readonly CrewMemberView[];
  readonly standingGame?: StandingGameView;
}

export const crewViewSchema: z.ZodType<CrewView> = z.object({
  crewId: crewIdSchema,
  name: z.string(),
  joinCode: z.string(),
  members: z.array(crewMemberViewSchema).readonly(),
  standingGame: standingGameViewSchema.optional(),
});

// Request bodies are `.strict()` (courses.ts' house style): every server-assigned field
// (crewId, joinCode, role, claimed, member ids) is a rejection, not a silently-dropped extra
// key, if a client proposes it.
export const createCrewRequestSchema = z.object({ name: z.string().min(1) }).strict();
export type CreateCrewRequest = z.infer<typeof createCrewRequestSchema>;

// Mints a stable ghost golfer for a person without an account — account holders never enter
// a crew this way (they join by code, below, as their own golfer).
export const addCrewMemberRequestSchema = z.object({ name: z.string().min(1) }).strict();
export type AddCrewMemberRequest = z.infer<typeof addCrewMemberRequestSchema>;

// `code`'s shape mirrors joinRoundRequestSchema's own `code` field exactly (commands.ts) —
// the crew join code is minted with the SAME machinery (IdGenerator.newJoinCode) as a
// round's, so it carries the same 6-character shape.
export const joinCrewRequestSchema = z.object({ code: z.string().length(6) }).strict();
export type JoinCrewRequest = z.infer<typeof joinCrewRequestSchema>;

export const saveStandingGameRequestSchema = z
  .object({
    standingGame: z.object({
      courseId: courseIdSchema.optional(),
      tee: z.string().optional(),
      games: z.array(gameConfigInputSchema).readonly(),
    }),
  })
  .strict();
export type SaveStandingGameRequest = z.infer<typeof saveStandingGameRequestSchema>;

// One response shape, `{ crew }`, for every crew mutation/read — named per endpoint (courses.ts'
// house style: CreateCourseResponse/AddTeeSetResponse/... are all `{ course }` too, each with
// its own name for route-level clarity even though the shape repeats).
export interface CreateCrewResponse {
  readonly crew: CrewView;
}
export interface AddCrewMemberResponse {
  readonly crew: CrewView;
}
export interface JoinCrewResponse {
  readonly crew: CrewView;
}
export interface SaveStandingGameResponse {
  readonly crew: CrewView;
}
export interface GetCrewResponse {
  readonly crew: CrewView;
}

export const createCrewResponseSchema: z.ZodType<CreateCrewResponse> = z.object({ crew: crewViewSchema });
export const addCrewMemberResponseSchema: z.ZodType<AddCrewMemberResponse> = z.object({ crew: crewViewSchema });
export const joinCrewResponseSchema: z.ZodType<JoinCrewResponse> = z.object({ crew: crewViewSchema });
export const saveStandingGameResponseSchema: z.ZodType<SaveStandingGameResponse> = z.object({ crew: crewViewSchema });
export const getCrewResponseSchema: z.ZodType<GetCrewResponse> = z.object({ crew: crewViewSchema });

export interface ListMyCrewsResponse {
  readonly crews: readonly { readonly crewId: CrewId; readonly name: string; readonly memberCount: number }[];
}

export const listMyCrewsResponseSchema: z.ZodType<ListMyCrewsResponse> = z.object({
  crews: z.array(z.object({ crewId: crewIdSchema, name: z.string(), memberCount: z.number().int() })).readonly(),
});
