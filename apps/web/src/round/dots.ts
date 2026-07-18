import { gameMembers, gameStrokeAllocation, totalDots } from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, Participant } from "@swng/domain";

// The golfer ids a GameConfig covers, in the config's own order — used both to render a
// game's roster group and to know which golfers need a dots lookup below. A thin re-export
// of domain's own gameMembers (Task 4: this file used to carry a line-for-line-identical
// switch of its own; that duplicate is gone — there is exactly one implementation now).
export const gamePlayers = gameMembers;

// A thin delegation to domain's own gameStrokeAllocation (packages/domain/src/scoring/
// allocation.ts) — M6 Task 5 deleted this file's own hand-mirrored allocation arithmetic
// (byte-identical to the domain version, now a single source instead of two to keep in sync).
export const gameDots = (config: GameConfig, participants: readonly Participant[], card: CourseCard): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  gameStrokeAllocation(config, participants, card);

// A thin re-export of domain's own totalDots (packages/domain/src/scoring/allocation.ts) —
// Task 4 deleted this file's own reduce, which was byte-identical to the domain version.
export { totalDots };
