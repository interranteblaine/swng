import type { RoundState } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { gameStrokeAllocation } from "./allocation.js";
import type { GameConfig, GameState, RunningTotal } from "./game.js";
import { allPlayersComplete, playerTeeSet } from "./players.js";
import { netDoubleBogey } from "./strokes.js";

type StrokePlayConfig = Extract<GameConfig, { kind: "stroke-play" }>;

export const scoreStrokePlay = (config: StrokePlayConfig, state: RoundState): GameState => {
  // The game's own field, off the ONE rule (spec §3) — computed once for the whole game, not per
  // player and not per hole (see dotsByHole's doc comment). A gross game's allocation is EMPTY, so
  // `dots` below comes out undefined and no net is accumulated: the gross rule is decided in one
  // place (gameStrokeAllocation) rather than re-tested here.
  const allocation = gameStrokeAllocation(config, state.participants, state.card);
  const lines = config.players.map((golferId) => {
    const { teeSet } = playerTeeSet(state, golferId);
    const dots = allocation.get(golferId);

    let grossTotal = 0;
    let grossPickups = 0;
    let netTotal = 0;
    let thru = 0;

    for (const hole of teeSet.holes) {
      const cell = cellAt(state.cells, golferId, hole.number);
      if (!cell) continue;
      thru += 1;

      // A conceded hole is a scored hole (spec §2d — the number the group says out loud), so it
      // joins the `strokes` branch below exactly like an ordinary score. Picked-up is the ONLY
      // kind left with no number to use — that's the one net double bogey (par + 2) still caps.
      if (cell.result.kind === "strokes" || cell.result.kind === "conceded") {
        grossTotal += cell.result.strokes;
        if (dots) {
          netTotal += cell.result.strokes - (dots.get(hole.number) ?? 0);
        }
      } else {
        // Picked-up: net still resolves it at net double bogey (par + 2) so a running net total
        // never stalls; gross has no number either, so it's tracked as a partial-total count.
        grossPickups += 1;
        if (dots) {
          const holeDots = dots.get(hole.number) ?? 0;
          netTotal += netDoubleBogey(hole.par, holeDots) - holeDots;
        }
      }
    }

    const gross: RunningTotal = { total: grossTotal, pickups: grossPickups };
    // net.pickups is always 0, not tracked like gross.pickups: a pickup only makes the GROSS
    // total partial. A conceded hole nets off its own number, same as `strokes` (spec §2d); net
    // resolves a picked-up hole at net double bogey above — so a net total is never partial
    // either way (WHS net double bogey exists precisely to give a picked-up hole a definite net
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
