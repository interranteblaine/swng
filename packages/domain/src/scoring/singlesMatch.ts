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
  const { teeSet: cardTeeSet } = playerTeeSet(state, config.a);

  // The game's own field, off the ONE rule (spec §3) — the difference between the two, which for
  // a two-player field means only the higher number receives dots and the lower plays off
  // scratch. The higher/lower branch this replaced was that same arithmetic, spelled a second time.
  const allocation = gameStrokeAllocation(config, state.participants, state.card);

  const netFor = (golferId: GolferId, cell: ScoreCell | undefined, holeNumber: number): number | undefined => {
    // A conceded score nets exactly like `strokes` (spec §2d — scoredStrokes answers both the
    // same way); picked-up is the only kind with no number, hence the only one that's truly absent.
    const strokes = cell && scoredStrokes(cell.result);
    if (strokes === undefined) return undefined; // absent/picked-up
    return strokes - (allocation.get(golferId)?.get(holeNumber) ?? 0);
  };

  const holeCount = cardTeeSet.holes.length;

  // Per-hole winner in the ladder's "a"/"b" vocabulary (config.a is always "a"
  // here) — undefined when either side hasn't posted a cell yet.
  const winners: (HoleWinner | undefined)[] = cardTeeSet.holes.map((hole): HoleWinner | undefined => {
    const cellA = cellAt(state.cells, config.a, hole.number);
    const cellB = cellAt(state.cells, config.b, hole.number);
    if (!cellA || !cellB) return undefined;

    const netA = netFor(config.a, cellA, hole.number);
    const netB = netFor(config.b, cellB, hole.number);

    // picked-up (net undefined) loses the hole outright; both → halve. A conceded score is NOT
    // this case — netFor resolves it to a real number, so it competes on net like any other.
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
