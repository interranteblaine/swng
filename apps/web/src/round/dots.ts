import { gameStrokeAllocation } from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, Participant } from "@swng/domain";

// The golfer ids a GameConfig covers, in the config's own order — used both to render a
// game's roster group and to know which golfers need a dots lookup below. Pure config-reading
// (no handicap arithmetic), so it stays here rather than in domain — there's nothing for
// gameStrokeAllocation below to own on its behalf.
export const gamePlayers = (config: GameConfig): readonly GolferId[] => {
  switch (config.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return config.players;
    case "singles-match":
      return [config.a, config.b];
    case "fourball-match":
      return [...config.a, ...config.b];
  }
};

// A thin delegation to domain's own gameStrokeAllocation (packages/domain/src/scoring/
// allocation.ts) — M6 Task 5 deleted this file's own hand-mirrored allocation arithmetic
// (byte-identical to the domain version, now a single source instead of two to keep in sync).
export const gameDots = (config: GameConfig, participants: readonly Participant[], card: CourseCard): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  gameStrokeAllocation(config, participants, card);

// dotsByHole's allocation always sums exactly to its input strokes value (allocateStrokes'
// own documented invariant in packages/domain/src/scoring/strokes.ts) — summing here is safe
// rather than re-deriving a parallel "total dots" formula that could drift from the per-hole
// one above.
export const totalDots = (perHole: ReadonlyMap<number, number>): number => [...perHole.values()].reduce((sum, dots) => sum + dots, 0);
