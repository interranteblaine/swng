import type { GolferRoundLine } from "@swng/domain";
import type { GetMyRoundsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { sortLines } from "../projections/projectArchive.js";

// GET /me/rounds's own line shape: GolferRoundLine plus `finalizedAt` (the wire name for the
// projection store's internal `finalizedAtMs`) — same field-by-field wire-shaping discipline
// as getMyRecord.ts's own toWireLine (never spreads the store's internal shape as-is).
const toWireLine = (
  line: GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number },
): GolferRoundLine & { readonly finalizedAt: number; readonly createdAt?: number } => ({
  roundId: line.roundId,
  courseName: line.courseName,
  // courseId (course-cards spec §4, the analytics join key) — omitted for pre-scrap lines
  // whose card carried no source (tolerated as absent, no migration).
  ...(line.courseId !== undefined ? { courseId: line.courseId } : {}),
  tee: line.tee,
  holes: line.holes,
  ...(line.ags !== undefined ? { ags: line.ags } : {}),
  ...(line.differential !== undefined ? { differential: line.differential } : {}),
  distribution: line.distribution,
  finalizedAt: line.finalizedAtMs,
  // createdAt (spec §5, the "course + date" designation) — omitted for lines written before the
  // field existed (tolerated as absent, no migration; a rebuild backfills it).
  ...(line.createdAtMs !== undefined ? { createdAt: line.createdAtMs } : {}),
});

// "List my rounds" (projection-realignment Task 6): every finalized round the caller played,
// newest first. No get-or-create (getMyRecord.ts's own precedent) — a sub that's never gone
// far enough to have a golfer row has played nothing, so `{ rounds: [] }` is already the
// honest answer.
export const getMyRounds =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims): Promise<GetMyRoundsResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    if (!found) return { rounds: [] };

    const lines = await deps.projectionStore.listLines(found.golfer.id);
    // listLines is UNORDERED (ports/projectionStore.ts) — sortLines (the SAME ordering
    // getMyRecord.ts's own `history` uses) gives oldest -> newest before this reverses to
    // newest-first, so this response's ordering never drifts from getMyRecord's.
    return { rounds: sortLines(lines).reverse().map(toWireLine) };
  };
