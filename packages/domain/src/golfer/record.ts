import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { CourseId, GolferId, RoundId } from "../ids.js";
import type { RoundArchive } from "../round/archive.js";
import type { DecidedHoleResult } from "../round/holeResult.js";
import { cellAt } from "../round/state.js";

// One decided hole from the frozen card (analytics spec 2026-07-21 §2) — par is the card's
// par for that hole AS PLAYED, so a later card supersession never rewrites a historical line.
export interface GolferHoleLine {
  readonly hole: number;
  readonly par: number;
  readonly result: DecidedHoleResult;
}

// What one archive contributes to one golfer's permanent record — the per-round line a
// history view lists and the index projector folds over (architecture.md §2's "everything
// counts"). ags/differential are absent exactly when handicappingFor downgraded the
// golfer's card to "incomplete" (see allocation.ts) — a partial card still gets a line,
// just without a postable number.
export interface GolferRoundLine {
  readonly roundId: RoundId;
  readonly courseName: string;
  readonly courseId?: CourseId;
  readonly tee: string;
  readonly holes: 9 | 18;
  readonly par: number; // sum of the frozen tee's hole pars (spec §5)
  // The strokes this player actually played off: `participant.strokes`, the value reduceRound
  // derived across the round's roster and settleRound froze (spec 2026-07-29 §2b). Renamed to
  // `strokes` — with `normallyShoots?` beside it — by this arc's WHS-deletion task; it keeps its
  // old name here for exactly one commit so the whole wire/projection rename lands in one place.
  readonly courseHandicap: number;
  readonly ags?: number;
  readonly differential?: number;
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
  const handicapping = archive.handicapping.find((h) => h.golferId === golferId);

  // Par-relative buckets over DECIDED stroke cells only — a picked-up hole has no stroke count
  // to compare against par at all, and an unscored hole is silence, not a zero. A conceded hole
  // DOES carry a stroke count (spec §2d — a conceded hole is a scored hole everywhere), but this
  // fold doesn't count it yet either: reworking the distribution to include it is a later task's
  // job, alongside the record's own average. All three read as "not in the distribution" today,
  // per the hand-pinned buckets this mirrors.
  const distribution = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };
  const holeResults: GolferHoleLine[] = [];
  for (const hole of teeSet.holes) {
    const cell = cellAt(archive.cells, golferId, hole.number);
    if (!cell) continue;
    if (cell.result.kind === "cleared") continue; // unreachable (cellAt hides cleared) — narrows the type
    holeResults.push({ hole: hole.number, par: hole.par, result: cell.result });
    if (cell.result.kind !== "strokes") continue;
    const relativeToPar = cell.result.strokes - hole.par;
    if (relativeToPar <= -2) distribution.eagles += 1;
    else if (relativeToPar === -1) distribution.birdies += 1;
    else if (relativeToPar === 0) distribution.pars += 1;
    else if (relativeToPar === 1) distribution.bogeys += 1;
    else distribution.doublePlus += 1;
  }

  return {
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
    courseHandicap: participant.strokes,
    ...(handicapping?.kind === "complete" ? { ags: handicapping.ags, differential: handicapping.differential } : {}),
    ...(handicapping?.kind === "unrated" ? { ags: handicapping.ags } : {}),
    distribution,
    holeResults,
  };
};
