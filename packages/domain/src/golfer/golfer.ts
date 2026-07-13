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
  // accounts-only identity spec §2: set true when `name` is the deterministic sub-derived
  // backstop (placeholderName(sub)) a get-or-create mint uses, not something the golfer chose.
  // The web prompts for a real name while it's true; PUT /me with a real name drops it. Absent
  // means false — old stored golfers (pre-spec) simply never carry it, tolerated on read, never
  // migrated. Emitted only when true; cleared by DROPPING it, never by writing `false`.
  readonly namePlaceholder?: boolean;
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
