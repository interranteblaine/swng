import { validateCrewName } from "@swng/domain";
import type { Crew, CrewId } from "@swng/domain";
import type { GetCrewResponse, UpdateCrewRequest } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

// PUT /crews/{crewId} (spec 2026-07-22 "the season is the record" §2): the crew name is
// editable — organizer-only, no season lookup (unlike updateSeason.ts). Guard order:
// requireCrewMember (not-a-member) → caller is THIS crew's organizer (not-organizer) — the
// SAME two-step gate removeCrewMember.ts/transferOrganizer.ts already use. A rename is just
// `{...crew, name}` (no domain rename op exists), written via the store's `put` reusing the
// retryOnConflict idiom (removeCrewMember.ts's own get→mutate→conditional-put loop) rather than
// a naive get-then-put, since another concurrent write could move the revision out from under a
// bare put.
export const updateCrew =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, command: UpdateCrewRequest): Promise<GetCrewResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const caller = crew.members.find((member) => member.golferId === callerGolferId);
    if (caller?.role !== "organizer") throw new ApplicationError("not-organizer");

    // Domain is the honest layer for the real bound (trimmed 1-60), checked before any store
    // read/write — the same "reject before touching state" discipline createCrew.ts's own
    // validateCrewName call follows.
    validateCrewName(command.name);

    const updated = await retryOnConflict(
      {
        get: async () => {
          const current = await deps.crewStore.get(id);
          return current && { value: current.crew, revision: current.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, revision),
      },
      (current: Crew): Crew => ({ ...current, name: command.name }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, updated) };
  };
