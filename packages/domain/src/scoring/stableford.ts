import { scoredStrokes } from "../round/holeResult.js";
import type { RoundState } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { gameStrokeAllocation } from "./allocation.js";
import type { GameConfig, GameState, StablefordLine } from "./game.js";
import { allPlayersComplete, playerTeeSet } from "./players.js";

type StablefordConfig = Extract<GameConfig, { kind: "stableford" }>;

export const scoreStableford = (config: StablefordConfig, state: RoundState): GameState => {
  // Stableford is a MEDAL kind (spec 2026-07-30 §3): each player's own roster number, so its dots
  // always agree with the card. Computed once for the whole game, not per player and not per hole
  // (see dotsByHole's doc comment). Stableford is always net: it is a
  // handicap format by construction, so it has no gross arm to choose.
  const allocation = gameStrokeAllocation(config, state.participants, state.card, state.holes);
  const lines = config.players.map((golferId) => {
    const { holes } = playerTeeSet(state, golferId);
    // `?.` below, not a `!` here — symmetric with strokePlay/skins, which read the same map. Safe
    // either way today (stableford is always net, so the allocation always has an entry for every
    // member), but a `!` in one engine and a `?.` in two invites a copy-paste into a kind that DOES
    // have a gross arm, where the allocation is empty by design.
    const dots = allocation.get(golferId);

    let points = 0;
    let thru = 0;

    for (const hole of holes) {
      const cell = cellAt(state.cells, golferId, hole.number);
      if (!cell) continue;
      thru += 1;

      // Picked-up is the only kind that scores zero points outright: still a decided hole
      // (counted in thru), just one worth nothing, unlike stroke play's net double bogey
      // resolution which never applies here.
      const strokes = scoredStrokes(cell.result);
      if (strokes !== undefined) {
        const net = strokes - (dots?.get(hole.number) ?? 0);
        points += Math.max(0, 2 + hole.par - net);
      }
    }

    return { golferId, thru, points };
  });

  const complete = allPlayersComplete(state, config.players);

  // Leader(s) — highest points, ties included (see game.ts's `leaders` doc).
  const highest = lines.length > 0 ? Math.max(...lines.map((line) => line.points)) : undefined;
  const leaders = lines.filter((line) => line.points === highest).map((line) => line.golferId);

  return { kind: "stableford", id: config.id, lines, complete, leaders };
};

// Points descending — the leaderboard order, extracted from GamePanel.tsx (the web) in task-5's
// fix round (spec 2026-07-30 §10 review): a ranking rule is golf logic, the same class
// `aggregateSeason` already moved server-side for crew standings, so it belongs here, one
// implementation, called through @swng/client. Returns a NEW array (never mutates `lines`).
export const sortedStablefordLines = (lines: readonly StablefordLine[]): readonly StablefordLine[] => [...lines].sort((a, b) => b.points - a.points);
