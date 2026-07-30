import { scoredStrokes } from "../round/holeResult.js";
import type { RoundState } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { gameStrokeAllocation } from "./allocation.js";
import type { GameConfig, GameState, SkinsHole } from "./game.js";
import { allPlayersComplete, playerTeeSet } from "./players.js";

type SkinsConfig = Extract<GameConfig, { kind: "skins" }>;

export const scoreSkins = (config: SkinsConfig, state: RoundState): GameState => {
  // The game's own field, off the ONE rule (spec §3) — computed once for the whole game, not per
  // player and not per hole (see dotsByHole's doc comment). A GROSS pot's allocation is EMPTY, so
  // `dots` below comes out undefined and every net reads the raw score: the gross rule is decided
  // in one place (gameStrokeAllocation) rather than re-tested here.
  const allocation = gameStrokeAllocation(config, state.participants, state.card);
  const players = config.players.map((golferId) => {
    const { teeSet } = playerTeeSet(state, golferId);
    return { golferId, teeSet, dots: allocation.get(golferId) };
  });

  // Course card order is shared; hole numbers, not tee choice, drive it — so any
  // player's tee set supplies the sequence the carryover chain walks.
  const holes = players[0]?.teeSet.holes ?? [];

  const skinsWon = new Map(config.players.map((golferId) => [golferId, 0]));
  const trail: SkinsHole[] = [];
  let carrying = 0;
  let holesDecided = 0;

  for (const hole of holes) {
    const cells = players.map((player) => ({ player, cell: cellAt(state.cells, player.golferId, hole.number) }));
    // Skins settle sequentially — the pot riding out of this hole feeds the next
    // one, so the chain cannot skip an undecided hole (a hole is decided only
    // once EVERY player has a cell): stop at the first gap, like the match ladder.
    if (cells.some(({ cell }) => cell === undefined)) break;
    holesDecided += 1;

    const pot = 1 + carrying;
    // Picked-up is the only kind that's out of the hole entirely.
    const nets = cells.flatMap(({ player, cell }) => {
      const strokes = scoredStrokes(cell!.result);
      return strokes !== undefined ? [{ golferId: player.golferId, net: strokes - (player.dots?.get(hole.number) ?? 0) }] : [];
    });

    const lowest = Math.min(...nets.map(({ net }) => net));
    const winners = nets.filter(({ net }) => net === lowest);
    if (winners.length === 1) {
      const winner = winners[0]!.golferId;
      skinsWon.set(winner, skinsWon.get(winner)! + pot);
      trail.push({ hole: hole.number, winner, pot });
      carrying = 0;
    } else {
      // A tie carries the whole pot; so does a hole where everyone picked up.
      trail.push({ hole: hole.number, pot });
      carrying = pot;
    }
  }

  const complete = allPlayersComplete(state, config.players);

  return {
    kind: "skins",
    id: config.id,
    scoring: config.scoring,
    lines: config.players.map((golferId) => ({ golferId, skins: skinsWon.get(golferId)! })),
    // Once the round is complete there is no next hole for the pot to ride into —
    // whatever is still carrying is stranded and reported as carriedOut instead.
    carrying: complete ? 0 : carrying,
    carriedOut: complete ? carrying : 0,
    complete,
    holesDecided,
    holes: trail,
  };
};
