import type { GolferRoundLine } from "@swng/domain";
import type { GetMyRecordResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// Strips the projection store's internal finalizedAtMs (sort metadata, not part of the
// wire shape) — GetMyRecordResponse's history is exactly GolferRoundLine, not an extension
// of it.
const toWireLine = (line: GolferRoundLine & { readonly finalizedAtMs: number }): GolferRoundLine => ({
  roundId: line.roundId,
  courseName: line.courseName,
  tee: line.tee,
  holes: line.holes,
  ...(line.ags !== undefined ? { ags: line.ags } : {}),
  ...(line.differential !== undefined ? { differential: line.differential } : {}),
  distribution: line.distribution,
});

// No get-or-create here (unlike getMyGolfer/updateMyGolfer) — viewing an obviously-empty
// record for a sub that's never even signed in far enough to have a golfer row needs no
// item to exist; `{ history: [] }` is already the honest answer.
export const getMyRecord =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims): Promise<GetMyRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) return { history: [] };

    const history = await deps.projectionStore.listHistory(found.golfer.id);
    const index = await deps.projectionStore.getIndex(found.golfer.id);

    // listHistory is oldest → newest (what the index projector needs, projections/
    // projectArchive.ts); the wire response reads newest-first, top-down, "what did I just
    // play".
    return {
      ...(index !== undefined ? { index } : {}),
      history: [...history].reverse().map(toWireLine),
    };
  };
