import type { Crew, CrewId } from "@swng/domain";
import type { LeaveCrewResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { requireCrewMember } from "./membership.js";

// POST /crews/{crewId}/leave (architecture-realignment Task 9): the caller removes their OWN
// member item from the roster (spec §4). Past counted rounds they appended REMAIN counted — but
// a crew is members-only (owner ruling, spec §11a): getSeasonStandings.ts filters every
// contribution to the CURRENT roster before folding, so a departed member's own rows simply
// vanish from future standings reads (nothing is stored — re-joining restores them on the next
// read). A non-member (or a sub with no account golfer) leaving is not-a-member
// (requireCrewMember).
export const leaveCrew =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId): Promise<LeaveCrewResponse> => {
    await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    // joinCode never changes after minting (crewStore.ts's doc) but put still requires it on
    // every write — captured from whichever read wins the retry race, mirroring joinCrewByCode.
    let joinCode: string | undefined;
    await retryOnConflict(
      {
        get: async () => {
          const current = await deps.crewStore.get(id);
          if (!current) return undefined;
          joinCode = current.joinCode;
          return { value: current.crew, revision: current.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, joinCode!, revision),
      },
      // Removing an already-absent member is a harmless no-op copy (a concurrent leave that
      // won the race), so this is safe to replay under retryOnConflict's fresh-read contract —
      // the crewStore.put reconciles the MEMBER index items to match this new roster.
      (current: Crew): Crew => ({ ...current, members: current.members.filter((member) => member.golferId !== callerGolferId) }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crewId: id };
  };
