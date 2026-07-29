import type { RoundState } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { gameStrokeAllocation } from "./allocation.js";
import type { GameConfig, GameState } from "./game.js";
import { allPlayersComplete, playerTeeSet } from "./players.js";

type StablefordConfig = Extract<GameConfig, { kind: "stableford" }>;

export const scoreStableford = (config: StablefordConfig, state: RoundState): GameState => {
  // The game's own field, off the ONE rule (spec §3) — computed once for the whole game, not per
  // player and not per hole (see dotsByHole's doc comment). Stableford is always net: it is a
  // handicap format by construction, so it has no gross arm to choose.
  const allocation = gameStrokeAllocation(config, state.participants, state.card);
  const lines = config.players.map((golferId) => {
    const { teeSet } = playerTeeSet(state, golferId);
    const dots = allocation.get(golferId)!;

    let points = 0;
    let thru = 0;

    for (const hole of teeSet.holes) {
      const cell = cellAt(state.cells, golferId, hole.number);
      if (!cell) continue;
      thru += 1;

      // Picked-up/conceded holes score zero points outright — they're still a
      // decided hole (counted in thru), just one worth nothing, unlike stroke
      // play's net double bogey resolution which never applies here.
      if (cell.result.kind === "strokes") {
        const net = cell.result.strokes - (dots.get(hole.number) ?? 0);
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
