import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { RoundState } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState, RunningTotal } from "./game.js";
import { netDoubleBogey, strokesReceivedOnHole } from "./strokes.js";

type StrokePlayConfig = Extract<GameConfig, { kind: "stroke-play" }>;

export const scoreStrokePlay = (config: StrokePlayConfig, state: RoundState): GameState => {
  const lines = config.players.map((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) throw new DomainError("unknown-participant", `no participant ${golferId} joined this round`);
    const teeSet = findTeeSet(state.card, participant.tee);
    // Net needs a playing handicap even when nobody has picked up yet; computed
    // once per player rather than per hole.
    const playingHcp = config.scoring === "net" ? playingHandicap(participant.courseHandicap, config.allowance ?? defaultAllowance("stroke-play")) : 0;

    let grossTotal = 0;
    let grossPickups = 0;
    let netTotal = 0;
    let thru = 0;

    for (const hole of teeSet.holes) {
      const cell = state.cells[cellKey(golferId, hole.number)];
      if (!cell) continue;
      thru += 1;

      if (cell.result.kind === "strokes") {
        grossTotal += cell.result.strokes;
        if (config.scoring === "net") {
          const dots = strokesReceivedOnHole(playingHcp, teeSet, hole.number);
          netTotal += cell.result.strokes - dots;
        }
      } else {
        // Picked-up/conceded holes have no gross number, but net still resolves
        // them at net double bogey (par + 2) so a running net total never stalls.
        grossPickups += 1;
        if (config.scoring === "net") {
          const dots = strokesReceivedOnHole(playingHcp, teeSet, hole.number);
          netTotal += netDoubleBogey(hole.par, dots) - dots;
        }
      }
    }

    const gross: RunningTotal = { total: grossTotal, pickups: grossPickups };
    const net: RunningTotal | undefined = config.scoring === "net" ? { total: netTotal, pickups: 0 } : undefined;

    return { golferId, thru, gross, ...(net ? { net } : {}) };
  });

  const complete = config.players.every((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) return false;
    const teeSet = findTeeSet(state.card, participant.tee);
    return teeSet.holes.every((hole) => state.cells[cellKey(golferId, hole.number)] !== undefined);
  });

  return { kind: "stroke-play", id: config.id, scoring: config.scoring, lines, complete };
};
