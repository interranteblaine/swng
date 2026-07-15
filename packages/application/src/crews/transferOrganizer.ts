import { transferOrganizer as flipOrganizer } from "@swng/domain";
import type { Crew, CrewId, GolferId } from "@swng/domain";
import type { GetCrewResponse, TransferOrganizerRequest } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

// POST /crews/{crewId}/transfer (crew membership, invited in — spec §1): the organizer's
// authority, half two. Organizer-only, target must already be a member — a pure role flip
// through the domain's own transferOrganizer (crew/crew.ts), imported under a local alias here
// (flipOrganizer) so this use case's own exported name stays `transferOrganizer` without
// colliding with the domain function it wraps.
// Guards, in order: caller is a member (not-a-member, requireCrewMember) → caller is THIS crew's
// CURRENT organizer (not-organizer) → the domain roster op itself (not-a-member if the target
// golferId isn't on the roster).
export const transferOrganizer =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, command: TransferOrganizerRequest): Promise<GetCrewResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const caller = crew.members.find((member) => member.golferId === callerGolferId);
    if (caller?.role !== "organizer") throw new ApplicationError("not-organizer");

    const toGolferId: GolferId = command.golferId;
    const updated = await retryOnConflict(
      {
        get: async () => {
          const current = await deps.crewStore.get(id);
          return current && { value: current.crew, revision: current.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, revision),
      },
      (current: Crew): Crew => flipOrganizer(current, toGolferId),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, updated) };
  };
