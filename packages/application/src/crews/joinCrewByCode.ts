import { addMember } from "@swng/domain";
import type { JoinCrewRequest, JoinCrewResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { toCrewView } from "./crewView.js";
import { retryOnConflict } from "./retryOnConflict.js";

// POST /crews/join: adds the CALLER's own account golfer as a member (role "member") — the
// self-service counterpart to addCrewMember's ghost-minting (that one's for people WITHOUT
// accounts; this one's for people joining as themselves via a shared code).
export const joinCrewByCode =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, command: JoinCrewRequest): Promise<JoinCrewResponse> => {
    const crewId = await deps.crewStore.findByJoinCode(command.code);
    if (!crewId) throw new ApplicationError("unknown-crew");

    // Same wire-honesty rule as createCrew: joining needs the caller's OWN golfer to seat.
    const account = await deps.golferStore.getBySub(claims.sub);
    if (!account) throw new ApplicationError("golfer-required");

    const found = await deps.crewStore.get(crewId);
    if (!found) throw new ApplicationError("unknown-crew"); // defensive: findByJoinCode just resolved it

    // Idempotent re-join: already on the roster, return the crew as-is — no mutation, so no
    // wasted write and no chance of a duplicate-member race on an unconditional add.
    if (found.crew.members.some((member) => member.golferId === account.golfer.id)) {
      return { crew: await toCrewView({ golferStore: deps.golferStore }, found.crew, found.joinCode) };
    }

    const { crew, joinCode } = await retryOnConflict(deps.crewStore, crewId, (current) =>
      // Re-check against the FRESH read too — the check above can be stale under a race (two
      // joins for the same golfer landing concurrently); addMember is a no-op copy here
      // rather than a second call that would hit its own duplicate-member guard.
      current.members.some((member) => member.golferId === account.golfer.id)
        ? current
        : addMember(current, { golferId: account.golfer.id, name: account.golfer.name, role: "member" }),
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode) };
  };
