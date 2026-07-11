import type { CrewId } from "@swng/domain";
import type { GetCrewRecordsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { requireCrewMember } from "./membership.js";

// GET /crews/{crewId}/records?season= (M8 Task 4 — no plan text ever named this use case
// directly; the controller resolved the gap by pointing at getSeasonRecords + the existing
// membership gate). Member-only, same gate as getCrew/addCrewMember/saveStandingGame — a
// crew's own season ledger is roster-private, not public. `season` is REQUIRED here (the
// route defaults ?season= to the current UTC year at the dispatch layer — routes.ts's own
// doc comment — so this use case never has to guess a "current" season itself).
//
// A crew with no finalized rounds in `season` yet is not an error: getSeasonRecords returns
// undefined until projectArchive's first crew-tagged finalize writes something (upsert-then-
// recompute, ports/projectionStore.ts) — this defaults to the empty { ledger: [], headToHead:
// [] } shape rather than propagating undefined onto the wire.
export const getCrewRecords =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims, id: CrewId, season: number): Promise<GetCrewRecordsResponse> => {
    await requireCrewMember(deps, claims, id);

    const records = await deps.projectionStore.getSeasonRecords(id, season);
    return { season, ledger: records?.ledger ?? [], headToHead: records?.headToHead ?? [] };
  };
