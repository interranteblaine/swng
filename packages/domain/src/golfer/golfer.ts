import type { CourseId, GolferId } from "../ids.js";

// One identity for a playing life (architecture.md §2). Ghost vs. claimed account is an
// authentication fact layered on top elsewhere — this record itself never distinguishes them.
//
// The golfer record holds NO number and no source to pick (spec 2026-07-29 §5): `handicap`
// (`HandicapProfile`/`IndexSource` — the swng/whs/declared choice) is deleted with the index it
// selected between. What a golfer shoots is `metrics.average`, computed on read from their own
// rounds; what they play off in a round is the `basis` they state when they join it. The profile
// is a reporting artifact with no inputs beyond name and home course.
export interface Golfer {
  readonly id: GolferId;
  readonly name: string;
  readonly homeCourseId?: CourseId;
  // accounts-only identity spec §2: set true when `name` is the deterministic sub-derived
  // backstop (placeholderName(sub)) a get-or-create mint uses, not something the golfer chose.
  // The web prompts for a real name while it's true; PUT /me with a real name drops it. Absent
  // means false — old stored golfers (pre-spec) simply never carry it, tolerated on read, never
  // migrated. Emitted only when true; cleared by DROPPING it, never by writing `false`.
  readonly namePlaceholder?: boolean;
}
