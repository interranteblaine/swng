import { addMember, crewId as toCrewId } from "@swng/domain";
import type { Crew } from "@swng/domain";
import type { CreateCrewRequest, CreateCrewResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { toCrewView } from "./crewView.js";
import { requireAccountGolfer } from "./membership.js";

export const createCrew =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; ids: IdGenerator }) =>
  async (claims: AccountClaims, command: CreateCrewRequest): Promise<CreateCrewResponse> => {
    // golfer-required propagates if the caller has no account golfer yet (wire honesty, not
    // a flow — the web PUTs /me first).
    const golfer = await requireAccountGolfer(deps, claims);

    const id = toCrewId(deps.ids.newId());
    // Mints with the SAME machinery a round's own join code uses (IdGenerator.newJoinCode) —
    // the M8 plan's explicit mandate to reuse round's join-code minting.
    const joinCode = deps.ids.newJoinCode();
    const crew: Crew = addMember({ id, name: command.name, members: [] }, { golferId: golfer.id, name: golfer.name, role: "organizer" });

    // A fresh, server-minted crewId never collides with an existing item — same "nothing to
    // retry against" reasoning as createCourse's own unconditional put.
    await deps.crewStore.put(crew, joinCode, undefined);

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode) };
  };
