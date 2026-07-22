import type { CrewId } from "@swng/domain";
import type { GetCrewResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

export const getCrew =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId): Promise<GetCrewResponse> => {
    // member-only: not-a-member propagates for a non-member (or unbound) caller.
    const { crew } = await requireCrewMember(deps, claims, id);
    return { crew: toCrewView(crew) };
  };
