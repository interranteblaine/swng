import type { GetMyRecordResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { recordOf } from "./recordOf.js";

// No get-or-create here (unlike getMyGolfer/updateMyGolfer) — viewing an obviously-empty
// record for a sub that's never even signed in far enough to have a golfer row needs no item to
// exist; recordOf([]) is already the honest answer (a zeroed typicalEighteen + empty
// averageHistory alongside no average/spread).
//
// No Clock either (spec 2026-07-29 §7): the only reason this use case ever took one was the
// read-time `computedAtMs` stamp on the wire whsIndex, and the index is deleted whole. This is now
// a thin pass-through of the shared fold — kept as its own use case because the SELF-scoped
// getBySub lookup is what distinguishes it from getGolfer.
export const getMyRecord =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims): Promise<GetMyRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    const lines = found ? await deps.projectionStore.listLines(found.golfer.id) : [];

    // recordOf (navigation spec §6a) runs the SAME lines-to-{metrics, history} fold
    // getGolfer.ts shares (listLines → sortLines → golferMetrics → newest-first wire lines) —
    // never a second implementation. Every derived number is computed HERE, at read time, from
    // the lines this response already carries — never stored (pre-prod hardening D4a: the
    // projector's stored INDEX snapshot was a read-modify-write aggregate two same-golfer
    // finalizes on different stream shards could race).
    return recordOf(lines);
  };
