import type { RoundState } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState } from "./game.js";
import { allPlayersComplete, playerTeeSet } from "./players.js";
import { dotsByHole } from "./strokes.js";

type StablefordConfig = Extract<GameConfig, { kind: "stableford" }>;

export const scoreStableford = (config: StablefordConfig, state: RoundState): GameState => {
  const lines = config.players.map((golferId) => {
    const { participant, teeSet } = playerTeeSet(state, golferId);
    // One allocation for the whole card, not one per hole (see dotsByHole's doc comment).
    const playingHcp = playingHandicap(participant.courseHandicap, config.allowance ?? defaultAllowance("stableford"));
    const dots = dotsByHole(playingHcp, teeSet);

    let points = 0;
    let thru = 0;

    for (const hole of teeSet.holes) {
      const cell = state.cells[cellKey(golferId, hole.number)];
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
