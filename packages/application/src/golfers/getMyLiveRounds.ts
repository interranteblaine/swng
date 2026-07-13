import type { GetMyLiveRoundsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// GET /me/rounds/live (projection-realignment Task 13): "your rounds, right now" — every LIVE
// presence pointer under the caller's own golfer identity (rounds/presence.ts's writePresence
// writes these at seat-time; projections/projectArchive.ts's deleteLive loop removes them at
// finalize). No get-or-create (getMyRecord.ts/getMyRounds.ts's own precedent) — a sub with no
// golfer row yet has no presence to have, so `{ rounds: [] }` is already the honest answer.
export const getMyLiveRounds =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims): Promise<GetMyLiveRoundsResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) return { rounds: [] };

    const live = await deps.projectionStore.listLive(found.golfer.id);
    // listLive is UNORDERED (ports/projectionStore.ts, same discipline as listLines) — sort
    // here, newest-joined first, rather than trusting the store's own iteration order.
    const sorted = [...live].sort((a, b) => b.joinedAtMs - a.joinedAtMs);
    return { rounds: sorted.map((entry) => ({ roundId: entry.roundId, courseName: entry.courseName, joinedAt: entry.joinedAtMs })) };
  };
