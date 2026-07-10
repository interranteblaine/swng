import type { CourseId, GolferId } from "../ids.js";

// Three independently-settable numbers, not one field with a source flag — a golfer can
// carry a declared index, have swng compute one from their own rounds, AND separately
// maintain an official one; effectiveIndex below is what picks the one that counts.
export interface HandicapProfile {
  readonly declared?: number;
  readonly official?: number;
  readonly computed?: number;
}

// One identity for a playing life (architecture.md §2). Ghost vs. claimed account is an
// authentication fact layered on top elsewhere — this record itself never distinguishes them.
export interface Golfer {
  readonly id: GolferId;
  readonly name: string;
  readonly homeCourseId?: CourseId;
  readonly handicap: HandicapProfile;
}

// Precedence: official (manually maintained) always wins > computed (takes over
// automatically once computeIndex has enough differentials — the roadmap's bootstrap
// rule) > declared (a golfer's own starting estimate). undefined only when none is set;
// there is no default of 0 — an unrated golfer stays honestly unrated.
export const effectiveIndex = (profile: HandicapProfile): { readonly value: number; readonly source: "official" | "computed" | "declared" } | undefined => {
  if (profile.official !== undefined) return { value: profile.official, source: "official" };
  if (profile.computed !== undefined) return { value: profile.computed, source: "computed" };
  if (profile.declared !== undefined) return { value: profile.declared, source: "declared" };
  return undefined;
};
