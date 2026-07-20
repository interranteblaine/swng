import type { GetMyRecordResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { recordOf } from "./recordOf.js";

// No get-or-create here (unlike getMyGolfer/updateMyGolfer) — viewing an obviously-empty
// record for a sub that's never even signed in far enough to have a golfer row needs no item to
// exist; recordOf([]) is already the honest answer (a zeroed typicalEighteen + empty
// indexHistory, papercut 17's now-required members, alongside no computed indexes).
export const getMyRecord =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore; clock: Clock }) =>
  async (claims: AccountClaims): Promise<GetMyRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    const lines = found ? await deps.projectionStore.listLines(found.golfer.id) : [];

    // recordOf (navigation spec §6a) runs the SAME lines-to-{metrics, history} fold
    // getGolfer.ts shares (listLines → sortLines → golferMetrics → newest-first wire lines) —
    // never a second implementation. Every derived index is computed HERE, at read time, from
    // the lines this response already carries — never stored (pre-prod hardening D4a: the
    // projector's stored INDEX snapshot was a read-modify-write aggregate two same-golfer
    // finalizes on different stream shards could race). This use case's own addition on top of
    // the shared fold is the read-time `computedAtMs` stamp on the wire whsIndex (the pure fold
    // carries no clock).
    const { metrics, history } = recordOf(lines);

    return {
      metrics: {
        ...(metrics.whsIndex !== undefined
          ? { whsIndex: { value: metrics.whsIndex.value, computedAtMs: deps.clock.now(), differentialsUsed: metrics.whsIndex.differentialsUsed } }
          : {}),
        ...(metrics.swngIndex !== undefined ? { swngIndex: metrics.swngIndex } : {}),
        typicalEighteen: metrics.typicalEighteen,
        indexHistory: metrics.indexHistory,
      },
      history,
    };
  };
