import { addMember, golferId as toGolferId } from "@swng/domain";
import type { CrewId } from "@swng/domain";
import type { AddCrewMemberRequest, AddCrewMemberResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";
import { requireCrewMember } from "./membership.js";

// Mints a STABLE ghost golfer for a person without an account (M8 plan) — a real GolferStore
// row, unclaimed, so it's claimable later AND so this same id recurs across every round this
// crew plays (a crew's "play the usual" one-tap seating always resolves this member to the
// SAME golferId, not a fresh one per round). Account holders never enter a crew this way —
// they join by code (joinCrewByCode.ts) as their own golfer.
export const addCrewMember =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; ids: IdGenerator }) =>
  async (claims: AccountClaims, id: CrewId, command: AddCrewMemberRequest): Promise<AddCrewMemberResponse> => {
    // Only a fellow crew member may add someone to the roster.
    await requireCrewMember(deps, claims, id);

    const ghostId = toGolferId(deps.ids.newId());
    // A fresh, server-minted golferId never collides with an existing item — unconditional
    // create, same reasoning as getOrCreateGolfer's own fresh-id put.
    await deps.golferStore.put({ id: ghostId, name: command.name, handicap: {} }, undefined);

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
      (current) => addMember(current, { golferId: ghostId, name: command.name, role: "member" }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: await toCrewView({ golferStore: deps.golferStore }, crew, joinCode!) };
  };
