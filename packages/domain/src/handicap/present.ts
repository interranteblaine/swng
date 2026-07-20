import type { IndexSource } from "../golfer/golfer.js";

// The golf presentation conventions for a handicap, in ONE place (index-source one-tap + plus-
// handicap spec §3). Views render THROUGH these — never a `value < 0` or a `+` literal in a
// component. The stored/wire numbers are unchanged; this is only how a sign is shown.

// A Handicap Index below 0 is a "plus" handicap (better than scratch): golf writes it "+2.4".
// 0.0 is scratch. Never a bare "-2.4".
export const formatHandicapIndex = (value: number): string =>
  value < 0 ? `+${(-value).toFixed(1)}` : value.toFixed(1);

// A course handicap is an INTEGER; a negative one is a "plus" course handicap — golf writes it "+1"
// (the player gives that many strokes). Distinct from formatHandicapIndex (a 1-dp index).
export const formatCourseHandicap = (value: number): string =>
  value < 0 ? `+${-value}` : String(value);

// A signed stroke count (a course handicap, or a hole's dots) is strokes RECEIVED when positive,
// GIVEN when negative (a plus handicap gives strokes back), none at 0. The ONE place a sign becomes
// give/receive — the strokes note and the scorecard both read this, neither re-decides it.
export interface StrokeGrant {
  readonly kind: "receives" | "gives" | "none";
  readonly count: number;
}
export const strokeGrant = (signed: number): StrokeGrant =>
  signed > 0
    ? { kind: "receives", count: signed }
    : signed < 0
      ? { kind: "gives", count: -signed }
      : { kind: "none", count: 0 };

// The words behind a RESOLVED index's source (index-source model spec §3, `resolveIndex`'s own
// `kind` discriminant) — the golf convention ProfilePage's "Your index" section already spoke
// inline, now the model's own copy (the `formatHandicapIndex`/`strokesNote` precedent) so the
// golfer page (navigation spec §6c) can say the SAME thing about someone else. `person` picks the
// pronoun: "your" is ProfilePage's own three strings verbatim; "their" is the identical shape for
// viewing another golfer's record. Never re-decided at a call site.
export const indexSourcePhrase = (kind: IndexSource["kind"], person: "your" | "their"): string => {
  switch (kind) {
    case "swng":
      return `from all ${person} rounds`;
    case "whs":
      return `${person} WHS index`;
    case "declared":
      return `${person} own`;
  }
};
