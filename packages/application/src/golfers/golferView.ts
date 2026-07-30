import type { Golfer } from "@swng/domain";
import type { GolferView } from "@swng/contracts";

// The one place a Golfer aggregate becomes its wire projection (mirrors courses' courseView.ts).
// Name and home course are the WHOLE profile (spec 2026-07-29 §5): the golfer record carries no
// number and no index source to emit — what a golfer shoots is `metrics.average` on the separate
// record response (getMyRecord.ts), computed on read from their own rounds. Optional fields are
// omitted rather than sent as `undefined` — matches courseView.ts's own spread idiom.
export const toGolferView = (golfer: Golfer): GolferView => ({
  golferId: golfer.id,
  name: golfer.name,
  ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
  // Emitted only when true (accounts-only identity spec §2) — absent means the golfer has a real,
  // chosen name; never sent as `false`, matching the omit-when-unset idiom above.
  ...(golfer.namePlaceholder === true ? { namePlaceholder: true } : {}),
});
