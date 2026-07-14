import { addMember } from "@swng/domain";
import type { JoinCrewRequest, JoinCrewResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";

// POST /crews/join: adds the CALLER's own account golfer as a member (role "member") — the
// self-service counterpart to addCrewMember (an organizer adding an EXISTING account golfer by
// golferId; this one adds the caller themselves via a shared code). Neither mints a ghost
// anymore — Task 9's de-ghost made addCrewMember 409 ghost-not-addable on a golferId with no
// bound sub, so every crew member is a real account golfer.
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

    // joinCode never changes after minting (crewStore.ts's own doc comment) but crewStore.put
    // still requires it on every write — captured here from whichever read wins the retry race.
    let joinCode: string | undefined;
    const crew = await retryOnConflict(
      {
        get: async () => {
          const current = await deps.crewStore.get(crewId);
          if (!current) return undefined;
          joinCode = current.joinCode;
          return { value: current.crew, revision: current.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, joinCode!, revision),
      },
      (current) =>
        // Re-check against the FRESH read too — the check above can be stale under a race (two
        // joins for the same golfer landing concurrently); addMember is a no-op copy here
        // rather than a second call that would hit its own duplicate-member guard.
        current.members.some((member) => member.golferId === account.golfer.id)
          ? current
          : addMember(current, { golferId: account.golfer.id, name: account.golfer.name, role: "member" }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode!) };
  };
