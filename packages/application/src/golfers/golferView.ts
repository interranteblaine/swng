import type { Golfer } from "@swng/domain";
import { effectiveIndex } from "@swng/domain";
import type { GolferView } from "@swng/contracts";

// The one place a Golfer aggregate becomes its wire projection (mirrors courses'
// courseView.ts) — every golfer use case that returns a GolferView builds it here, so
// `effective`'s precedence (domain's effectiveIndex) isn't hand-mirrored per call site.
// Optional fields are omitted rather than sent as `undefined` — matches courseView.ts's own
// spread idiom and keeps the wire payload honest about what's actually set.
export const toGolferView = (golfer: Golfer): GolferView => {
  const effective = effectiveIndex(golfer.handicap);
  return {
    golferId: golfer.id,
    name: golfer.name,
    ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
    ...(golfer.handicap.declared !== undefined ? { declared: golfer.handicap.declared } : {}),
    ...(golfer.handicap.official !== undefined ? { official: golfer.handicap.official } : {}),
    ...(golfer.handicap.computed !== undefined ? { computed: golfer.handicap.computed } : {}),
    ...(effective !== undefined ? { effective } : {}),
  };
};
