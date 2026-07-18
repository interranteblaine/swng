import type { GolferRoundLine } from "@swng/domain";
import { golferMetrics, postedDifferential } from "@swng/domain";
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
  // courseId (course-cards spec §4, the analytics join key) — omitted for pre-scrap lines
  // whose card carried no source (tolerated as absent, no migration).
  ...(line.courseId !== undefined ? { courseId: line.courseId } : {}),
  tee: line.tee,
  holes: line.holes,
  par: line.par,
  courseHandicap: line.courseHandicap,
  ...(line.ags !== undefined ? { ags: line.ags } : {}),
  // A posted differential is a one-decimal value (postedDifferential's own doc comment) — the
  // wire NEVER carries the raw full-precision figure the index fold averages internally. Only
  // this display step rounds; golferMetrics below still folds the RAW `sorted` lines.
  ...(line.differential !== undefined ? { differential: postedDifferential(line.differential) } : {}),
  distribution: line.distribution,
});

// No get-or-create here (unlike getMyGolfer/updateMyGolfer) — viewing an obviously-empty
// record for a sub that's never even signed in far enough to have a golfer row needs no item to
// exist; a zeroed typicalEighteen + empty indexHistory (papercut 17's now-required members)
// alongside no computed indexes is already the honest answer.
export const getMyRecord =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore; clock: Clock }) =>
  async (claims: AccountClaims): Promise<GetMyRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) return { metrics: { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, indexHistory: [] }, history: [] };

    const lines = await deps.projectionStore.listLines(found.golfer.id);
    // listLines is UNORDERED (ports/projectionStore.ts) — sortLines (projections/
    // projectArchive.ts) gives oldest → newest for the metrics fold below AND for the wire
    // history's newest-first reversal, one ordering for both consumers of these lines.
    const sorted = sortLines(lines);

    // Every derived index is computed HERE, at read time, from the lines this response already
    // carries — never stored (pre-prod hardening D4a: the projector's stored INDEX snapshot was
    // a read-modify-write aggregate two same-golfer finalizes on different stream shards could
    // race). The math is domain's own golferMetrics fold (unrated-courses spec §6, conventions
    // §4 — the whsIndex computation MOVED there out of this file); the application only stamps
    // read-time `computedAtMs` on the wire whsIndex (the pure fold carries no clock).
    const metrics = golferMetrics(sorted);

    return {
      metrics: {
        ...(metrics.whsIndex !== undefined
          ? { whsIndex: { value: metrics.whsIndex.value, computedAtMs: deps.clock.now(), differentialsUsed: metrics.whsIndex.differentialsUsed } }
          : {}),
        ...(metrics.swngIndex !== undefined ? { swngIndex: metrics.swngIndex } : {}),
        typicalEighteen: metrics.typicalEighteen,
        indexHistory: metrics.indexHistory,
      },
      history: sorted.reverse().map(toWireLine),
    };
  };
