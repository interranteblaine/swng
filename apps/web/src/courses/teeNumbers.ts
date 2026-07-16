// The one place a tee's rating/slope summary is rendered as text (unrated-courses arc): a rated
// tee reads "rating 71.6, slope 128"; an unrated one (rating/slope absent as a pair — spec §1)
// reads a plain "unrated" instead of a half-blank "rating , slope ". Shared so every tee-numbers
// surface — CoursePage, CourseSummaryCard, the edit picker, and (T5b) the create/join pickers —
// speaks the identical string, never a per-site re-inlining that could drift.
export const teeNumbers = (tee: { readonly rating?: number; readonly slope?: number }): string =>
  tee.rating !== undefined && tee.slope !== undefined ? `rating ${tee.rating}, slope ${tee.slope}` : "unrated";
