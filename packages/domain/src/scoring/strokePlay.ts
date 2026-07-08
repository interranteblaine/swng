import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { RoundState } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState, RunningTotal } from "./game.js";
import { dotsByHole, netDoubleBogey } from "./strokes.js";

type StrokePlayConfig = Extract<GameConfig, { kind: "stroke-play" }>;

export const scoreStrokePlay = (config: StrokePlayConfig, state: RoundState): GameState => {
  const lines = config.players.map((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) throw new DomainError("unknown-participant", `no participant ${golferId} joined this round`);
    const teeSet = findTeeSet(state.card, participant.tee);
    // Net needs a playing handicap even when nobody has picked up yet; computed
    // once per player rather than per hole.
    const playingHcp = config.scoring === "net" ? playingHandicap(participant.courseHandicap, config.allowance ?? defaultAllowance("stroke-play")) : 0;
    // One allocation for the whole card, not one per hole (see dotsByHole's doc comment).
    const dots = config.scoring === "net" ? dotsByHole(playingHcp, teeSet) : undefined;

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
        if (dots) {
          netTotal += cell.result.strokes - (dots.get(hole.number) ?? 0);
        }
      } else {
        // Picked-up/conceded holes have no gross number, but net still resolves
        // them at net double bogey (par + 2) so a running net total never stalls.
        grossPickups += 1;
        if (dots) {
          const holeDots = dots.get(hole.number) ?? 0;
          netTotal += netDoubleBogey(hole.par, holeDots) - holeDots;
        }
      }
    }

    const gross: RunningTotal = { total: grossTotal, pickups: grossPickups };
    // net.pickups is always 0, not tracked like gross.pickups: a pickup only makes
    // the GROSS total partial. Net resolves every picked-up/conceded hole at net
    // double bogey above, so a net total is never partial — that's the rule (WHS
    // net double bogey exists precisely to give picked-up holes a definite net
    // score), not a field we forgot to populate.
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
