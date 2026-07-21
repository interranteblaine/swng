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

// The wire projection of a Crew aggregate (application/src/crews/crewView.ts builds it). The
// permanent `joinCode` — store-level metadata that used to mirror RoundStore's own join-code
// split — is GONE (crew membership, invited in): getting in is an expiring HMAC invite link
// now (MintCrewInviteResponse below), never a value that rides the crew's own view. A crew is
// a grouping/competition ONLY (owner ruling, spec §11a) — no standing game.
export interface CrewView {
  readonly crewId: CrewId;
  readonly name: string;
  readonly members: readonly CrewMemberView[];
}

export const crewViewSchema: z.ZodType<CrewView> = z.object({
  crewId: crewIdSchema,
  name: z.string(),
  members: z.array(crewMemberViewSchema).readonly(),
});

// Request bodies are `.strict()` (courses.ts' house style): every server-assigned field
// (crewId, role, claimed, member ids) is a rejection, not a silently-dropped extra key, if a
// client proposes it.
export const createCrewRequestSchema = z.object({ name: z.string().min(1) }).strict();
export type CreateCrewRequest = z.infer<typeof createCrewRequestSchema>;

// Crew membership (invited in, accountable out — spec §2): POST /crews/{crewId}/invites'
// response — `token` composes into `/crews/join#<token>` from the web's own origin
// (shareRound's exact idiom), `expiresAtMs` lets the web show/reason about the link's own
// 7-day window without decoding the token itself.
export interface MintCrewInviteResponse {
  readonly token: string;
  readonly expiresAtMs: number;
}
export const mintCrewInviteResponseSchema: z.ZodType<MintCrewInviteResponse> = z.object({
  token: z.string(),
  expiresAtMs: z.number().int(),
});

// POST /crews/peek (auth none — spec §2): the capability-scoped preview, mirroring
// PeekRoundResponse's own "nothing about who's already in, just enough to decide" shape — the
// join page's consent screen (spec §2: "Join The Saturday Boys? · 8 members · invited by Al")
// is built from this alone, before sign-in.
export const peekCrewInviteRequestSchema = z.object({ token: z.string() }).strict();
export type PeekCrewInviteRequest = z.infer<typeof peekCrewInviteRequestSchema>;

export interface PeekCrewInviteResponse {
  readonly crewName: string;
  readonly memberCount: number;
  readonly inviterName: string;
}
export const peekCrewInviteResponseSchema: z.ZodType<PeekCrewInviteResponse> = z.object({
  crewName: z.string(),
  memberCount: z.number().int(),
  inviterName: z.string(),
});

// POST /crews/join's body — the permanent 6-character `code` is GONE, replaced by the SAME
// bearer `token` a mint response hands out (crew membership, invited in — spec §2/§3).
export const joinCrewRequestSchema = z.object({ token: z.string() }).strict();
export type JoinCrewRequest = z.infer<typeof joinCrewRequestSchema>;

// One response shape, `{ crew }`, for every crew mutation/read — named per endpoint (courses.ts'
// house style: CreateCourseResponse/SupersedeCardResponse/... are all `{ course }` too, each with
// its own name for route-level clarity even though the shape repeats).
export interface CreateCrewResponse {
  readonly crew: CrewView;
}
export interface JoinCrewResponse {
  readonly crew: CrewView;
}
export interface GetCrewResponse {
  readonly crew: CrewView;
}

export const createCrewResponseSchema: z.ZodType<CreateCrewResponse> = z.object({ crew: crewViewSchema });
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

// POST /crews/{crewId}/seasons/{seasonId}/close and .../reopen (close-season spec 2026-07-21
// §1): the organizer's verbs that flip CrewSeason.status — empty request bodies (no schema
// needed), each returning the updated season view, the SAME `{ season }` shape
// createSeasonResponseSchema uses.
export interface CloseSeasonResponse {
  readonly season: CrewSeasonView;
}
export const closeSeasonResponseSchema: z.ZodType<CloseSeasonResponse> = z.object({ season: crewSeasonViewSchema });

export interface ReopenSeasonResponse {
  readonly season: CrewSeasonView;
}
export const reopenSeasonResponseSchema: z.ZodType<ReopenSeasonResponse> = z.object({ season: crewSeasonViewSchema });

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

// Partner records (analytics spec 2026-07-21 §5): four-ball pairs, both current roster members —
// `nameA`/`nameB` resolved from the roster the SAME way SeasonStandingLine.name is
// (getSeasonStandings.ts's own nameByGolfer), never the snapshot's own participant name. Shared
// by SeasonStandingsResponse (season-scoped) and CrewRecordsResponse (all-time) below — one
// shape, never redeclared.
export interface PartnerStandingRecord {
  readonly a: GolferId;
  readonly b: GolferId;
  readonly nameA: string;
  readonly nameB: string;
  readonly wins: number;
  readonly losses: number;
  readonly halves: number;
}
const partnerStandingRecordSchema: z.ZodType<PartnerStandingRecord> = z.object({
  a: golferIdSchema,
  b: golferIdSchema,
  nameA: z.string(),
  nameB: z.string(),
  wins: z.number().int(),
  losses: z.number().int(),
  halves: z.number().int(),
});

// Season superlatives (analytics spec 2026-07-21 §5): computed on read over the season's counted
// snapshots, nothing stored. `lowestNet` is the single lowest per-member net average (ties share
// the entry, `golfers` naming all of them) — ABSENT, not zeroed, when nobody has ≥3 qualifying
// rounds. `mostImproved` is domain's own `mostImproved()` fold verbatim (every member whose swng
// index dropped between the season's first and last counted round, ranked biggest-drop-first),
// each entry given a roster name — ABSENT (never `[]`) when nobody qualifies, e.g. an empty
// season or a season where no member has an index at both ends.
export interface SeasonSuperlatives {
  readonly lowestNet?: {
    readonly holes: 9 | 18;
    readonly average: number;
    readonly rounds: number;
    readonly golfers: readonly { readonly golferId: GolferId; readonly name: string }[];
  };
  readonly mostImproved?: readonly { readonly golferId: GolferId; readonly name: string; readonly from: number; readonly to: number }[];
}
const seasonSuperlativesSchema: z.ZodType<SeasonSuperlatives> = z.object({
  lowestNet: z
    .object({
      holes: z.union([z.literal(9), z.literal(18)]),
      average: z.number(),
      rounds: z.number().int(),
      golfers: z.array(z.object({ golferId: golferIdSchema, name: z.string() })).readonly(),
    })
    .optional(),
  mostImproved: z
    .array(z.object({ golferId: golferIdSchema, name: z.string(), from: z.number(), to: z.number() }))
    .readonly()
    .optional(),
});

// Standings are computed on read (spec §4): the counted snapshots folded through the SAME
// domain crewContribution/aggregateSeason the M8 projector used — no stored ledger. `partners`/
// `superlatives` (analytics spec §5) grow the same read, over the SAME archives/memberIds.
export interface SeasonStandingsResponse {
  readonly seasonId: string;
  readonly name: string;
  readonly status: "open" | "closed";
  readonly rounds: readonly CountedRoundView[]; // newest-first by finalizedAt
  readonly ledger: readonly SeasonStandingLine[];
  readonly headToHead: readonly HeadToHeadRecord[];
  readonly partners: readonly PartnerStandingRecord[];
  readonly superlatives: SeasonSuperlatives;
}
export const seasonStandingsResponseSchema: z.ZodType<SeasonStandingsResponse> = z.object({
  seasonId: z.string(),
  name: z.string(),
  status: z.enum(["open", "closed"]),
  rounds: z.array(countedRoundViewSchema).readonly(),
  ledger: z.array(seasonStandingLineSchema).readonly(),
  headToHead: z.array(headToHeadRecordSchema).readonly(),
  partners: z.array(partnerStandingRecordSchema).readonly(),
  superlatives: seasonSuperlativesSchema,
});

// GET /crews/{crewId}/records (analytics spec 2026-07-21 §5): all-time — every counted round
// across every season, deduped by roundId (the SAME round counted twice contributes once),
// folded through the SAME roster-filter + aggregateSeason composition as standings above, plus
// `titles` (each CLOSED season's Stableford points leader(s) under the current-roster filter —
// included only when non-empty; an open season, or a closed one with a scoreless/tied-at-zero
// ledger, contributes no entry).
export interface CrewRecordsResponse {
  readonly rounds: number; // distinct counted rounds all-time
  readonly ledger: readonly SeasonStandingLine[];
  readonly headToHead: readonly HeadToHeadRecord[];
  readonly partners: readonly PartnerStandingRecord[];
  readonly titles: readonly { readonly seasonId: string; readonly name: string; readonly golfers: readonly { readonly golferId: GolferId; readonly name: string }[] }[];
}
export const crewRecordsResponseSchema: z.ZodType<CrewRecordsResponse> = z.object({
  rounds: z.number().int(),
  ledger: z.array(seasonStandingLineSchema).readonly(),
  headToHead: z.array(headToHeadRecordSchema).readonly(),
  partners: z.array(partnerStandingRecordSchema).readonly(),
  titles: z.array(z.object({ seasonId: z.string(), name: z.string(), golfers: z.array(z.object({ golferId: golferIdSchema, name: z.string() })).readonly() })).readonly(),
});

export interface LeaveCrewResponse {
  readonly crewId: CrewId;
}
export const leaveCrewResponseSchema: z.ZodType<LeaveCrewResponse> = z.object({ crewId: crewIdSchema });

// Crew membership (invited in, accountable out — spec §1): the organizer's authority.
// DELETE /crews/{crewId}/members/{golferId} (remove) takes NO body — the target rides the path,
// same "path param, no schema" shape as DELETE /crews/{crewId}/seasons/{seasonId}/rounds/{roundId}
// (removeCountedRound) — so it needs no request schema here. Both mutations return the crew's
// OWN updated view (getCrewResponseSchema/GetCrewResponse) — the organizer stays authorized to
// see the roster they just changed, same "produces the crew" shape as createCrew/getCrew/
// joinCrewByInvite, unlike leaveCrew's minimal `{ crewId }` (the leaver's own authorization to
// view the crew ends with the act).
export const transferOrganizerRequestSchema = z.object({ golferId: golferIdSchema }).strict();
export type TransferOrganizerRequest = z.infer<typeof transferOrganizerRequestSchema>;
