import type { GolferId } from "../ids.js";
import { roundHalfUp } from "./strokes.js";

// What a player asserts about their game (spec §2a) — an object, not an integer. A group saying
// "just give him 18" is the SECOND constructor, not a fudge of the first, so nobody ever
// distorts a true fact about themselves to get the strokes they want.
export type StrokeBasis =
  | { readonly kind: "normally-shoots"; readonly overPar: number }
  | { readonly kind: "strokes"; readonly strokes: number };

// The ONE resolution rule (spec §2b): strokes are the difference from the lowest in the field.
// The anchor is the lowest stated `normally-shoots`; a player who stated strokes gets exactly
// what they said and never enters the anchor.
//
// `holeCount` halves the DIFFERENCE once, at the end — never each player's number first, which
// would round twice. A literal strokes assertion is never halved: it is already a statement
// about this round.
//
// With no stated normal score there is no anchor and nothing to be relative to, so a normal-
// score player gets 0. Correct, not degenerate: strokes cannot be allocated when only one
// person's level is known.
//
// Callers pass only the PRESENT field — reduceRound filters departed seats before calling
// (spec §2b), because a wrong-round joiner who left must not anchor everyone's card.
// The anchor for a field: the lowest stated `normally-shoots` among its members, or undefined
// when nobody stated one. Exported so every caller scopes its OWN field and passes the result.
export const anchorOf = (bases: readonly { readonly basis: StrokeBasis }[]): number | undefined => {
  const stated = bases.flatMap(({ basis }) => (basis.kind === "normally-shoots" ? [basis.overPar] : []));
  return stated.length > 0 ? Math.min(...stated) : undefined;
};

// `anchor` is REQUIRED and this function has NO fallback of its own — deliberately. A fallback
// that computed the anchor from `bases` would silently re-admit a departed player whenever nobody
// still present had stated a normal score, since callers pass the full roster (departed included)
// as `bases` and scope only the ANCHOR to the present field (spec §2b).
export const resolveStrokes = (
  bases: readonly { readonly golferId: GolferId; readonly basis: StrokeBasis }[],
  holeCount: number,
  anchor: number | undefined,
): ReadonlyMap<GolferId, number> => {
  return new Map(
    bases.map(({ golferId, basis }) => {
      if (basis.kind === "strokes") return [golferId, basis.strokes];
      // Clamped at zero — never negative (spec §2b). A departed player better than the surviving
      // anchor was the anchor while they were there and never received a stroke; and after Task 5
      // the card renders "●".repeat(dots), which throws RangeError on a negative.
      const difference = anchor === undefined ? 0 : Math.max(0, basis.overPar - anchor);
      return [golferId, holeCount === 9 ? roundHalfUp(difference / 2) : difference];
    }),
  );
};
