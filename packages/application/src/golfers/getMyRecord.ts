import type { GolferRoundLine } from "@swng/domain";
import { combineNineHoleDifferentials, computeIndexDetail } from "@swng/domain";
import type { GetMyRecordResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { sortLines } from "../projections/projectArchive.js";

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
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore; clock: Clock }) =>
  async (claims: AccountClaims): Promise<GetMyRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) return { history: [] };

    const lines = await deps.projectionStore.listLines(found.golfer.id);
    // listLines is UNORDERED (ports/projectionStore.ts) — sortLines (projections/
    // projectArchive.ts) gives oldest → newest for the fold below AND for the wire history's
    // newest-first reversal, one ordering for both consumers of these lines.
    const sorted = sortLines(lines);

    // The index is computed HERE, at read time, from the lines this response already carries —
    // never stored (pre-prod hardening D4a): the projector's stored INDEX snapshot was the
    // system's last read-modify-write aggregate, and two same-golfer finalizes on different
    // stream shards could race it. Same fold the projector used to run; the math stays in
    // domain (conventions §4). differentialsUsed is Rule 5.2a's `use` count — how many
    // differentials were actually AVERAGED, not the window size.
    const complete = sorted.filter((entry) => entry.differential !== undefined);
    const combined = combineNineHoleDifferentials(complete.map((entry) => ({ differential: entry.differential!, holes: entry.holes })));
    const detail = computeIndexDetail(combined);

    return {
      ...(detail !== undefined ? { index: { value: detail.value, computedAtMs: deps.clock.now(), differentialsUsed: detail.differentialsUsed } } : {}),
      history: sorted.reverse().map(toWireLine),
    };
  };
