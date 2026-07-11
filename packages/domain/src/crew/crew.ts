import { DomainError } from "../errors.js";
import type { CourseId, CrewId, GolferId } from "../ids.js";
import type { GameConfigDraft } from "../scoring/game.js";

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

// The crew's "play the usual" preset (product.md §6). courseId/tee are optional because a
// crew can save just the game shapes before ever pinning a home course. `games` holds
// GameConfigDraft, not GameConfig — a standing game is a template with no GameId yet; the
// server mints ids when it actually seeds a round from the preset.
export interface StandingGame {
  readonly courseId?: CourseId;
  readonly tee?: string;
  readonly games: readonly GameConfigDraft[];
}

export interface Crew {
  readonly id: CrewId;
  readonly name: string;
  readonly members: readonly CrewMember[];
  readonly standingGame?: StandingGame;
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

// Mirrors game.ts's scoreGame dispatch: one entry per GameConfig kind, kept in sync with
// that union by the same exhaustiveness discipline (a runtime DomainError, not just a
// compile-time check, guards inputs that bypass the type system).
// Exported (M9 hardening, papercut 8): saveStandingGame.ts (application) reuses this SAME
// per-game extraction to validate a preset's golferIds against the crew's roster before
// saving — never a second, hand-rolled copy of this switch.
export const referencedGolferIds = (game: GameConfigDraft): readonly GolferId[] => {
  switch (game.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return game.players;
    case "singles-match":
      return [game.a, game.b];
    case "fourball-match":
      return [...game.a, ...game.b];
    default:
      throw new DomainError("unknown-game-kind", `no referenced-golfer extraction for game kind "${(game as { kind: string }).kind}"`);
  }
};

// "Play the usual" (product.md §6): a preset built for the crew's regular roster doesn't
// always match who actually showed up. A game survives iff EVERY golfer it references made
// it into today's round — a singles match missing its opponent, or a fourball missing one of
// its four, can't silently renumber itself into something the crew didn't configure; it's
// just dropped, in preset order, for the round's setup screen to reconcile (add manually,
// or leave out) rather than a partial/reassigned game landing on the card unasked.
export const applyStandingGame = (preset: StandingGame, presentGolferIds: ReadonlySet<GolferId>): readonly GameConfigDraft[] =>
  preset.games.filter((game) => referencedGolferIds(game).every((golferId) => presentGolferIds.has(golferId)));
