import type { Golfer } from "@swng/domain";
import type { GolferView } from "@swng/contracts";

// The one place a Golfer aggregate becomes its wire projection (mirrors courses'
// courseView.ts). Deliberately does NOT emit `computed` or a derived `effective` field: the
// golfer item this reads from never carries a persisted computed index (that lives in the
// separate index projection — application/src/golfers/getMyRecord.ts), so a server-side
// effectiveIndex(golfer.handicap) call here would silently compute the WRONG precedence
// whenever a real computed index existed elsewhere. The web derives the true effective index
// itself from GET /me + GET /me/record (apps/web/src/routes/ProfilePage.tsx). Optional fields
// are omitted rather than sent as `undefined` — matches courseView.ts's own spread idiom and
// keeps the wire payload honest about what's actually set.
export const toGolferView = (golfer: Golfer): GolferView => ({
  golferId: golfer.id,
  name: golfer.name,
  ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
  ...(golfer.handicap.declared !== undefined ? { declared: golfer.handicap.declared } : {}),
  // Emitted only when true (accounts-only identity spec §2) — absent means the golfer has a real,
  // chosen name; never sent as `false`, matching the omit-when-unset idiom above.
  ...(golfer.namePlaceholder === true ? { namePlaceholder: true } : {}),
});
