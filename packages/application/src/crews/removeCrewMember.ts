import { removeMember } from "@swng/domain";
import type { Crew, CrewId, GolferId } from "@swng/domain";
import type { GetCrewResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

// DELETE /crews/{crewId}/members/{golferId} (crew membership, invited in — spec §1): the
// organizer's authority, half one. Semantically identical to leaveCrew (a pure roster removal
// through the SAME revision-checked crewStore.put — no projection/season/standings code is
// touched; standings aggregation scope does the rest at the next read) — the only difference is
// WHO may act (the organizer, not the leaver themselves) and WHOSE membership ends.
// Guards, in order: caller is a member (not-a-member, requireCrewMember) → caller is THIS crew's
// organizer (not-organizer) → the domain roster op itself (removeMember: not-a-member if
// targetGolferId isn't on the roster, organizer-immovable if it names the organizer — transfer
// first, transferOrganizer.ts).
export const removeCrewMember =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, targetGolferId: GolferId): Promise<GetCrewResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const caller = crew.members.find((member) => member.golferId === callerGolferId);
    if (caller?.role !== "organizer") throw new ApplicationError("not-organizer");

    const updated = await retryOnConflict(
      {
        get: async () => {
          const current = await deps.crewStore.get(id);
          return current && { value: current.crew, revision: current.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, revision),
      },
      (current: Crew): Crew => removeMember(current, targetGolferId),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, updated) };
  };
