import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { RoundState, ScoreCell } from "../round/state.js";
import { cellKey } from "../round/state.js";
import { defaultAllowance } from "./allowances.js";
import type { GameConfig, GameState, MatchOutcome } from "./game.js";
import { dotsByHole, roundHalfUp } from "./strokes.js";

type SinglesMatchConfig = Extract<GameConfig, { kind: "singles-match" }>;

export const scoreSinglesMatch = (config: SinglesMatchConfig, state: RoundState): GameState => {
  const participantA = state.participants.find((p) => p.golferId === config.a);
  const participantB = state.participants.find((p) => p.golferId === config.b);
  if (!participantA) throw new DomainError("unknown-participant", `no participant ${config.a} joined this round`);
  if (!participantB) throw new DomainError("unknown-participant", `no participant ${config.b} joined this round`);

  // Match strokes are relative, not each player's own course handicap: only the
  // higher-handicap player receives dots (chHigh - chLow), the lower plays scratch.
  const allowance = config.allowance ?? defaultAllowance("singles-match");
  const higherIsA = participantA.courseHandicap >= participantB.courseHandicap;
  const higher = higherIsA ? participantA : participantB;
  const lower = higherIsA ? participantB : participantA;
  const diff = roundHalfUp((higher.courseHandicap - lower.courseHandicap) * allowance);
  const higherTeeSet = findTeeSet(state.card, higher.tee);
  // One allocation for the whole card, not one per hole (see dotsByHole's doc comment).
  const higherDots = dotsByHole(diff, higherTeeSet);

  // Net for the higher player subtracts their dots on the hole; the lower player
  // always plays scratch (0 dots).
  const netFor = (isHigher: boolean, cell: ScoreCell | undefined, holeNumber: number): number | undefined => {
    if (!cell || cell.result.kind !== "strokes") return undefined; // absent/picked-up/conceded
    const dots = isHigher ? (higherDots.get(holeNumber) ?? 0) : 0;
    return cell.result.strokes - dots;
  };

  const cardTeeSet = findTeeSet(state.card, participantA.tee); // course card order is shared; hole numbers, not tee choice, drive it
  const holeCount = cardTeeSet.holes.length;

  let up = 0; // signed toward A: positive = A leads, negative = B leads
  let decided = 0;
  let outcome: MatchOutcome | undefined;

  for (const hole of cardTeeSet.holes) {
    if (outcome) break; // match already closed out — later holes are ignored (junk lives in other games)

    const cellA = state.cells[cellKey(config.a, hole.number)];
    const cellB = state.cells[cellKey(config.b, hole.number)];
    if (!cellA || !cellB) break; // not decided yet — card order means the rest aren't either

    const netA = netFor(higherIsA, cellA, hole.number);
    const netB = netFor(!higherIsA, cellB, hole.number);

    // picked-up/conceded (net undefined) loses the hole outright; both → halve.
    if (netA !== undefined && (netB === undefined || netA < netB)) up += 1;
    else if (netB !== undefined && (netA === undefined || netB < netA)) up -= 1;
    // else: both present and equal, or both undefined — halve, up unchanged

    decided += 1;
    const remaining = holeCount - decided;

    // Decided on the very last hole reads "N up" (or halved), never "N&0" — check
    // that before the general closeout rule, which would otherwise also match.
    if (remaining === 0) {
      outcome = up === 0 ? { halved: true } : { winner: up > 0 ? config.a : config.b, closing: `${Math.abs(up)} up` };
    } else if (Math.abs(up) > remaining) {
      outcome = { winner: up > 0 ? config.a : config.b, closing: `${Math.abs(up)}&${remaining}` };
    }
  }

  const remaining = holeCount - decided;
  const dormie = Math.abs(up) === remaining && remaining > 0;

  return {
    kind: "singles-match",
    id: config.id,
    up: Math.abs(up),
    ...(up !== 0 ? { leader: up > 0 ? config.a : config.b } : {}),
    thru: decided,
    remaining,
    dormie,
    ...(outcome ? { outcome } : {}),
  };
};
