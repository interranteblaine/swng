import { defaultAllowance, dotsByHole, findTeeSet, playingHandicap } from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, Participant } from "@swng/domain";

// The golfer ids a GameConfig covers, in the config's own order — used both to render a
// game's roster group and to know which golfers need a dots lookup below.
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

const participantFor = (participants: readonly Participant[], id: GolferId): Participant => {
  const found = participants.find((p) => p.golferId === id);
  if (!found) throw new Error(`swng web: no participant "${id}" — state.games and state.participants disagreed`);
  return found;
};

// Per-hole dots for every player in `config`, mirroring each scoring engine's own allocation
// (packages/domain/src/scoring/{fourballMatch,singlesMatch,skins,stableford,strokePlay}.ts)
// without re-deriving match/points results, which SetupPanel has no need for pre-round —
// setup only needs "how many strokes does each player get," not who's up on hole 6.
export const gameDots = (config: GameConfig, participants: readonly Participant[], card: CourseCard): ReadonlyMap<GolferId, ReadonlyMap<number, number>> => {
  const teeSetOf = (id: GolferId) => findTeeSet(card, participantFor(participants, id).tee);
  const chOf = (id: GolferId) => participantFor(participants, id).courseHandicap;

  switch (config.kind) {
    case "stroke-play": {
      // Gross play carries no handicap allowance at all — there is nothing to allocate.
      if (config.scoring === "gross") return new Map();
      const allowance = config.allowance ?? defaultAllowance("stroke-play");
      return new Map(config.players.map((id) => [id, dotsByHole(playingHandicap(chOf(id), allowance), teeSetOf(id))]));
    }
    case "stableford":
    case "skins": {
      const allowance = config.allowance ?? defaultAllowance(config.kind);
      return new Map(config.players.map((id) => [id, dotsByHole(playingHandicap(chOf(id), allowance), teeSetOf(id))]));
    }
    case "singles-match": {
      // Relative, not each player's own course handicap — mirrors singlesMatch.ts: only the
      // higher-handicap player receives dots (chHigh - chLow), the lower plays scratch.
      const allowance = config.allowance ?? defaultAllowance("singles-match");
      const chA = chOf(config.a);
      const chB = chOf(config.b);
      const higherIsA = chA >= chB;
      const higher = higherIsA ? config.a : config.b;
      const lower = higherIsA ? config.b : config.a;
      const diff = playingHandicap(Math.abs(chA - chB), allowance);
      return new Map([
        [higher, dotsByHole(diff, teeSetOf(higher))],
        [lower, dotsByHole(0, teeSetOf(lower))],
      ]);
    }
    case "fourball-match": {
      // Relative to the lowest playing handicap among the foursome — mirrors
      // fourballMatch.ts's own allocation exactly.
      const allowance = config.allowance ?? defaultAllowance("fourball-match");
      const golfers = [...config.a, ...config.b];
      const playingHcps = new Map(golfers.map((id) => [id, playingHandicap(chOf(id), allowance)]));
      const lowHcp = Math.min(...playingHcps.values());
      return new Map(golfers.map((id) => [id, dotsByHole(playingHcps.get(id)! - lowHcp, teeSetOf(id))]));
    }
  }
};

// dotsByHole's allocation always sums exactly to its input strokes value (allocateStrokes'
// own documented invariant in packages/domain/src/scoring/strokes.ts) — summing here is safe
// rather than re-deriving a parallel "total dots" formula that could drift from the per-hole
// one above.
export const totalDots = (perHole: ReadonlyMap<number, number>): number => [...perHole.values()].reduce((sum, dots) => sum + dots, 0);
