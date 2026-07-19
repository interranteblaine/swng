import type { RoundState } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState, SkinsHole } from "./game.js";
import { allPlayersComplete, playerTeeSet } from "./players.js";
import { dotsByHole } from "./strokes.js";

type SkinsConfig = Extract<GameConfig, { kind: "skins" }>;

export const scoreSkins = (config: SkinsConfig, state: RoundState): GameState => {
  const players = config.players.map((golferId) => {
    const { participant, teeSet } = playerTeeSet(state, golferId);
    // One allocation for the whole card, not one per hole (see dotsByHole's doc comment).
    const playingHcp = playingHandicap(participant.courseHandicap, config.allowance ?? defaultAllowance("skins"));
    return { golferId, teeSet, dots: dotsByHole(playingHcp, teeSet) };
  });

  // Course card order is shared; hole numbers, not tee choice, drive it — so any
  // player's tee set supplies the sequence the carryover chain walks.
  const holes = players[0]?.teeSet.holes ?? [];

  const skinsWon = new Map(config.players.map((golferId) => [golferId, 0]));
  const trail: SkinsHole[] = [];
  let carrying = 0;
  let holesDecided = 0;

  for (const hole of holes) {
    const cells = players.map((player) => ({ player, cell: state.cells[cellKey(player.golferId, hole.number)] }));
    // Skins settle sequentially — the pot riding out of this hole feeds the next
    // one, so the chain cannot skip an undecided hole (a hole is decided only
    // once EVERY player has a cell): stop at the first gap, like the match ladder.
    if (cells.some(({ cell }) => cell === undefined)) break;
    holesDecided += 1;

    const pot = 1 + carrying;
    // Picked-up/conceded players are out of the hole; everyone else competes on net.
    const nets = cells.flatMap(({ player, cell }) =>
      cell!.result.kind === "strokes" ? [{ golferId: player.golferId, net: cell!.result.strokes - (player.dots.get(hole.number) ?? 0) }] : [],
    );

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
