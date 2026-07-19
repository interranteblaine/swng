import type { GolferId } from "../ids.js";
import type { RoundState } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState } from "./game.js";
import type { HoleWinner } from "./matchLadder.js";
import { matchLadder } from "./matchLadder.js";
import { playerTeeSet } from "./players.js";
import { dotsByHole } from "./strokes.js";

type FourballMatchConfig = Extract<GameConfig, { kind: "fourball-match" }>;

export const scoreFourballMatch = (config: FourballMatchConfig, state: RoundState): GameState => {
  const allowance = config.allowance ?? defaultAllowance("fourball-match");
  const golfers: readonly GolferId[] = [...config.a, ...config.b];

  // Playing handicap per player, then the whole foursome plays relative to the
  // lowest of the four — singles match's higher/lower relief generalized to four.
  const infos = golfers.map((golferId) => {
    const { participant, teeSet } = playerTeeSet(state, golferId);
    return { golferId, teeSet, playingHcp: playingHandicap(participant.courseHandicap, allowance) };
  });
  const lowHcp = Math.min(...infos.map((info) => info.playingHcp));
  // One allocation per player for the whole card, not one per hole (see dotsByHole's doc comment).
  const dotsByGolfer = new Map(infos.map((info) => [info.golferId, dotsByHole(info.playingHcp - lowHcp, info.teeSet)]));

  // Course card order is shared; hole numbers, not tee choice, drive it.
  const cardTeeSet = infos[0]!.teeSet;
  const holeCount = cardTeeSet.holes.length;

  const netFor = (golferId: GolferId, holeNumber: number): number | undefined => {
    const cell = state.cells[cellKey(golferId, holeNumber)];
    if (!cell || cell.result.kind !== "strokes") return undefined; // absent/picked-up/conceded: that player is out of the hole
    const dots = dotsByGolfer.get(golferId)?.get(holeNumber) ?? 0;
    return cell.result.strokes - dots;
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
    const allFourRecorded = golfers.every((golferId) => state.cells[cellKey(golferId, hole.number)] !== undefined);
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
