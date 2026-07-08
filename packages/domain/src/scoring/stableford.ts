import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { RoundState } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState } from "./game.js";
import { dotsByHole } from "./strokes.js";

type StablefordConfig = Extract<GameConfig, { kind: "stableford" }>;

export const scoreStableford = (config: StablefordConfig, state: RoundState): GameState => {
  const lines = config.players.map((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) throw new DomainError("unknown-participant", `no participant ${golferId} joined this round`);
    const teeSet = findTeeSet(state.card, participant.tee);
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

  const complete = config.players.every((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) return false;
    const teeSet = findTeeSet(state.card, participant.tee);
    return teeSet.holes.every((hole) => state.cells[cellKey(golferId, hole.number)] !== undefined);
  });

  return { kind: "stableford", id: config.id, lines, complete };
};
