// "picked-up" and "conceded" are first-class scores, not errors (product.md §4).
// Each game format decides what they mean; the cell just records the truth.
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  | { readonly kind: "picked-up" }
  | { readonly kind: "conceded" };
