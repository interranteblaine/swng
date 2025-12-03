import type { Player, PlayerId, RoundSnapshot } from "@swng/domain";

export function buildScoreIndex(snapshot: RoundSnapshot): Map<string, number> {
  const index = new Map<string, number>();
  for (const score of snapshot.scores) {
    const key = `${score.playerId}:${score.holeNumber}`;
    if (typeof score.strokes === "number") {
      index.set(key, score.strokes);
    }
  }
  return index;
}

export function computeOutFromIndex(
  index: Map<string, number>,
  playerId: PlayerId
): number {
  let total = 0;
  for (let hole = 1; hole <= 9; hole++) {
    total += index.get(`${playerId}:${hole}`) ?? 0;
  }
  return total;
}

export function computeInFromIndex(
  index: Map<string, number>,
  playerId: PlayerId
): number {
  let total = 0;
  for (let hole = 10; hole <= 18; hole++) {
    total += index.get(`${playerId}:${hole}`) ?? 0;
  }
  return total;
}

export function computeTotalFromIndex(
  index: Map<string, number>,
  playerId: PlayerId
): number {
  return (
    computeOutFromIndex(index, playerId) + computeInFromIndex(index, playerId)
  );
}

export function computeParTotal(snapshot: RoundSnapshot): number {
  // Use the first 18 entries of par array per spec.
  return snapshot.config.par.slice(0, 18).reduce((acc, p) => acc + (p ?? 0), 0);
}

/**
 * Format relative to par:
 *  - delta > 0 => "+N"
 *  - delta === 0 => "E"
 *  - delta < 0 => "-N"
 */
export function formatRelative(delta: number): string {
  if (delta === 0) return "E";
  return delta > 0 ? `+${delta}` : `${delta}`;
}

export function sortPlayersByTotalFromIndex(
  index: Map<string, number>,
  players: Player[]
): Player[] {
  return players
    .map((p, idx) => ({
      p,
      total: computeTotalFromIndex(index, p.playerId),
      idx,
    }))
    .sort((a, b) => {
      if (a.total !== b.total) return a.total - b.total;
      return a.idx - b.idx;
    })
    .map((x) => x.p);
}
