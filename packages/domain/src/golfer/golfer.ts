import type { CourseId, GolferId } from "../ids.js";

// The one number a golfer sets on themselves: their own declared index (unrated-courses
// spec §6 — the three-number model collapsed to two, `declared` overriding `computed`, with
// the old self-maintained `official` folded into `declared`). `computed` is NOT stored on
// the golfer at all — it's a read-time metric (golfer/metrics.ts's whsIndex) the application
// composes against this declared value; effectiveIndex below is what picks the one that counts.
export interface HandicapProfile {
  readonly declared?: number;
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

// Precedence: declared (a golfer's own index, self-maintained — what they'd tell you they
// play off) always wins > computed (swng's own read-time whsIndex from their posted rounds,
// golfer/metrics.ts). undefined only when neither is set; there is no default of 0 — an
// unrated golfer stays honestly unrated. Takes the two numbers as a plain input rather than a
// HandicapProfile because `computed` never lives on the profile: the caller (the web's
// ProfilePage) composes the stored `declared` with the read-time whsIndex it fetched separately.
export const effectiveIndex = (
  input: { readonly declared?: number; readonly computed?: number },
): { readonly value: number; readonly source: "declared" | "computed" } | undefined => {
  if (input.declared !== undefined) return { value: input.declared, source: "declared" };
  if (input.computed !== undefined) return { value: input.computed, source: "computed" };
  return undefined;
};
