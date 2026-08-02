import type { GolferId } from "../ids.js";
import { scoredStrokes } from "../round/holeResult.js";
import type { RoundState, ScoreCell } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { gameStrokeAllocation } from "./allocation.js";
import type { GameConfig, GameState } from "./game.js";
import type { HoleWinner } from "./matchLadder.js";
import { matchLadder } from "./matchLadder.js";
import { playerTeeSet } from "./players.js";

type SinglesMatchConfig = Extract<GameConfig, { kind: "singles-match" }>;

export const scoreSinglesMatch = (config: SinglesMatchConfig, state: RoundState): GameState => {
  // Course card order is shared; hole numbers, not tee choice, drive it — so either player's
  // tee set supplies the sequence the ladder walks.
  const { holes: cardHoles } = playerTeeSet(state, config.a);

  // A singles match is a MATCH kind (spec 2026-07-30 §3): played off the DIFFERENCE, so only the
  // higher number receives dots and the lower receives none — and those dots land on the HARDEST
  // holes, which is what makes this deliberately unlike the card. "Plays off scratch" would be the
  // wrong words for the lower side: they may be on 20 and simply get nothing here, not a scratch
  // golfer. The higher/lower branch this replaced was that same arithmetic, spelled a second time.
  const allocation = gameStrokeAllocation(config, state.participants, state.card, state.holes);

  const netFor = (golferId: GolferId, cell: ScoreCell | undefined, holeNumber: number): number | undefined => {
    // Picked-up is the only kind with no number, hence the only one that's truly absent.
    const strokes = cell && scoredStrokes(cell.result);
    if (strokes === undefined) return undefined; // absent/picked-up
    return strokes - (allocation.get(golferId)?.get(holeNumber) ?? 0);
  };

  const holeCount = cardHoles.length;

  // Per-hole winner in the ladder's "a"/"b" vocabulary (config.a is always "a"
  // here) — undefined when either side hasn't posted a cell yet.
  const winners: (HoleWinner | undefined)[] = cardHoles.map((hole): HoleWinner | undefined => {
    const cellA = cellAt(state.cells, config.a, hole.number);
    const cellB = cellAt(state.cells, config.b, hole.number);
    if (!cellA || !cellB) return undefined;

    const netA = netFor(config.a, cellA, hole.number);
    const netB = netFor(config.b, cellB, hole.number);

    // picked-up (net undefined) loses the hole outright; both → halve.
    if (netA !== undefined && (netB === undefined || netA < netB)) return "a";
    if (netB !== undefined && (netA === undefined || netB < netA)) return "b";
    return "halved";
  });

  const ladder = matchLadder(winners, holeCount);
  const golferFor = (side: "a" | "b") => (side === "a" ? config.a : config.b);

  // The trail is exactly the prefix the ladder consumed (thru): every entry inside it is
  // defined (the ladder stops at the first undefined), hence the non-null assertion.
  const holes = cardHoles.slice(0, ladder.thru).map((hole, i) => ({ hole: hole.number, winner: winners[i]! }));

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
