import type { Crew } from "@swng/domain";
import type { CrewView } from "@swng/contracts";

// The one place a Crew aggregate becomes CrewView (mirrors courses' courseView.ts / golfers'
// golferView.ts) — a pure SYNC mapper. `claimed` (a GolferStore lookup done PER MEMBER at read
// time — did that member's golfer row carry a sub?) is GONE: under accounts-only identity every
// crew member joined as a signed-in account, so the field was always true and told the reader
// nothing (spec 2026-07-22 §5). `joinCode` is GONE too (crew membership, invited in) — a crew's
// wire view carries no permanent invite surface anymore, only the roster.
export const toCrewView = (crew: Crew): CrewView => {
  const members = crew.members.map((member) => ({ golferId: member.golferId, name: member.name, role: member.role }));
  return { crewId: crew.id, name: crew.name, members };
};
