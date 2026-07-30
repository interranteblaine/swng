import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { CourseId, GolferId, RoundId } from "../ids.js";
import type { RoundArchive } from "../round/archive.js";
import type { DecidedHoleResult } from "../round/holeResult.js";
import { scoredStrokes } from "../round/holeResult.js";
import { cellAt } from "../round/state.js";
import { hasCompleteScore, scoreOf } from "./analytics.js";

// One decided hole from the frozen card (analytics spec 2026-07-21 §2) — par is the card's
// par for that hole AS PLAYED, so a later card supersession never rewrites a historical line.
export interface GolferHoleLine {
  readonly hole: number;
  readonly par: number;
  readonly result: DecidedHoleResult;
}

// What one archive contributes to one golfer's permanent record — the per-round line a
// history view lists and the projector folds over (architecture.md §2's "everything counts").
export interface GolferRoundLine {
  readonly roundId: RoundId;
  readonly courseName: string;
  readonly courseId?: CourseId;
  readonly tee: string;
  readonly holes: 9 | 18;
  readonly par: number; // sum of the frozen tee's hole pars (spec §5)
  // The strokes this player actually played off: `participant.strokes`, the value reduceRound
  // derived across the round's roster and settleRound froze (spec 2026-07-29 §2b).
  readonly strokes: number;
  // What they STATED, when they stated a normal score — absent when they stated raw strokes
  // instead (spec §2a's second constructor). The assertion beside its consequence: `strokes` is
  // what the fold made of it against the rest of the field.
  readonly normallyShoots?: number;
  // The round's own gross total, present iff every hole carries a number (`hasCompleteScore`).
  // LOAD-BEARING, not tidiness: `holeResults` never rides the wire, so without this a history row
  // would have no score to render at all. Absent means the card has a pickup or a gap — there is
  // no score, and none is invented.
  readonly score?: number;
  readonly distribution: {
    readonly eagles: number;
    readonly birdies: number;
    readonly pars: number;
    readonly bogeys: number;
    readonly doublePlus: number;
  };
  // The player's hole-by-hole facts from the frozen card (analytics spec 2026-07-21 §2):
  // decided cells only via cellAt (unscored + cleared omitted), card order, par frozen at play
  // time — a later card supersession never rewrites a historical line. OPTIONAL because lines
  // written before this field exist until one rebuildProjections run backfills them; readers
  // exclude such lines from hole-based stats with honest sample counts, never throw.
  readonly holeResults?: readonly GolferHoleLine[];
}

export const archiveGolferLine = (archive: RoundArchive, golferId: GolferId): GolferRoundLine => {
  const participant = archive.participants.find((p) => p.golferId === golferId);
  if (!participant) throw new DomainError("unknown-participant", `no participant "${golferId}" in this archive`);
  const teeSet = findTeeSet(archive.card, participant.tee);

  // Par-relative buckets over every DECIDED cell that carries a NUMBER — a `strokes` cell. A
  // picked-up hole has no number to compare against par at all, and an unscored hole is silence,
  // not a zero; both stay out.
  const distribution = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };
  const holeResults: GolferHoleLine[] = [];
  for (const hole of teeSet.holes) {
    const cell = cellAt(archive.cells, golferId, hole.number);
    if (!cell) continue;
    if (cell.result.kind === "cleared") continue; // unreachable (cellAt hides cleared) — narrows the type
    holeResults.push({ hole: hole.number, par: hole.par, result: cell.result });
    const strokes = scoredStrokes(cell.result);
    if (strokes === undefined) continue;
    const relativeToPar = strokes - hole.par;
    if (relativeToPar <= -2) distribution.eagles += 1;
    else if (relativeToPar === -1) distribution.birdies += 1;
    else if (relativeToPar === 0) distribution.pars += 1;
    else if (relativeToPar === 1) distribution.bogeys += 1;
    else distribution.doublePlus += 1;
  }

  const line: GolferRoundLine = {
    roundId: archive.roundId,
    courseName: archive.card.courseName,
    // spec §4: recorded from day one because it cannot be backfilled; absent on pre-scrap archives.
    ...(archive.card.source ? { courseId: archive.card.source.courseId } : {}),
    tee: participant.tee,
    // course.ts's validateTeeSet is the one gate every tee set passes before it can ever
    // reach a round (validateCard/buildCardRecord reject anything else), so this length is
    // always 9 or 18 by construction — the cast documents that upstream invariant rather
    // than re-checking it here.
    holes: teeSet.holes.length as 9 | 18,
    par: teeSet.holes.reduce((sum, hole) => sum + hole.par, 0),
    strokes: participant.strokes,
    ...(participant.basis.kind === "normally-shoots" ? { normallyShoots: participant.basis.overPar } : {}),
    distribution,
    holeResults,
  };

  // `score` is added on top of the finished line rather than computed inline, so the ONE
  // predicate/sum pair the average itself uses (analytics.ts) decides it here too — a second
  // hand-rolled "is this card complete" here is exactly the two-copy drift the arc deletes.
  return hasCompleteScore(line) ? { ...line, score: scoreOf(line) } : line;
};
