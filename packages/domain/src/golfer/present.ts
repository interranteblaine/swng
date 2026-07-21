// The course-record sentence copy, in ONE place (the `handicap/present.ts` / `scoring/present.ts`
// precedent) — pure formatters over already-computed `courseRecord` fields, no golf RESULT
// computed here, which is why the web may import them directly (fence-allowed). Copy is the
// mockup's, verbatim (artifact 7a167ca5, analytics spec 2026-07-21 §4) — including the
// typographic apostrophes.

export const worstHolePhrase = (w: { hole: number; avgOverPar: number; doublePlus: number; plays: number }): string =>
  `Hole ${w.hole} gets you — +${w.avgOverPar.toFixed(1)} a round; you’ve doubled it ${w.doublePlus} time${w.doublePlus === 1 ? "" : "s"} in ${w.plays} plays.`;

export const scoringHolePhrase = (s: { hole: number; parOrBetter: number; plays: number }): string =>
  `Hole ${s.hole} is your scoring hole — par or better in ${s.parOrBetter} of ${s.plays}.`;

export const neverBirdiedPhrase = (holes: readonly number[]): string =>
  holes.length === 1 ? `You’ve never birdied ${holes[0]}.` : `You’ve never birdied ${holes.join(", ")}.`;
