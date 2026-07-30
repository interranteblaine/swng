// "picked-up" is a first-class score, not an error (product.md §4) — the player stopped, and
// that fact is the truth the cell records.
//
// There is no "conceded" arm. A conceded hole IS a strokes cell: your opponent concedes your
// next stroke, so your score is where you lay plus one — the score is never in doubt, so there
// is nothing to ask the player (spec §7). The prior model gave a concession its own arm with a
// required number so match rounds could feed the average, but once it carries a number it *is*
// a score, and every engine, the card's totals, the record's distribution and the course record
// already treated it exactly like `strokes` — two variants that must behave identically
// everywhere are one variant.
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  // The player stopped. There is NO number and nobody invents one — this is the only state that
  // keeps a round out of the average (spec §7).
  | { readonly kind: "picked-up" }
  // A mis-tap undone: the cell reads as unscored everywhere (engines, finalize, AGS).
  // The fold RETAINS cleared cells under HLC-latest — deleting would let a late-arriving
  // older write resurrect the score — and cellAt (round/state.ts) hides them from readers.
  | { readonly kind: "cleared" };

// What a reader sees through cellAt (round/state.ts): absent-or-cleared is undefined, so a
// cell a reader actually receives is never "cleared". The narrowed alias exists so extracts
// built through cellAt (golfer/record.ts's holeResults) carry the truth in their type.
export type DecidedHoleResult = Exclude<HoleResult, { kind: "cleared" }>;

// The ONE accessor for "does this result carry a number, and what is it": strokes answers its
// own count; picked-up (no number) and cleared (never reached through cellAt) answer undefined.
// This is a pure structural accessor over the cell's own shape, not a golf computation — the
// same footing as `cellAt` itself — so every engine (and the card) routes through it instead of
// hand-rolling `kind === "strokes"` at each call site.
export const scoredStrokes = (result: HoleResult): number | undefined =>
  result.kind === "strokes" ? result.strokes : undefined;
