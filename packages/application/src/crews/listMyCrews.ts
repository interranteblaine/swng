import type { ListMyCrewsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";

// A sub with no account golfer yet belongs to no crews by construction — an empty list, not
// an error (mirrors getMyRecord's "no golfer -> empty record" precedent, not claimGolfer's
// "wire honesty" 400: listing is a read, no write is being silently skipped).
export const listMyCrews =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims): Promise<ListMyCrewsResponse> => {
    const account = await deps.golferStore.getBySub(claims.sub);
    if (!account) return { crews: [] };

    return { crews: await deps.crewStore.listByGolfer(account.golfer.id) };
  };
