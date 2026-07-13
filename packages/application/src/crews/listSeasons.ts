import type { CrewId } from "@swng/domain";
import type { ListSeasonsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { requireCrewMember } from "./membership.js";

// GET /crews/{crewId}/seasons (architecture-realignment Task 9): member-only, same gate as the
// rest of the crew surface. CrewStore.listSeasons makes NO order promise (its own port doc), so
// this imposes the read order every caller wants — newest-first by createdAtMs, name a
// deterministic tiebreak for a same-millisecond pair (unreachable at real wall-clock resolution,
// but a stable order beats an unspecified one at zero cost).
export const listSeasons =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId): Promise<ListSeasonsResponse> => {
    await requireCrewMember(deps, claims, id);

    const seasons = [...(await deps.crewStore.listSeasons(id))].sort(
      (a, b) => b.createdAtMs - a.createdAtMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

    return { seasons };
  };
