// "picked-up" and "conceded" are first-class scores, not errors (product.md §4).
// Each game format decides what they mean; the cell just records the truth.
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  | { readonly kind: "picked-up" }
  // The hole was decided but the player would have finished it — the score the group says out
  // loud. A CONCEDED HOLE IS A SCORED HOLE EVERYWHERE (spec §2d): every engine, the card's
  // totals and the average treat it exactly as a `strokes` cell, because you made the 4. Only
  // two places distinguish it — the card's `5c` glyph, and fullyHoledOut, which gates Best and
  // the milestones and has always excluded it.
  | { readonly kind: "conceded"; readonly strokes: number }
  // A mis-tap undone: the cell reads as unscored everywhere (engines, finalize, AGS).
  // The fold RETAINS cleared cells under HLC-latest — deleting would let a late-arriving
  // older write resurrect the score — and cellAt (round/state.ts) hides them from readers.
  | { readonly kind: "cleared" };

// What a reader sees through cellAt (round/state.ts): absent-or-cleared is undefined, so a
// cell a reader actually receives is never "cleared". The narrowed alias exists so extracts
// built through cellAt (golfer/record.ts's holeResults) carry the truth in their type.
export type DecidedHoleResult = Exclude<HoleResult, { kind: "cleared" }>;

// The ONE accessor for "does this result carry a number, and what is it" (task-2, spec §2d): a
// conceded hole is a scored hole everywhere, so it answers exactly like `strokes`; picked-up
// (no number) and cleared (never reached through cellAt) answer undefined. This is a pure
// structural accessor over the cell's own shape, not a golf computation — the same footing as
// `cellAt` itself — so every engine (and the card) routes through it instead of hand-rolling
// `kind === "strokes" || kind === "conceded"` (or its De Morgan negation) at each call site.
export const scoredStrokes = (result: HoleResult): number | undefined =>
  result.kind === "strokes" || result.kind === "conceded" ? result.strokes : undefined;
