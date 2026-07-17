// The golf presentation conventions for a handicap, in ONE place (index-source one-tap + plus-
// handicap spec §3). Views render THROUGH these — never a `value < 0` or a `+` literal in a
// component. The stored/wire numbers are unchanged; this is only how a sign is shown.

// A Handicap Index below 0 is a "plus" handicap (better than scratch): golf writes it "+2.4".
// 0.0 is scratch. Never a bare "-2.4".
export const formatHandicapIndex = (value: number): string =>
  value < 0 ? `+${(-value).toFixed(1)}` : value.toFixed(1);

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
