import { addMember } from "@swng/domain";
import type { Crew, CrewId } from "@swng/domain";
import type { AddCrewMemberRequest, AddCrewMemberResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

// POST /crews/{crewId}/members (architecture-realignment Task 9, de-ghost — spec §4 "membership:
// real accounts only"): adds an EXISTING account golfer to the roster by their golferId. The M8
// path that minted a fresh account-less golfer from a `name` is GONE — a crew member must already
// carry a bound sub (a real account). Onboarding a person without an account stays a ROUND
// concern (they sign up via the round's join link, then get added here or join a crew by code).
// The name comes from the golfer's own record, never the wire.
export const addCrewMember =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, command: AddCrewMemberRequest): Promise<AddCrewMemberResponse> => {
    // Only a fellow crew member may add someone to the roster.
    await requireCrewMember(deps, claims, id);

    // The target must be a real account golfer — a bound sub is exactly what "account, not
    // ghost" means (createDynamoGolferStore's bindSub writes it). A missing row or a sub-less
    // golfer both fail the same way: ghost-not-addable.
    const target = await deps.golferStore.get(command.golferId);
    if (!target || target.sub === undefined) throw new ApplicationError("ghost-not-addable");

    // joinCode never changes after minting (crewStore.ts's own doc comment) but crewStore.put
    // still requires it on every write — captured here from whichever read wins the retry race.
    let joinCode: string | undefined;
    const crew = await retryOnConflict(
      {
        get: async () => {
          const found = await deps.crewStore.get(id);
          if (!found) return undefined;
          joinCode = found.joinCode;
          return { value: found.crew, revision: found.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, joinCode!, revision),
      },
      (current: Crew): Crew => addMember(current, { golferId: command.golferId, name: target.golfer.name, role: "member" }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode!) };
  };
