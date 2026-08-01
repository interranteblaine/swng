import { z } from "zod";
import type { CrewId, CrewRole, GolferId, HeadToHeadRecord, RoundId, SeasonLedgerLine } from "@swng/domain";
import { crewIdSchema, golferIdSchema, roundIdSchema } from "./ids.js";

// The wire mirror of domain's CrewRole (crew/crew.ts) — "organizer" carries no extra
// authority in v1 (same doc comment as the domain type), recorded now so it can be
// surfaced/enforced later without a data migration.
export const crewRoleSchema: z.ZodType<CrewRole> = z.enum(["organizer", "member"]);

export interface CrewMemberView {
  readonly golferId: GolferId;
  readonly name: string;
  readonly role: CrewRole;
}

export const crewMemberViewSchema: z.ZodType<CrewMemberView> = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  role: crewRoleSchema,
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
// (crewId, role, member ids) is a rejection, not a silently-dropped extra key, if a
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

// Date-only bound, "YYYY-MM-DD" — regex-pinned shape (semantic-calendar validity is domain's
// own job, seasonWindowOf's round-trip check, application/src/crews/createSeason.ts's own
// invalid-season-window guard). Shared by every season date field below.
const seasonDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Spec 2026-07-22 "the season is the record" §1: a season carries CHOSEN, VISIBLE, REQUIRED
// dates — time is its only lifecycle state (no `status`, no `closedAtMs`; "Live" vs. "Final" is
// derived on read, web-side, never stored or served). `seasonId` is an opaque server-minted id
// (never accepted from the wire), `createdAtMs` lets a client sort newest-first (the use case
// sorts too — this just carries the fact). CrewSeasonView IS CrewSeason field-for-field
// (createSeason.ts's own standing rule), no separate mapper.
export interface CrewSeasonView {
  readonly seasonId: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly startsAt: string;
  readonly endsAt: string;
}
export const crewSeasonViewSchema: z.ZodType<CrewSeasonView> = z.object({
  seasonId: z.string(),
  name: z.string(),
  createdAtMs: z.number().int(),
  startsAt: seasonDateSchema,
  endsAt: seasonDateSchema,
});

// `name` is `.min(1)` on the wire (the same non-empty floor createCrewRequestSchema uses); the
// real trimmed 1-60 bound lives in createSeason (application) — the honest layer, since a
// season isn't a domain entity. Both dates are REQUIRED — a season without a period is not a
// season (spec §1's own owner ruling: no optional/clearable bound).
export const createSeasonRequestSchema = z.object({ name: z.string().min(1), startsAt: seasonDateSchema, endsAt: seasonDateSchema }).strict();
export type CreateSeasonRequest = z.infer<typeof createSeasonRequestSchema>;

export interface CreateSeasonResponse {
  readonly season: CrewSeasonView;
}
export const createSeasonResponseSchema: z.ZodType<CreateSeasonResponse> = z.object({ season: crewSeasonViewSchema });

export interface ListSeasonsResponse {
  readonly seasons: readonly CrewSeasonView[];
}
export const listSeasonsResponseSchema: z.ZodType<ListSeasonsResponse> = z.object({ seasons: z.array(crewSeasonViewSchema).readonly() });

// PUT /crews/{crewId}/seasons/{seasonId} (spec 2026-07-22 §2): editing the end date IS the
// whole lifecycle — there is no separate close/reopen verb anymore. Every field is optional
// (absent leaves it — plain replacement values, no null semantics); the result is revalidated
// with the SAME name/window rules createSeasonRequestSchema's use case runs. Reuses
// createSeasonResponseSchema's `{ season }` shape (byte-identical — the mintParticipantToken/
// JoinRoundResponse reuse precedent, routes.ts's own doc comment) rather than a parallel type.
export const updateSeasonRequestSchema = z
  .object({ name: z.string().min(1).optional(), startsAt: seasonDateSchema.optional(), endsAt: seasonDateSchema.optional() })
  .strict();
export type UpdateSeasonRequest = z.infer<typeof updateSeasonRequestSchema>;

// PUT /crews/{crewId} (spec 2026-07-22 §2): the crew name is editable — organizer-only, no
// other crew field is mutable through it (membership has its own verbs). Reuses
// getCrewResponseSchema's `{ crew }` shape (defined above — the SAME "produces the crew" reuse
// precedent removeCrewMember/transferOrganizer already follow).
export const updateCrewRequestSchema = z.object({ name: z.string().min(1) }).strict();
export type UpdateCrewRequest = z.infer<typeof updateCrewRequestSchema>;

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
// (getSeasonStandings.ts's own nameByGolfer), never the snapshot's own participant name. Used by
// SeasonStandingsResponse below (the now-deleted all-time CrewRecordsResponse used to share this
// shape too, spec 2026-07-22 §4).
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

// The per-member scoreboard row (crew-scoreboard spec §3a/§4): the domain's own ScoreboardLine
// (crew/scoreboard.ts) plus the roster's own name (the nameByGolfer precedent every other row
// on this response already follows) — never the golfer store's name, which can drift from what
// THIS crew calls someone.
// Rounds · Average · Spread · Best (spec 2026-07-29 §6) — `index`/`indexDelta` went with the index
// itself, and `netPer18` was replaced because it was also plain wrong (it subtracted whatever
// integer was typed at join, so a player who typed a difference read several strokes better than
// the truth).
export interface ScoreboardRow {
  readonly golferId: GolferId;
  readonly name: string;
  readonly rounds: number;
  readonly average?: number;
  readonly spread?: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
}
const scoreboardRowSchema: z.ZodType<ScoreboardRow> = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  rounds: z.number().int(),
  average: z.number().optional(),
  spread: z.number().optional(),
  best18: z.object({ gross: z.number().int(), toPar: z.number().int() }).optional(),
});

// "Played together" — a derived shared round (crew-scoreboard spec §3b), the successor of the
// deleted counting apparatus' own per-round wire view (spec §2b) for THIS response's own
// `rounds` list: same `finalizedAt` wire name, but no `appendedBy` — a shared round is a fact
// nobody appended, `sharedRoundIds` derived it.
export interface SharedRoundView {
  readonly roundId: RoundId;
  readonly finalizedAt: number;
  // The canonical round designation's inputs (spec 2026-07-22 §3): courseName is REQUIRED (it is
  // required on GolferRoundLine, the line this is derived from); createdAt is OPTIONAL, matching
  // the golfer-record history line — a pre-createdAtMs line renders as its bare course name.
  readonly courseName: string;
  readonly createdAt?: number;
  // `playedAt` (spec 2026-08-01 §4c): WHEN THE GOLF HAPPENED — domain's playedAtMsOf via the
  // projection line's own `playedAtMs`, the field the crew's own season-window fold now reads
  // (crewScoreboard's `inWindow`). REQUIRED, unlike `createdAt` beside it: every projection line
  // carries a real playedAtMs (projectArchive always stamps one), so there is no legacy-line case
  // to tolerate the way there is for createdAt. `finalizedAt`/`createdAt` stay exactly the audit
  // facts they are — this is the one Task 6's "Played together" list renders from.
  readonly playedAt: number;
}
export const sharedRoundViewSchema: z.ZodType<SharedRoundView> = z.object({
  roundId: roundIdSchema,
  finalizedAt: z.number().int(),
  courseName: z.string(),
  createdAt: z.number().int().optional(),
  playedAt: z.number().int(),
});

// Standings are computed on read (crew-scoreboard spec §3/§4; window bounds per spec
// 2026-07-22 §1): the season's WINDOW (startsAt/endsAt, converted via domain's seasonWindowOf)
// fed through crewScoreboard/sharedRoundIds over each roster member's own golfer projection
// lines — no stored ledger, no counted rounds. `scoreboard` is REQUIRED (every roster member
// gets a row, `rounds: 0` included) and replaces `superlatives` outright. NO `status`/
// `closedAtMs`/title — time is the season's only lifecycle state, derived web-side, never
// served (spec 2026-07-22 §1/§3 — crowning is deleted whole).
export interface SeasonStandingsResponse {
  readonly seasonId: string;
  readonly name: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly scoreboard: readonly ScoreboardRow[];
  readonly rounds: readonly SharedRoundView[]; // newest-first by finalizedAt
  readonly ledger: readonly SeasonStandingLine[];
  readonly headToHead: readonly HeadToHeadRecord[];
  readonly partners: readonly PartnerStandingRecord[];
}
export const seasonStandingsResponseSchema: z.ZodType<SeasonStandingsResponse> = z.object({
  seasonId: z.string(),
  name: z.string(),
  startsAt: seasonDateSchema,
  endsAt: seasonDateSchema,
  scoreboard: z.array(scoreboardRowSchema).readonly(),
  rounds: z.array(sharedRoundViewSchema).readonly(),
  ledger: z.array(seasonStandingLineSchema).readonly(),
  headToHead: z.array(headToHeadRecordSchema).readonly(),
  partners: z.array(partnerStandingRecordSchema).readonly(),
});

export interface LeaveCrewResponse {
  readonly crewId: CrewId;
}
export const leaveCrewResponseSchema: z.ZodType<LeaveCrewResponse> = z.object({ crewId: crewIdSchema });

// Crew membership (invited in, accountable out — spec §1): the organizer's authority.
// DELETE /crews/{crewId}/members/{golferId} (remove) takes NO body — the target rides the
// path — so it needs no request schema here. Both mutations return the crew's
// OWN updated view (getCrewResponseSchema/GetCrewResponse) — the organizer stays authorized to
// see the roster they just changed, same "produces the crew" shape as createCrew/getCrew/
// joinCrewByInvite, unlike leaveCrew's minimal `{ crewId }` (the leaver's own authorization to
// view the crew ends with the act).
export const transferOrganizerRequestSchema = z.object({ golferId: golferIdSchema }).strict();
export type TransferOrganizerRequest = z.infer<typeof transferOrganizerRequestSchema>;
