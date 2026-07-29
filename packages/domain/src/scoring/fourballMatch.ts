import type { GolferId } from "../ids.js";
import type { RoundState } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { gameStrokeAllocation } from "./allocation.js";
import type { GameConfig, GameState } from "./game.js";
import type { HoleWinner } from "./matchLadder.js";
import { matchLadder } from "./matchLadder.js";
import { playerTeeSet } from "./players.js";

type FourballMatchConfig = Extract<GameConfig, { kind: "fourball-match" }>;

export const scoreFourballMatch = (config: FourballMatchConfig, state: RoundState): GameState => {
  const golfers: readonly GolferId[] = [...config.a, ...config.b];

  // The game's own field, off the ONE rule (spec §3): all four play off the lowest of the four —
  // the four-ball 90% discount is deleted with the rest of the allowance table, so this is now
  // the full difference. The per-player playing-handicap-then-subtract-the-low walk this replaced
  // was that same relative arithmetic, spelled a second time.
  const allocation = gameStrokeAllocation(config, state.participants, state.card);

  // Course card order is shared; hole numbers, not tee choice, drive it.
  const { teeSet: cardTeeSet } = playerTeeSet(state, golfers[0]!);
  const holeCount = cardTeeSet.holes.length;

  const netFor = (golferId: GolferId, holeNumber: number): number | undefined => {
    const cell = cellAt(state.cells, golferId, holeNumber);
    if (!cell || cell.result.kind !== "strokes") return undefined; // absent/picked-up/conceded: that player is out of the hole
    return cell.result.strokes - (allocation.get(golferId)?.get(holeNumber) ?? 0);
  };

  // A side's ball for the hole is the best (lowest) net among its players still
  // in the hole; undefined only when both partners are out (picked up/conceded).
  const sideBest = (side: readonly [GolferId, GolferId], holeNumber: number): number | undefined => {
    const nets = side.map((golferId) => netFor(golferId, holeNumber)).filter((net): net is number => net !== undefined);
    return nets.length > 0 ? Math.min(...nets) : undefined;
  };

  const winners: (HoleWinner | undefined)[] = cardTeeSet.holes.map((hole): HoleWinner | undefined => {
    // A hole is decided once all four players have a recorded cell — picked-up/conceded
    // still counts as recorded (it drops that player's ball, not the hole itself).
    const allFourRecorded = golfers.every((golferId) => cellAt(state.cells, golferId, hole.number) !== undefined);
    if (!allFourRecorded) return undefined;

    const bestA = sideBest(config.a, hole.number);
    const bestB = sideBest(config.b, hole.number);

    // A side with no ball (both picked up) loses to a side that has one; halves if neither does.
    if (bestA !== undefined && (bestB === undefined || bestA < bestB)) return "a";
    if (bestB !== undefined && (bestA === undefined || bestB < bestA)) return "b";
    return "halved";
  });

  const ladder = matchLadder(winners, holeCount);

  // The trail is exactly the prefix the ladder consumed (thru): every entry inside it is
  // defined (the ladder stops at the first undefined), hence the non-null assertion.
  const holes = cardTeeSet.holes.slice(0, ladder.thru).map((hole, i) => ({ hole: hole.number, winner: winners[i]! }));

  return {
    kind: "fourball-match",
    id: config.id,
    up: ladder.up,
    ...(ladder.leader ? { leader: ladder.leader } : {}),
    thru: ladder.thru,
    remaining: ladder.remaining,
    dormie: ladder.dormie,
    holes,
    ...(ladder.outcome ? { outcome: ladder.outcome } : {}),
  };
};
