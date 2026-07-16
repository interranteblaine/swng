import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { CourseId, GolferId, RoundId } from "../ids.js";
import type { RoundArchive } from "../round/archive.js";
import { cellKey } from "../round/state.js";

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
  readonly par: number;            // sum of the frozen tee's hole pars (spec §5)
  readonly courseHandicap: number; // participant.courseHandicap, frozen at join
  readonly ags?: number;
  readonly differential?: number;
  readonly distribution: {
    readonly eagles: number;
    readonly birdies: number;
    readonly pars: number;
    readonly bogeys: number;
    readonly doublePlus: number;
  };
}

export const archiveGolferLine = (archive: RoundArchive, golferId: GolferId): GolferRoundLine => {
  const participant = archive.participants.find((p) => p.golferId === golferId);
  if (!participant) throw new DomainError("unknown-participant", `no participant "${golferId}" in this archive`);
  const teeSet = findTeeSet(archive.card, participant.tee);
  const handicapping = archive.handicapping.find((h) => h.golferId === golferId);

  // Par-relative buckets over DECIDED stroke cells only — a picked-up/conceded hole never
  // holed out (no stroke count to compare against par) and an unscored hole is silence,
  // not a zero; both count nowhere, per the hand-pinned distribution this mirrors.
  const distribution = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };
  for (const hole of teeSet.holes) {
    const cell = archive.cells[cellKey(golferId, hole.number)];
    if (!cell || cell.result.kind !== "strokes") continue;
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
    courseHandicap: participant.courseHandicap,
    ...(handicapping?.kind === "complete" ? { ags: handicapping.ags, differential: handicapping.differential } : {}),
    ...(handicapping?.kind === "unrated" ? { ags: handicapping.ags } : {}),
    distribution,
  };
};
