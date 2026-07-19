import type { RoundState } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState, RunningTotal } from "./game.js";
import { allPlayersComplete, playerTeeSet } from "./players.js";
import { dotsByHole, netDoubleBogey } from "./strokes.js";

type StrokePlayConfig = Extract<GameConfig, { kind: "stroke-play" }>;

export const scoreStrokePlay = (config: StrokePlayConfig, state: RoundState): GameState => {
  const lines = config.players.map((golferId) => {
    const { participant, teeSet } = playerTeeSet(state, golferId);
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
      const cell = cellAt(state.cells, golferId, hole.number);
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

    // Par over the first `thru` holes of THIS player's own tee, in card order — not
    // necessarily the specific holes that were scored (a mid-card gap is possible; see
    // players.ts/state.ts), but the best available running baseline without exposing
    // which holes are individually decided. Scored against whichever total this game
    // scores by (net when net-scored, else gross) — the same selection `leaders` below uses.
    const parThru = teeSet.holes.slice(0, thru).reduce((sum, hole) => sum + hole.par, 0);
    const total = config.scoring === "net" ? netTotal : grossTotal;
    const relativeToPar = total - parThru;

    return { golferId, thru, gross, ...(net ? { net } : {}), relativeToPar };
  });

  const complete = allPlayersComplete(state, config.players);

  // Leader(s) by the same total selection relativeToPar used per line (net when
  // net-scored, else gross) — lowest wins, ties included.
  const totals = lines.map((line) => (config.scoring === "net" ? line.net!.total : line.gross.total));
  const lowest = totals.length > 0 ? Math.min(...totals) : undefined;
  const leaders = lines.filter((_, index) => totals[index] === lowest).map((line) => line.golferId);

  return { kind: "stroke-play", id: config.id, scoring: config.scoring, lines, complete, leaders };
};
