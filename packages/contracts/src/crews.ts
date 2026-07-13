import { z } from "zod";
import type { CrewId, CrewRole, GolferId, HeadToHeadRecord, RoundId, SeasonLedgerLine } from "@swng/domain";
import { crewIdSchema, golferIdSchema, roundIdSchema } from "./ids.js";

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

// The wire projection of a Crew aggregate (application/src/crews/crewView.ts builds it):
// `joinCode` is store-level metadata (mirrors RoundStore's join-code split — the domain Crew
// type itself carries no joinCode field, same reason RoundState carries no joinCode either).
// A crew is a grouping/competition ONLY (owner ruling, spec §11a) — no standing game.
export interface CrewView {
  readonly crewId: CrewId;
  readonly name: string;
  readonly joinCode: string;
  readonly members: readonly CrewMemberView[];
}

export const crewViewSchema: z.ZodType<CrewView> = z.object({
  crewId: crewIdSchema,
  name: z.string(),
  joinCode: z.string(),
  members: z.array(crewMemberViewSchema).readonly(),
});

// Request bodies are `.strict()` (courses.ts' house style): every server-assigned field
// (crewId, joinCode, role, claimed, member ids) is a rejection, not a silently-dropped extra
// key, if a client proposes it.
export const createCrewRequestSchema = z.object({ name: z.string().min(1) }).strict();
export type CreateCrewRequest = z.infer<typeof createCrewRequestSchema>;

// Architecture-realignment Task 9 (de-ghost, spec §4 "membership: real accounts only"): a crew
// member is now an EXISTING account golfer, added by their golferId — the server requires that
// golfer to already carry a bound sub (ghost-not-addable otherwise). The old M8 shape minted a
// fresh ghost from a `name`; that path is gone. Ghosts still exist inside rounds (play as ghost
// → claim in-round → account → optionally join a crew).
export const addCrewMemberRequestSchema = z.object({ golferId: golferIdSchema }).strict();
export type AddCrewMemberRequest = z.infer<typeof addCrewMemberRequestSchema>;

// `code`'s shape mirrors joinRoundRequestSchema's own `code` field exactly (commands.ts) —
// the crew join code is minted with the SAME machinery (IdGenerator.newJoinCode) as a
// round's, so it carries the same 6-character shape.
export const joinCrewRequestSchema = z.object({ code: z.string().length(6) }).strict();
export type JoinCrewRequest = z.infer<typeof joinCrewRequestSchema>;

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
export interface GetCrewResponse {
  readonly crew: CrewView;
}

export const createCrewResponseSchema: z.ZodType<CreateCrewResponse> = z.object({ crew: crewViewSchema });
export const addCrewMemberResponseSchema: z.ZodType<AddCrewMemberResponse> = z.object({ crew: crewViewSchema });
export const joinCrewResponseSchema: z.ZodType<JoinCrewResponse> = z.object({ crew: crewViewSchema });
export const getCrewResponseSchema: z.ZodType<GetCrewResponse> = z.object({ crew: crewViewSchema });

export interface ListMyCrewsResponse {
  readonly crews: readonly { readonly crewId: CrewId; readonly name: string; readonly memberCount: number }[];
}

export const listMyCrewsResponseSchema: z.ZodType<ListMyCrewsResponse> = z.object({
  crews: z.array(z.object({ crewId: crewIdSchema, name: z.string(), memberCount: z.number().int() })).readonly(),
});

// Mirrors domain's HeadToHeadRecord (crew/ledger.ts) field-for-field, same "wire-shapes-an-
// already-wire-shaped-domain-type" idiom as golfers.ts's golferRoundLineSchema. Shared by
// seasonStandingsResponseSchema below — the GET /crews/{crewId}/records route (and its own
// season-only ledger line schema) that used to share this is deleted (architecture-realignment
// Task 9/11: standings-on-read replaced the crew projection layer entirely).
const headToHeadRecordSchema: z.ZodType<HeadToHeadRecord> = z.object({
  a: golferIdSchema,
  b: golferIdSchema,
  aWins: z.number().int(),
  bWins: z.number().int(),
  halves: z.number().int(),
});

// Architecture-realignment Task 9 (crew seasons + counted rounds + standings-on-read). A season
// is a named, open/closed thing a member creates ("2026", "Summer Cup"); `seasonId` is an
// opaque server-minted id (never accepted from the wire), `createdAtMs` lets a client sort
// newest-first (the use case sorts too — this just carries the fact).
export interface CrewSeasonView {
  readonly seasonId: string;
  readonly name: string;
  readonly status: "open" | "closed";
  readonly createdAtMs: number;
}
export const crewSeasonViewSchema: z.ZodType<CrewSeasonView> = z.object({
  seasonId: z.string(),
  name: z.string(),
  status: z.enum(["open", "closed"]),
  createdAtMs: z.number().int(),
});

// `name` is `.min(1)` on the wire (the same non-empty floor createCrewRequestSchema uses); the
// real trimmed 1-60 bound lives in createSeason (application) — the honest layer, since a
// season isn't a domain entity.
export const createSeasonRequestSchema = z.object({ name: z.string().min(1) }).strict();
export type CreateSeasonRequest = z.infer<typeof createSeasonRequestSchema>;

export interface CreateSeasonResponse {
  readonly season: CrewSeasonView;
}
export const createSeasonResponseSchema: z.ZodType<CreateSeasonResponse> = z.object({ season: crewSeasonViewSchema });

export interface ListSeasonsResponse {
  readonly seasons: readonly CrewSeasonView[];
}
export const listSeasonsResponseSchema: z.ZodType<ListSeasonsResponse> = z.object({ seasons: z.array(crewSeasonViewSchema).readonly() });

// One finished round counted into a season, as the wire sees it: `finalizedAt` is epoch ms (the
// round-finalized event's own wall time), `appendedBy` is the member who counted it. Reused by
// the append response and the standings' own `rounds` list.
export interface CountedRoundView {
  readonly roundId: RoundId;
  readonly finalizedAt: number;
  readonly appendedBy: GolferId;
}
export const countedRoundViewSchema: z.ZodType<CountedRoundView> = z.object({
  roundId: roundIdSchema,
  finalizedAt: z.number().int(),
  appendedBy: golferIdSchema,
});

export const appendCountedRoundRequestSchema = z.object({ roundId: roundIdSchema }).strict();
export type AppendCountedRoundRequest = z.infer<typeof appendCountedRoundRequestSchema>;

export interface AppendCountedRoundResponse {
  readonly round: CountedRoundView;
}
export const appendCountedRoundResponseSchema: z.ZodType<AppendCountedRoundResponse> = z.object({ round: countedRoundViewSchema });

export interface RemoveCountedRoundResponse {
  readonly roundId: RoundId;
}
export const removeCountedRoundResponseSchema: z.ZodType<RemoveCountedRoundResponse> = z.object({ roundId: roundIdSchema });

// A season ledger line resolved for display: the pure SeasonLedgerLine (crew/ledger.ts) plus a
// `name` resolved from the CURRENT roster's own CrewMember.name (getSeasonStandings.ts) — a
// crew is members-only (owner ruling, spec §11a): the ledger and head-to-head are ALREADY
// filtered to golferIds on the current roster before this line is ever built, so every row here
// is, by construction, a member — there is no separate flag to carry.
export interface SeasonStandingLine extends SeasonLedgerLine {
  readonly name: string;
}
const seasonStandingLineSchema: z.ZodType<SeasonStandingLine> = z.object({
  golferId: golferIdSchema,
  rounds: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  halves: z.number().int(),
  points: z.number().int(),
  skins: z.number().int(),
  name: z.string(),
});

// Standings are computed on read (spec §4): the counted snapshots folded through the SAME
// domain crewContribution/aggregateSeason the M8 projector used — no stored ledger.
export interface SeasonStandingsResponse {
  readonly seasonId: string;
  readonly name: string;
  readonly status: "open" | "closed";
  readonly rounds: readonly CountedRoundView[]; // newest-first by finalizedAt
  readonly ledger: readonly SeasonStandingLine[];
  readonly headToHead: readonly HeadToHeadRecord[];
}
export const seasonStandingsResponseSchema: z.ZodType<SeasonStandingsResponse> = z.object({
  seasonId: z.string(),
  name: z.string(),
  status: z.enum(["open", "closed"]),
  rounds: z.array(countedRoundViewSchema).readonly(),
  ledger: z.array(seasonStandingLineSchema).readonly(),
  headToHead: z.array(headToHeadRecordSchema).readonly(),
});

export interface LeaveCrewResponse {
  readonly crewId: CrewId;
}
export const leaveCrewResponseSchema: z.ZodType<LeaveCrewResponse> = z.object({ crewId: crewIdSchema });
