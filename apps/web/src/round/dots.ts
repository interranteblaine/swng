import { gameStrokeAllocation, totalDots } from "@swng/client";
import { gameMembers } from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, Participant } from "@swng/domain";

// The golfer ids a GameConfig covers, in the config's own order — used both to render a
// game's roster group and to know which golfers need a dots lookup below. A thin re-export
// of domain's own gameMembers (Task 4: this file used to carry a line-for-line-identical
// switch of its own; that duplicate is gone — there is exactly one implementation now).
export const gamePlayers = gameMembers;

// A thin delegation to the domain's gameStrokeAllocation (packages/domain/src/scoring/
// allocation.ts), reached through @swng/client — the one on-device compute seam (this arc's
// ESLint fence forbids the web importing it straight from @swng/domain). M6 Task 5 deleted this
// file's own hand-mirrored allocation arithmetic (byte-identical to the domain version, now a
// single source instead of two to keep in sync).
export const gameDots = (config: GameConfig, participants: readonly Participant[], card: CourseCard): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  gameStrokeAllocation(config, participants, card);

// A thin re-export of the domain's totalDots (packages/domain/src/scoring/allocation.ts),
// reached through @swng/client (same on-device compute seam as gameDots above) — Task 4 deleted
// this file's own reduce, which was byte-identical to the domain version.
export { totalDots };
