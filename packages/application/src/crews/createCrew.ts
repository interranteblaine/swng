import { addMember, crewId as toCrewId, validateCrewName } from "@swng/domain";
import type { Crew } from "@swng/domain";
import type { CreateCrewRequest, CreateCrewResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { toCrewView } from "./crewView.js";
import { requireAccountGolfer } from "./membership.js";

// Crew membership (invited in, accountable out): the permanent join code createCrew used to
// mint here (M9 hardening's own bounded-retry `mintUniqueJoinCode`, `join-code-exhausted` on
// exhaustion) is GONE — getting in is by expiring HMAC invite link now (mintCrewInvite.ts),
// minted on demand by any member, never at creation time.
export const createCrew =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; ids: IdGenerator }) =>
  async (claims: AccountClaims, command: CreateCrewRequest): Promise<CreateCrewResponse> => {
    // golfer-required propagates if the caller has no account golfer yet (wire honesty, not
    // a flow — the web PUTs /me first).
    const golfer = await requireAccountGolfer(deps, claims);

    // M9 hardening (papercut 9): domain is the honest layer — the wire's own `.min(1)`
    // (contracts/crews.ts) never trims and has no upper bound; this is the real invariant,
    // checked before anything is minted or written (same "reject before touching state"
    // discipline as startRound.ts's own tee-set checks).
    validateCrewName(command.name);

    const id = toCrewId(deps.ids.newId());
    const crew: Crew = addMember({ id, name: command.name, members: [] }, { golferId: golfer.id, name: golfer.name, role: "organizer" });

    // A fresh, server-minted crewId never collides with an existing item — same "nothing to
    // retry against" reasoning as createCourse's own unconditional put.
    await deps.crewStore.put(crew, undefined);

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew) };
  };
