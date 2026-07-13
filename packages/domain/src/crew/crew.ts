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
// domain-level `createCrew` factory the way course.ts has `createCourse` (a crew is built by
// addMember calls directly, application/src/crews/createCrew.ts's own doc comment), so this
// validator is exported for that call site rather than invoked internally here.
export const validateCrewName = (name: string): void => {
  if (name.trim().length === 0 || name.length > MAX_CREW_NAME_LENGTH) {
    throw new DomainError("invalid-crew-name", `crew name must be 1-${MAX_CREW_NAME_LENGTH} characters: "${name}"`);
  }
};

// Membership is a roster, not a set of accounts — a golferId can be a claimed account or an
// unclaimed ghost (product.md's "even the holdout"); addMember doesn't care which.
export const addMember = (crew: Crew, member: CrewMember): Crew => {
  if (member.name.trim().length < MIN_MEMBER_NAME_LENGTH) {
    throw new DomainError("invalid-member-name", `member name must be at least ${MIN_MEMBER_NAME_LENGTH} character(s): "${member.name}"`);
  }
  if (crew.members.some((existing) => existing.golferId === member.golferId)) {
    throw new DomainError("duplicate-member", `golfer "${member.golferId}" is already a member of crew "${crew.id}"`);
  }
  return { ...crew, members: [...crew.members, member] };
};
