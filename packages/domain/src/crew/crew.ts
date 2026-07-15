import { DomainError } from "../errors.js";
import type { CrewId, GolferId } from "../ids.js";

// A crew is a boring, non-event-sourced entity (architecture.md §"Crew — plain entity, no
// event sourcing") — no fold, no log, just direct mutation-as-a-new-value the way
// course.ts's Course is treated. "organizer" carries no extra authority in v1 (that lands
// with application-layer authorization); it's recorded now so it can be surfaced/enforced
// later without a data migration.
export type CrewRole = "organizer" | "member";

export interface CrewMember {
  readonly golferId: GolferId;
  readonly name: string;
  readonly role: CrewRole;
}

// A crew is a grouping/competition ONLY (owner ruling, spec §11a, 2026-07-13) — no standing
// game, no crew-consent seating. The old "play the usual" preset (StandingGame,
// applyStandingGame, referencedGolferIds) is deleted outright, not deprecated: a crew's own
// stored document on beta may still carry a stray `standingGame` attribute from before this
// change (adapters-dynamodb's createDynamoCrewStore.ts tolerates it on read — never a
// migration script), but nothing in this codebase reads or writes one anymore.
export interface Crew {
  readonly id: CrewId;
  readonly name: string;
  readonly members: readonly CrewMember[];
}

const MIN_MEMBER_NAME_LENGTH = 1;
// M9 hardening (papercut 9): mirrors course.ts's validateCourseName exactly (trimmed,
// 1-N characters) — domain is the honest layer, so THIS is where a crew's name is actually
// held to a bound, not just the wire's own `.min(1)` (which never trims and has no upper
// bound at all).
const MAX_CREW_NAME_LENGTH = 60;

// Called by createCrew.ts (application) before a Crew is ever constructed — there is no
// domain-level `createCrew` factory the way course.ts has `buildCardRecord` (a crew is built by
// addMember calls directly, application/src/crews/createCrew.ts's own doc comment), so this
// validator is exported for that call site rather than invoked internally here.
export const validateCrewName = (name: string): void => {
  if (name.trim().length === 0 || name.length > MAX_CREW_NAME_LENGTH) {
    throw new DomainError("invalid-crew-name", `crew name must be 1-${MAX_CREW_NAME_LENGTH} characters: "${name}"`);
  }
};

// Membership is a roster of golferIds — addMember is a pure roster operation and doesn't care
// whether a sub is bound to the id (the account-only rule is enforced in application, not here).
export const addMember = (crew: Crew, member: CrewMember): Crew => {
  if (member.name.trim().length < MIN_MEMBER_NAME_LENGTH) {
    throw new DomainError("invalid-member-name", `member name must be at least ${MIN_MEMBER_NAME_LENGTH} character(s): "${member.name}"`);
  }
  if (crew.members.some((existing) => existing.golferId === member.golferId)) {
    throw new DomainError("duplicate-member", `golfer "${member.golferId}" is already a member of crew "${crew.id}"`);
  }
  return { ...crew, members: [...crew.members, member] };
};

// Crew membership (invited in, accountable out — spec §1): the organizer's authority, half one
// (remove). A pure roster op, same shape as addMember — WHO may call this (organizer-only) is
// application's job (removeCrewMember.ts's requireCrewMember + role check), never checked here.
// Removing an absent golferId is not-a-member (same code requireCrewMember's own 403 uses — a
// golferId with no standing on this roster, whether that's the caller or a named target); the
// organizer is immovable — transfer the role first (transferOrganizer below).
export const removeMember = (crew: Crew, golferId: GolferId): Crew => {
  const target = crew.members.find((member) => member.golferId === golferId);
  if (!target) throw new DomainError("not-a-member", `golfer "${golferId}" is not a member of crew "${crew.id}"`);
  if (target.role === "organizer") {
    throw new DomainError("organizer-immovable", `the organizer of crew "${crew.id}" cannot be removed — transfer the role first`);
  }
  return { ...crew, members: crew.members.filter((member) => member.golferId !== golferId) };
};

// The organizer's authority, half two (transfer). A role flip in the members array — order is
// preserved (map, not filter+push), and exactly one organizer survives by construction: every
// OTHER member is forced to "member" in the same pass that promotes the target (golferIds are
// unique on a roster, addMember's own duplicate-member guard). Transferring to the CURRENT
// organizer is a harmless no-op, not a special case. The target must already be a member —
// same not-a-member code removeMember uses for the identical "golferId isn't on this roster"
// shape.
export const transferOrganizer = (crew: Crew, toGolferId: GolferId): Crew => {
  if (!crew.members.some((member) => member.golferId === toGolferId)) {
    throw new DomainError("not-a-member", `golfer "${toGolferId}" is not a member of crew "${crew.id}"`);
  }
  return {
    ...crew,
    members: crew.members.map((member) => ({ ...member, role: member.golferId === toGolferId ? "organizer" : "member" })),
  };
};
