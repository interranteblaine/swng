import type { RoundState, ScoreCell } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig, GameState } from "./game.js";
import type { HoleWinner } from "./matchLadder.js";
import { matchLadder } from "./matchLadder.js";
import { playerTeeSet } from "./players.js";
import { dotsByHole } from "./strokes.js";

type SinglesMatchConfig = Extract<GameConfig, { kind: "singles-match" }>;

export const scoreSinglesMatch = (config: SinglesMatchConfig, state: RoundState): GameState => {
  const { participant: participantA, teeSet: teeSetA } = playerTeeSet(state, config.a);
  const { participant: participantB, teeSet: teeSetB } = playerTeeSet(state, config.b);

  // Match strokes are relative, not each player's own course handicap: only the
  // higher-handicap player receives dots (chHigh - chLow), the lower plays scratch.
  const allowance = config.allowance ?? defaultAllowance("singles-match");
  const higherIsA = participantA.courseHandicap >= participantB.courseHandicap;
  const higher = higherIsA ? participantA : participantB;
  const lower = higherIsA ? participantB : participantA;
  const higherTeeSet = higherIsA ? teeSetA : teeSetB;
  const diff = playingHandicap(higher.courseHandicap - lower.courseHandicap, allowance);
  // One allocation for the whole card, not one per hole (see dotsByHole's doc comment).
  const higherDots = dotsByHole(diff, higherTeeSet);

  // Net for the higher player subtracts their dots on the hole; the lower player
  // always plays scratch (0 dots).
  const netFor = (isHigher: boolean, cell: ScoreCell | undefined, holeNumber: number): number | undefined => {
    if (!cell || cell.result.kind !== "strokes") return undefined; // absent/picked-up/conceded
    const dots = isHigher ? (higherDots.get(holeNumber) ?? 0) : 0;
    return cell.result.strokes - dots;
  };

  const cardTeeSet = teeSetA; // course card order is shared; hole numbers, not tee choice, drive it
  const holeCount = cardTeeSet.holes.length;

  // Per-hole winner in the ladder's "a"/"b" vocabulary (config.a is always "a"
  // here) — undefined when either side hasn't posted a cell yet.
  const winners: (HoleWinner | undefined)[] = cardTeeSet.holes.map((hole): HoleWinner | undefined => {
    const cellA = state.cells[cellKey(config.a, hole.number)];
    const cellB = state.cells[cellKey(config.b, hole.number)];
    if (!cellA || !cellB) return undefined;

    const netA = netFor(higherIsA, cellA, hole.number);
    const netB = netFor(!higherIsA, cellB, hole.number);

    // picked-up/conceded (net undefined) loses the hole outright; both → halve.
    if (netA !== undefined && (netB === undefined || netA < netB)) return "a";
    if (netB !== undefined && (netA === undefined || netB < netA)) return "b";
    return "halved";
  });

  const ladder = matchLadder(winners, holeCount);
  const golferFor = (side: "a" | "b") => (side === "a" ? config.a : config.b);

  // The trail is exactly the prefix the ladder consumed (thru): every entry inside it is
  // defined (the ladder stops at the first undefined), hence the non-null assertion.
  const holes = cardTeeSet.holes.slice(0, ladder.thru).map((hole, i) => ({ hole: hole.number, winner: winners[i]! }));

  return {
    kind: "singles-match",
    id: config.id,
    up: ladder.up,
    ...(ladder.leader ? { leader: golferFor(ladder.leader) } : {}),
    thru: ladder.thru,
    remaining: ladder.remaining,
    dormie: ladder.dormie,
    holes,
    ...(ladder.outcome
      ? { outcome: "halved" in ladder.outcome ? ladder.outcome : { winner: golferFor(ladder.outcome.winner), closing: ladder.outcome.closing } }
      : {}),
  };
};
