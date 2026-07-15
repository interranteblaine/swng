import type { Crew } from "@swng/domain";
import type { CrewView } from "@swng/contracts";
import type { GolferStore } from "../ports/golferStore.js";

// The one place a Crew aggregate becomes CrewView (mirrors courses' courseView.ts / golfers'
// golferView.ts). Unlike those two, this builder is async: `claimed` isn't a field on the
// domain CrewMember (crew/crew.ts) — it's a GolferStore lookup done PER MEMBER at read time
// (does that member's golfer row carry a sub?), same "derive, don't store" reasoning as
// courseView's teeSets badges. `joinCode` is GONE (crew membership, invited in) — a crew's
// wire view carries no permanent invite surface anymore, only the roster.
export const toCrewView = async (deps: { golferStore: GolferStore }, crew: Crew): Promise<CrewView> => {
  const members = await Promise.all(
    crew.members.map(async (member) => {
      const found = await deps.golferStore.get(member.golferId);
      return { golferId: member.golferId, name: member.name, role: member.role, claimed: found?.sub !== undefined };
    }),
  );

  return { crewId: crew.id, name: crew.name, members };
};
