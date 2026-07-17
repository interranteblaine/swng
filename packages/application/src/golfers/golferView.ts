import type { Golfer } from "@swng/domain";
import type { GolferView } from "@swng/contracts";

// The one place a Golfer aggregate becomes its wire projection (mirrors courses' courseView.ts).
// Emits the golfer's chosen `indexSource` (index-source model spec §3) — the CHOICE, never a
// computed value: the golfer item never carries a persisted swng/whs number (those are read-time
// metrics on the separate record response, getMyRecord.ts), and the web resolves the concrete
// value from this source + those metrics via domain's `resolveIndex`. Optional fields are omitted
// rather than sent as `undefined` — matches courseView.ts's own spread idiom.
export const toGolferView = (golfer: Golfer): GolferView => ({
  golferId: golfer.id,
  name: golfer.name,
  ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
  indexSource: golfer.handicap.indexSource,
  // Emitted only when true (accounts-only identity spec §2) — absent means the golfer has a real,
  // chosen name; never sent as `false`, matching the omit-when-unset idiom above.
  ...(golfer.namePlaceholder === true ? { namePlaceholder: true } : {}),
});
