import type { CourseId, GolferId } from "../ids.js";

// The index a golfer is ON — a source they choose, resolved live (index-source model spec §3).
// swng/whs are computed views (resolveIndex, metrics.ts); declared is the one number a golfer
// asserts. Never a stored computed value — the invariant this type exists to enforce (spec §2):
// the profile persists the CHOICE, and the value is resolved fresh from the live metrics on
// every read, so an adopted computed source can never drift from the number it names.
export type IndexSource =
  | { readonly kind: "swng" }
  | { readonly kind: "whs" }
  | { readonly kind: "declared"; readonly value: number };

export interface HandicapProfile {
  readonly indexSource: IndexSource;
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
